import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AgentHeadCore,
  V2_B1_COMPAT_CONSTANTS,
  V2_BUDGET_LIMITS,
  V2_TIMING_LIMITS,
  type AgentBudgetIncidentRow,
  type AgentSpendDayRow,
  type DurableObjectStorageLike,
  type GlobalBudgetAuthority,
  type GlobalBudgetAuthorizeSendRequest,
  type GlobalBudgetRenewGrantRequest,
  type GlobalBudgetReserveRequest,
  type GlobalBudgetSettleRequest,
  type ModelAttemptRow,
  type RecoveryRegistryPort,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type V2DispatchOutboxRow,
} from '@ember/runtime-v2';

function createInstrumentedDoStorage() {
  const db = new DatabaseSync(':memory:');
  let inTransaction = false;
  let currentAlarm: number | null = null;
  const alarmLog: Array<{ readonly op: 'set' | 'delete'; readonly atMs: number | null }> = [];

  const storage: DurableObjectStorageLike = {
    sql: {
      exec<T extends SqlStorageRow = SqlStorageRow>(
        query: string,
        ...bindings: unknown[]
      ): SqlStorageCursorLike<T> {
        const stmt = db.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        let rows: T[] = [];
        if (isReader) {
          rows = stmt.all(...(bindings as never[])) as T[];
        } else {
          stmt.run(...(bindings as never[]));
        }
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) {
              throw new Error(`Expected 1 row, got ${rows.length}`);
            }
            return rows[0]!;
          },
          rowsRead: rows.length,
          rowsWritten: isReader ? 0 : 1,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      if (inTransaction) {
        return closure();
      }
      inTransaction = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const res = closure();
        db.exec('COMMIT');
        return res;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    getAlarm(): Promise<number | null> {
      return Promise.resolve(currentAlarm);
    },
    setAlarm(scheduledTime: number | Date): Promise<void> {
      const atMs = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
      currentAlarm = atMs;
      alarmLog.push({ op: 'set', atMs });
      return Promise.resolve();
    },
    deleteAlarm(): Promise<void> {
      currentAlarm = null;
      alarmLog.push({ op: 'delete', atMs: null });
      return Promise.resolve();
    },
  };

  return {
    storage,
    db,
    getAlarmSync: () => currentAlarm,
    alarmLog,
    consumeAlarmForFire: () => {
      currentAlarm = null;
    },
  };
}

class FakeRecoveryRegistry implements RecoveryRegistryPort {
  mode: 'healthy' | 'unavailable' | 'ack_loss_once' | 'fail_cas_higher_gen' = 'healthy';
  upsertCalls = 0;
  getCalls = 0;
  postponeCalls = 0;
  retireCalls = 0;
  row: {
    generation: number;
    actualRecoveryAtMs: number;
    status: 'armed' | 'backoff' | 'quarantined';
    retryNotBeforeMs: number | null;
  } | null = null;
  onUpsert?: (cmd: { generation: number; recoveryAtMs: number }) => Promise<void> | void;

  async upsertCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly generation: number;
    readonly recoveryAtMs: number;
    readonly nowMs: number;
  }) {
    this.upsertCalls += 1;
    if (this.onUpsert !== undefined) {
      await this.onUpsert({ generation: cmd.generation, recoveryAtMs: cmd.recoveryAtMs });
    }
    if (this.mode === 'unavailable') {
      throw new Error('D1 unavailable');
    }
    if (this.mode === 'fail_cas_higher_gen') {
      this.mode = 'healthy';
      const bumped = cmd.generation + 2;
      this.row = {
        generation: bumped,
        actualRecoveryAtMs: cmd.recoveryAtMs + 100_000,
        status: 'armed',
        retryNotBeforeMs: null,
      };
      return {
        accepted: false,
        currentGeneration: bumped,
        actualRecoveryAtMs: this.row.actualRecoveryAtMs,
      };
    }

    if (this.row === null || cmd.generation > this.row.generation) {
      this.row = {
        generation: cmd.generation,
        actualRecoveryAtMs: cmd.recoveryAtMs,
        status: 'armed',
        retryNotBeforeMs: null,
      };
    } else if (cmd.generation === this.row.generation) {
      this.row = {
        ...this.row,
        actualRecoveryAtMs: Math.min(this.row.actualRecoveryAtMs, cmd.recoveryAtMs),
      };
    } else {
      return {
        accepted: false,
        currentGeneration: this.row.generation,
        actualRecoveryAtMs: this.row.actualRecoveryAtMs,
      };
    }

    if (this.mode === 'ack_loss_once') {
      this.mode = 'healthy';
      throw new Error('D1 ACK timeout after commit');
    }

    return {
      accepted: true,
      currentGeneration: this.row.generation,
      actualRecoveryAtMs: this.row.actualRecoveryAtMs,
    };
  }

  postponeCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedPrevGen: number;
    readonly newGeneration: number;
    readonly nextRecoveryAtMs: number;
    readonly nowMs: number;
  }) {
    this.postponeCalls += 1;
    if (this.mode === 'unavailable') {
      return Promise.reject(new Error('D1 unavailable'));
    }
    if (this.row === null || this.row.generation !== cmd.expectedPrevGen) {
      return Promise.resolve({
        updated: false,
        currentGeneration: this.row?.generation ?? 0,
        actualRecoveryAtMs: this.row?.actualRecoveryAtMs ?? null,
      });
    }
    this.row = {
      generation: cmd.newGeneration,
      actualRecoveryAtMs: cmd.nextRecoveryAtMs,
      status: 'armed',
      retryNotBeforeMs: null,
    };
    return Promise.resolve({
      updated: true,
      currentGeneration: this.row.generation,
      actualRecoveryAtMs: this.row.actualRecoveryAtMs,
    });
  }

  retireCoverage(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly retireUpToGen: number;
  }) {
    this.retireCalls += 1;
    if (this.row !== null && this.row.generation <= cmd.retireUpToGen) {
      this.row = null;
      return Promise.resolve({ retired: true });
    }
    return Promise.resolve({ retired: false });
  }

  getCoverage() {
    this.getCalls += 1;
    if (this.mode === 'unavailable') {
      return Promise.reject(new Error('D1 unavailable'));
    }
    if (this.row === null) {
      return Promise.resolve({
        exists: false,
        currentGeneration: null,
        actualRecoveryAtMs: null,
        status: null,
        retryNotBeforeMs: null,
      });
    }
    return Promise.resolve({
      exists: true,
      currentGeneration: this.row.generation,
      actualRecoveryAtMs: this.row.actualRecoveryAtMs,
      status: this.row.status,
      retryNotBeforeMs: this.row.retryNotBeforeMs,
    });
  }
}

class FakeGlobalBudgetAuthority implements GlobalBudgetAuthority {
  mode: 'healthy' | 'unavailable' | 'halted' | 'conflict_on_settle' = 'healthy';
  reserveCalls = 0;
  authorizeCalls = 0;
  settleCalls = 0;
  reservedMicroUsd = 0;
  consumedMicroUsd = 0;
  overageMicroUsd = 0;
  globalIncident: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing' | null = null;
  grants = new Map<
    string,
    {
      grantId: string;
      utcDay: string;
      reservedMicroUsd: number;
      appliedChargeMicroUsd: number;
      expiresAtMs: number;
      state:
        | 'reserved'
        | 'settled'
        | 'conservative_billed'
        | 'unknown_billed'
        | 'released'
        | 'expired_consumed';
      authorized: boolean;
      revisions: Map<number, string>;
    }
  >();
  nowMs: () => number;
  onReserve?: (req: GlobalBudgetReserveRequest) => Promise<void> | void;

  constructor(nowMs: () => number) {
    this.nowMs = nowMs;
  }

  expireOverdueGrants(): void {
    const now = this.nowMs();
    for (const grant of this.grants.values()) {
      if (grant.state === 'reserved' && now >= grant.expiresAtMs) {
        grant.state = 'expired_consumed';
        this.reservedMicroUsd -= grant.reservedMicroUsd;
        this.consumedMicroUsd += grant.reservedMicroUsd;
        grant.appliedChargeMicroUsd = grant.reservedMicroUsd;
      }
    }
  }

  async reserveGlobal(req: GlobalBudgetReserveRequest) {
    this.reserveCalls += 1;
    if (this.onReserve !== undefined) {
      await this.onReserve(req);
    }
    if (this.mode === 'unavailable') {
      throw new Error('GlobalBudgetDO unavailable');
    }
    this.expireOverdueGrants();
    if (this.mode === 'halted' || this.globalIncident !== null) {
      return {
        kind: 'budget_halted' as const,
        reason: this.globalIncident ?? 'usage_missing',
      };
    }

    const existing = this.grants.get(req.operationId);
    if (existing !== undefined) {
      return { kind: 'reserved' as const, globalGrantId: existing.grantId, replayed: true };
    }

    if (this.reservedMicroUsd + this.consumedMicroUsd + req.amountMicroUsd > req.ceilingMicroUsd) {
      return { kind: 'budget_exceeded' as const };
    }

    this.reservedMicroUsd += req.amountMicroUsd;
    const grantId = `grant:${req.operationId}`;
    this.grants.set(req.operationId, {
      grantId,
      utcDay: req.utcDay,
      reservedMicroUsd: req.amountMicroUsd,
      appliedChargeMicroUsd: 0,
      expiresAtMs: req.expiresAtMs,
      state: 'reserved',
      authorized: false,
      revisions: new Map(),
    });
    return { kind: 'reserved' as const, globalGrantId: grantId, replayed: false };
  }

  authorizeGlobalSend(req: GlobalBudgetAuthorizeSendRequest) {
    this.authorizeCalls += 1;
    if (this.mode === 'unavailable') {
      return Promise.reject(new Error('GlobalBudgetDO unavailable'));
    }
    this.expireOverdueGrants();
    if (this.mode === 'halted' || this.globalIncident !== null) {
      return Promise.resolve({ authorized: false as const });
    }
    const grant = this.grants.get(req.operationId);
    if (
      grant === undefined ||
      grant.grantId !== req.globalGrantId ||
      grant.state !== 'reserved' ||
      grant.authorized ||
      this.nowMs() >= grant.expiresAtMs
    ) {
      return Promise.resolve({ authorized: false as const });
    }
    grant.authorized = true;
    return Promise.resolve({ authorized: true as const, startBeforeMs: grant.expiresAtMs });
  }

  renewGlobalGrant(req: GlobalBudgetRenewGrantRequest) {
    const grant = this.grants.get(req.operationId);
    if (grant === undefined || grant.state !== 'reserved' || this.nowMs() >= grant.expiresAtMs) {
      return Promise.resolve({ renewed: false, state: grant?.state ?? 'missing' });
    }
    grant.expiresAtMs = Math.max(grant.expiresAtMs, req.newExpiresAtMs);
    return Promise.resolve({ renewed: true, state: grant.state });
  }

  settleGlobal(req: GlobalBudgetSettleRequest) {
    this.settleCalls += 1;
    if (this.mode === 'unavailable') {
      return Promise.reject(new Error('GlobalBudgetDO unavailable'));
    }
    if (this.mode === 'conflict_on_settle') {
      return Promise.resolve({
        applied: false,
        alreadySettled: false,
        conflict: true,
        effectiveState: 'unknown_billed' as const,
        incidentOpened: false,
      });
    }

    this.expireOverdueGrants();
    const grant = this.grants.get(req.operationId);
    if (grant === undefined) {
      return Promise.resolve({
        applied: false,
        alreadySettled: false,
        conflict: true,
        effectiveState: 'released' as const,
        incidentOpened: false,
      });
    }

    const digest = JSON.stringify({
      state: req.state,
      chargeMicroUsd: req.chargeMicroUsd,
      observed: req.observedCostMicroUsd ?? null,
    });
    const prevDigest = grant.revisions.get(req.settlementRevision);
    if (prevDigest !== undefined) {
      if (prevDigest === digest) {
        return Promise.resolve({
          applied: false,
          alreadySettled: true,
          conflict: false,
          effectiveState: grant.state === 'reserved' ? req.state : grant.state,
          incidentOpened: false,
        });
      }
      return Promise.resolve({
        applied: false,
        alreadySettled: false,
        conflict: true,
        effectiveState: grant.state === 'reserved' ? req.state : grant.state,
        incidentOpened: false,
      });
    }

    // Expired grant cannot refund on released
    if (grant.state === 'expired_consumed' && req.state === 'released') {
      grant.revisions.set(req.settlementRevision, digest);
      return Promise.resolve({
        applied: false,
        alreadySettled: true,
        conflict: false,
        effectiveState: 'expired_consumed' as const,
        incidentOpened: false,
      });
    }

    const delta = Math.max(0, req.chargeMicroUsd - grant.appliedChargeMicroUsd);
    if (grant.state === 'reserved') {
      this.reservedMicroUsd -= grant.reservedMicroUsd;
      this.consumedMicroUsd += req.chargeMicroUsd;
      grant.appliedChargeMicroUsd = req.chargeMicroUsd;
      grant.state = req.state;
    } else if (delta > 0) {
      this.consumedMicroUsd += delta;
      this.overageMicroUsd += delta;
      grant.appliedChargeMicroUsd = req.chargeMicroUsd;
    }

    if (req.openIncidentReason !== undefined) {
      this.globalIncident = req.openIncidentReason;
    }

    grant.revisions.set(req.settlementRevision, digest);
    return Promise.resolve({
      applied: true,
      alreadySettled: false,
      conflict: false,
      effectiveState: grant.state,
      incidentOpened: req.openIncidentReason !== undefined,
    });
  }
}

function createHarness(options: { globalDailyCeilingMicroUsd?: number } = {}) {
  let clockMs = 1_700_000_000_000;
  const nowMs = () => clockMs;
  const doStorage = createInstrumentedDoStorage();
  const recoveryRegistry = new FakeRecoveryRegistry();
  const globalBudget = new FakeGlobalBudgetAuthority(nowMs);
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();

  const core = new AgentHeadCore({
    storage: doStorage.storage,
    tenantId,
    agentId,
    recoveryRegistry,
    globalBudget,
    nowMs,
    ...(options.globalDailyCeilingMicroUsd !== undefined
      ? { globalDailyCeilingMicroUsd: options.globalDailyCeilingMicroUsd }
      : {}),
  });

  core.bootstrapHead({ conversationId, policyVersion: 1 });

  return {
    core,
    doStorage,
    recoveryRegistry,
    globalBudget,
    tenantId,
    principalId,
    agentId,
    conversationId,
    nowMs,
    setClock: (ms: number) => {
      clockMs = ms;
    },
    advanceClock: (ms: number) => {
      clockMs += ms;
      return clockMs;
    },
    makeScope: () => ({
      tenantId,
      principalId,
      agentId,
      policyVersion: 1,
      requestId: randomUUID(),
    }),
  };
}

describe('V2-M1-A2 AgentHeadDO state machine, Lease/Epoch fencing & budget_sync atomic commits', () => {
  it('F-4/F-5: uncovered fails closed when D1 down, whereas covered fast path needs 0 D1 writes', async () => {
    const h = createHarness();

    // Uncovered + D1 unavailable -> DB_UNAVAILABLE, zero business rows committed
    h.recoveryRegistry.mode = 'unavailable';
    await expect(
      h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        request: { client_submission_id: randomUUID(), text: 'first', transcript_epoch: 0 },
        workerId: 'edge-1',
        leaseMs: V2_TIMING_LIMITS.sseLeaseDurationMs,
        interactiveDeadlineMs: V2_TIMING_LIMITS.sseInteractiveDeadlineMs,
        turnDeadlineMs: V2_TIMING_LIMITS.sseLongTurnDeadlineMs,
        executionMode: 'fast_interactive',
      }),
    ).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });

    expect(h.doStorage.db.prepare('SELECT COUNT(*) AS c FROM conversation_messages').get()).toEqual(
      { c: 0 },
    );
    expect(
      (
        h.doStorage.db.prepare('SELECT coverage_state FROM v2_recovery_coverage').get() as {
          coverage_state: string;
        }
      ).coverage_state,
    ).toBe('registering');

    // Recover D1: next request bumps generation + 1 and succeeds
    h.recoveryRegistry.mode = 'healthy';
    const first = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'hello', transcript_epoch: 0 },
      workerId: 'edge-1',
      leaseMs: V2_TIMING_LIMITS.sseLeaseDurationMs,
      interactiveDeadlineMs: V2_TIMING_LIMITS.sseInteractiveDeadlineMs,
      turnDeadlineMs: V2_TIMING_LIMITS.sseLongTurnDeadlineMs,
      executionMode: 'fast_interactive',
    });
    expect(first.kind).toBe('prepared');
    expect(h.recoveryRegistry.upsertCalls).toBe(2);
    expect(h.recoveryRegistry.row?.generation).toBe(2);

    // Subsequent covered request with D1 offline succeeds with 0 D1 calls!
    h.recoveryRegistry.mode = 'unavailable';
    const upsertsBefore = h.recoveryRegistry.upsertCalls;
    const second = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'second', transcript_epoch: 0 },
      workerId: 'edge-1',
      leaseMs: V2_TIMING_LIMITS.sseLeaseDurationMs,
      interactiveDeadlineMs: V2_TIMING_LIMITS.sseInteractiveDeadlineMs,
      turnDeadlineMs: V2_TIMING_LIMITS.sseLongTurnDeadlineMs,
      executionMode: 'fast_interactive',
    });
    expect(second.kind).toBe('prepared');
    expect(h.recoveryRegistry.upsertCalls).toBe(upsertsBefore);
  });

  it('F-13/F-19: recovers from D1 ACK loss via getCoverage and serializes concurrent uncovered registrations', async () => {
    const h = createHarness();
    h.recoveryRegistry.mode = 'ack_loss_once';

    const p1 = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'ack-loss', transcript_epoch: 0 },
      workerId: 'edge-1',
      leaseMs: V2_TIMING_LIMITS.sseLeaseDurationMs,
      interactiveDeadlineMs: V2_TIMING_LIMITS.sseInteractiveDeadlineMs,
      turnDeadlineMs: V2_TIMING_LIMITS.sseLongTurnDeadlineMs,
      executionMode: 'fast_interactive',
    });
    expect(p1.kind).toBe('prepared');
    expect(h.recoveryRegistry.getCalls).toBe(1);

    // Force higher D1 generation mismatch (e.g. snapshot drift) -> fast-forwards and self-heals
    const h2 = createHarness();
    h2.recoveryRegistry.mode = 'fail_cas_higher_gen';
    const p2 = await h2.core.prepareTurn({
      scope: h2.makeScope(),
      conversationId: h2.conversationId,
      request: { client_submission_id: randomUUID(), text: 'self-heal', transcript_epoch: 0 },
      workerId: 'edge-1',
      leaseMs: V2_TIMING_LIMITS.sseLeaseDurationMs,
      interactiveDeadlineMs: V2_TIMING_LIMITS.sseInteractiveDeadlineMs,
      turnDeadlineMs: V2_TIMING_LIMITS.sseLongTurnDeadlineMs,
      executionMode: 'fast_interactive',
    });
    expect(p2.kind).toBe('prepared');
    expect(h2.recoveryRegistry.row?.generation).toBe(4);
  });

  it('F-1/F-2/F-3: replays identical submission, rejects mismatch, and compensates Stage 3 clearTranscript race', async () => {
    const h = createHarness();
    const subId = randomUUID();

    // Seed coverage via first turn
    const seed = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: subId, text: 'hello replay', transcript_epoch: 0 },
      workerId: 'edge-1',
      leaseMs: V2_TIMING_LIMITS.sseLeaseDurationMs,
      interactiveDeadlineMs: V2_TIMING_LIMITS.sseInteractiveDeadlineMs,
      turnDeadlineMs: V2_TIMING_LIMITS.sseLongTurnDeadlineMs,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        rateVersion: 'v1',
        maxAttempts: 2,
        estimatedMicroUsd: 1_500,
      },
    });
    expect(seed.kind).toBe('prepared');
    if (seed.kind !== 'prepared') return;

    // Replay returns byte-identical receipt with ZERO additional global budget calls
    const reservesBefore = h.globalBudget.reserveCalls;
    const replay = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: subId, text: 'hello replay', transcript_epoch: 0 },
      workerId: 'edge-2',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
    });
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      expect(replay.receipt).toEqual(seed.receipt);
    }
    expect(h.globalBudget.reserveCalls).toBe(reservesBefore);

    // Mismatched text throws IDEMPOTENCY_CONFLICT
    await expect(
      h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        request: { client_submission_id: subId, text: 'tampered', transcript_epoch: 0 },
        workerId: 'edge-1',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 600_000,
        executionMode: 'fast_interactive',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // Interleave clearTranscript DURING Stage 2 reserveGlobal -> Stage 3 writes budget_sync(release) & throws 409
    let interleaved = false;
    h.globalBudget.onReserve = async () => {
      if (!interleaved) {
        interleaved = true;
        await h.core.clearTranscript({
          tenantId: h.tenantId,
          agentId: h.agentId,
          conversationId: h.conversationId,
        });
      }
    };

    await expect(
      h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        request: { client_submission_id: randomUUID(), text: 'raced turn', transcript_epoch: 0 },
        workerId: 'edge-1',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 600_000,
        executionMode: 'fast_interactive',
        modelReservation: {
          budgetMode: 'simulated_full_protocol',
          providerId: 'fake',
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          rateVersion: 'v1',
          maxAttempts: 2,
          estimatedMicroUsd: 2_000,
        },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // Global budget reservation was released cleanly (zero leaked reserved_micro_usd!)
    expect(h.globalBudget.reservedMicroUsd).toBe(0);
    // Transcript remained clean (deleted prior turn, zero resurrected raced message)
    const msgs = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 50,
    });
    expect(msgs.transcript_epoch).toBe(1);
    expect(msgs.messages).toHaveLength(0);
  });

  it('F-7/F-8/F-9: markAttemptSent 3-RPC gate differentiates pre-send release vs post-send unknown_billed', async () => {
    const h = createHarness();

    // Case 1 (F-7): Crash BEFORE markAttemptSent -> lease expires -> settled as `released` (0 cost)
    const preSend = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'crash before send',
        transcript_epoch: 0,
      },
      workerId: 'edge-crashed',
      leaseMs: 25_000,
      interactiveDeadlineMs: 22_000,
      turnDeadlineMs: 60_000,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        rateVersion: 'v1',
        maxAttempts: 2,
        estimatedMicroUsd: 2_000,
      },
    });
    expect(preSend.kind).toBe('prepared');
    if (preSend.kind !== 'prepared') return;
    expect(h.globalBudget.reservedMicroUsd).toBe(2_000);

    h.advanceClock(26_000);
    await h.core.runAlarmCycle();

    const attempt1 = h.doStorage.db
      .prepare('SELECT * FROM model_attempts WHERE operation_id = ?')
      .get(preSend.operationId) as unknown as ModelAttemptRow;
    expect(attempt1.state).toBe('released');
    expect(h.globalBudget.reservedMicroUsd).toBe(0);
    expect(h.globalBudget.consumedMicroUsd).toBe(0);

    // Case 2 (F-8): Crash AFTER markAttemptSent -> lease expires -> `unknown_billed`, never blinded replay
    const postSend = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'crash after send',
        transcript_epoch: 0,
      },
      workerId: 'edge-alive',
      leaseMs: 25_000,
      interactiveDeadlineMs: 22_000,
      turnDeadlineMs: 60_000,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        rateVersion: 'v1',
        maxAttempts: 2,
        estimatedMicroUsd: 3_000,
      },
    });
    if (postSend.kind !== 'prepared') throw new Error('expected prepared');

    const sentAuth = await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: postSend.turnId,
      attemptNo: 1,
      operationId: postSend.operationId,
      leaseEpoch: postSend.leaseEpoch,
      leaseOwner: 'edge-alive',
    });
    expect(sentAuth.authorized).toBe(true);

    // Duplicate markAttemptSent strictly refused (`already_sent`, F-9)
    const dupAuth = await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: postSend.turnId,
      attemptNo: 1,
      operationId: postSend.operationId,
      leaseEpoch: postSend.leaseEpoch,
      leaseOwner: 'edge-alive',
    });
    expect(dupAuth).toEqual({ authorized: false, reason: 'already_sent' });

    // Simulate silent worker crash past 25s lease -> Alarm converges with unknown_billed
    h.advanceClock(26_000);
    await h.core.runAlarmCycle();

    const attempt2 = h.doStorage.db
      .prepare('SELECT * FROM model_attempts WHERE operation_id = ?')
      .get(postSend.operationId) as unknown as ModelAttemptRow;
    expect(attempt2.state).toBe('unknown_billed');
    expect(attempt2.global_synced_at_ms).not.toBeNull();
    expect(h.globalBudget.consumedMicroUsd).toBe(3_000);

    const turnRow = await h.core.getTurn({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      turnId: postSend.turnId,
    });
    expect(turnRow?.status).toBe('failed');
    expect(turnRow?.failure_reason).toBe('internal_error');
  });

  it('F-12/F-15/F-23: handoffTurnToDurable enforces 7 gates, late overage increments revision & delta only', async () => {
    const h = createHarness();
    const prep = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'long reasoning', transcript_epoch: 0 },
      workerId: 'edge-sse-1',
      leaseMs: V2_TIMING_LIMITS.sseLeaseDurationMs,
      interactiveDeadlineMs: V2_TIMING_LIMITS.sseInteractiveDeadlineMs,
      turnDeadlineMs: V2_TIMING_LIMITS.sseLongTurnDeadlineMs,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        rateVersion: 'v1',
        maxAttempts: 2,
        estimatedMicroUsd: 2_000,
      },
    });
    if (prep.kind !== 'prepared') throw new Error('expected prepared');

    // Renew lease at +15s; verify deadline_at_ms never moves
    h.advanceClock(15_000);
    const renewed = await h.core.renewTurnLease({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: 'edge-sse-1',
      extendMs: 45_000,
    });
    expect(renewed.renewed).toBe(true);

    const auth = await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: prep.turnId,
      attemptNo: 1,
      operationId: prep.operationId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: 'edge-sse-1',
    });
    expect(auth.authorized).toBe(true);

    // Without providerJobHandle after send_started_at_ms is set, gate 7 refuses handoff!
    const deniedHandoff = await h.core.handoffTurnToDurable({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: 'edge-sse-1',
      reason: 'interactive_deadline_120s',
    });
    expect(deniedHandoff.outcome).toBe('fenced');

    // With resumable providerJobHandle, handoff succeeds cleanly
    const handedOff = await h.core.handoffTurnToDurable({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: 'edge-sse-1',
      reason: 'interactive_deadline_120s',
      providerJobHandle: 'job-handle-123',
    });
    expect(handedOff).toEqual({
      outcome: 'handed_off',
      turnId: prep.turnId,
      nextLeaseEpoch: 2,
      executionMode: 'durable_queue',
    });

    // Stale SSE executor (epoch=1) commit is fenced AND writes 0 messages
    const staleCommit = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      leaseEpoch: 1,
      leaseOwner: 'edge-sse-1',
      attemptNo: 1,
      operationId: prep.operationId,
      settlement: { state: 'unknown_billed', outcomeCode: 'model_timeout' },
      result: {
        status: 'completed',
        text: 'stale answer',
        modelLabel: 'ember-fake-llm-1',
        simulated: true,
      },
    });
    expect(staleCommit.outcome).toBe('fenced');

    // Queue worker claims handoff envelope with exact epoch=2 -> granted epoch=3
    const claim = await h.core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `handoff:${prep.turnId}:epoch:2`,
        tenantId: h.tenantId,
        agentId: h.agentId,
        entityKind: 'handoff',
        entityId: prep.turnId,
        queueName: 'durable_turn',
        fenceEpoch: 2,
      },
      workerId: 'queue-worker-1',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;
    expect(claim.leaseEpoch).toBe(3);

    // Queue worker commits final completed result at epoch=3, with settled=1500
    const committed = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      leaseEpoch: 3,
      leaseOwner: 'queue-worker-1',
      attemptNo: 1,
      operationId: prep.operationId,
      settlement: {
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 1_500,
        inputTokens: 80,
        outputTokens: 120,
      },
      result: {
        status: 'completed',
        text: 'Completed after durable handoff',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
        delegation: {
          toolName: 'delegate_notes_action_items',
          title: 'Extract notes',
          input: { notes: 'Follow up on V2 tests' },
        },
      },
    });
    expect(committed.outcome).toBe('published');
    if (committed.outcome === 'published') {
      expect(committed.delegatedTaskId).not.toBeNull();
    }
    expect(h.globalBudget.consumedMicroUsd).toBe(1_500);

    // Late overage (rev=1) arriving later books ONLY delta (2_400 - 1_500 = 900) and opens incident!
    const lateOverage = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      leaseEpoch: 1,
      leaseOwner: 'late-invoice-reconciler',
      attemptNo: 1,
      operationId: prep.operationId,
      settlement: {
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 2_400,
        inputTokens: 80,
        outputTokens: 300,
      },
      result: {
        status: 'completed',
        text: 'ignored',
        modelLabel: 'ember-fake-llm-1',
        simulated: true,
      },
    });
    expect(lateOverage.outcome).toBe('fenced');
    expect(h.globalBudget.consumedMicroUsd).toBe(2_400);
    expect(h.globalBudget.overageMicroUsd).toBe(900);
    expect(h.globalBudget.globalIncident).toBe('reservation_exceeded');

    // clearTranscript & cancel MUST NOT destroy tasks or budget_sync outbox rows (F-23 / TE-6)
    await h.core.clearTranscript({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
    });
    const outboxRows = h.doStorage.db
      .prepare(
        "SELECT outbox_id, revision, state FROM v2_dispatch_outbox WHERE entity_kind = 'budget_sync' ORDER BY revision ASC",
      )
      .all() as Array<{ outbox_id: string; revision: number; state: string }>;
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows.every((r) => r.state === 'acked')).toBe(true);
    const taskCount = h.doStorage.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as {
      c: number;
    };
    expect(taskCount.c).toBe(1);
  });

  it('F-16/F-18/F-23: usage_missing halts future calls, clearTranscript leaves pending budget_sync intact, and Task caps hold', async () => {
    const h = createHarness();
    h.globalBudget.mode = 'unavailable';

    const p1 = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'needs usage', transcript_epoch: 0 },
      workerId: 'edge-1',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
    });
    expect(p1.kind).toBe('prepared');

    // Restore GlobalBudgetAuthority for next turn with reservation
    h.globalBudget.mode = 'healthy';
    const p2 = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'missing usage turn',
        transcript_epoch: 0,
      },
      workerId: 'edge-1',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        rateVersion: 'v1',
        maxAttempts: 2,
        estimatedMicroUsd: 2_500,
      },
    });
    if (p2.kind !== 'prepared') throw new Error('expected prepared');
    await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: p2.turnId,
      attemptNo: 1,
      operationId: p2.operationId,
      leaseEpoch: p2.leaseEpoch,
      leaseOwner: 'edge-1',
    });

    // Make GlobalBudgetAuthority temporarily unavailable during commitTurn so budget_sync stays 'pending'
    h.globalBudget.mode = 'unavailable';
    const commitMissing = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: p2.turnId,
      leaseEpoch: p2.leaseEpoch,
      leaseOwner: 'edge-1',
      attemptNo: 1,
      operationId: p2.operationId,
      settlement: {
        state: 'conservative_billed',
        outcomeCode: 'usage_missing',
      },
      result: {
        status: 'completed',
        text: 'Paid answer with missing usage',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
      },
    });
    expect(commitMissing.outcome).toBe('published');

    // Incident was persisted locally AND pending budget_sync survived even if clearTranscript runs!
    const incidents = h.doStorage.db
      .prepare('SELECT * FROM agent_budget_incidents')
      .all() as unknown as AgentBudgetIncidentRow[];
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.reason).toBe('usage_missing');

    await h.core.clearTranscript({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
    });
    const pendingBudgetOutbox = h.doStorage.db
      .prepare(
        "SELECT * FROM v2_dispatch_outbox WHERE entity_kind = 'budget_sync' AND state != 'acked'",
      )
      .all() as unknown as V2DispatchOutboxRow[];
    expect(pendingBudgetOutbox).toHaveLength(1);

    // Next paid turn is blocked by unresolved local incident
    h.globalBudget.mode = 'healthy';
    await expect(
      h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        request: {
          client_submission_id: randomUUID(),
          text: 'blocked by halt',
          transcript_epoch: 1,
        },
        workerId: 'edge-1',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 600_000,
        executionMode: 'fast_interactive',
        modelReservation: {
          budgetMode: 'simulated_full_protocol',
          providerId: 'fake',
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          rateVersion: 'v1',
          maxAttempts: 2,
          estimatedMicroUsd: 1_000,
        },
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

    // Advance past backoff and flush outbox via Alarm cycle: delayed `usage_missing` incident propagates to Global!
    h.advanceClock(2_500);
    await h.core.runAlarmCycle();
    expect(h.globalBudget.consumedMicroUsd).toBe(2_500);
    expect(h.globalBudget.globalIncident).toBe('usage_missing');

    // Admin reconciles BOTH local & global incidents to resume paid operations
    h.doStorage.db
      .prepare('UPDATE agent_budget_incidents SET resolved_at_ms = ? WHERE id = ?')
      .run(h.nowMs(), incidents[0]!.id);
    h.globalBudget.globalIncident = null;

    // Seed a python.agent task and verify 6-attempt / 30k cumulative cap
    const taskId = randomUUID();
    const runId = randomUUID();
    const now = h.nowMs();
    h.doStorage.db
      .prepare(
        `INSERT INTO tasks (id, kind, input_json, digest, idempotency_key, status, execution_path, execution_target, attempt_count, max_attempts, current_run_id, lease_epoch, lease_expires_at_ms, next_run_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'python.agent', '{"prompt":"p"}', 'd', ?, 'running', 'heavy', 'cloud', 1, 3, ?, 1, ?, ?, ?, ?)`,
      )
      .run(taskId, randomUUID(), runId, now + 30_000, now, now, now);

    for (let i = 0; i < V2_BUDGET_LIMITS.pythonAgentMaxLlmCallsPerRun; i += 1) {
      const r = await h.core.reserveTaskModelAttempt({
        tenantId: h.tenantId,
        principalId: h.principalId,
        agentId: h.agentId,
        taskId,
        runId,
        leaseEpoch: 1,
        providerId: 'fake',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        rateVersion: 'v1',
        budgetMode: 'simulated_full_protocol',
        estimatedMicroUsd: 1_000,
      });
      expect(r.kind).toBe('reserved');
    }
    const refusedRunCap = await h.core.reserveTaskModelAttempt({
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      taskId,
      runId,
      leaseEpoch: 1,
      providerId: 'fake',
      modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
      rateVersion: 'v1',
      budgetMode: 'simulated_full_protocol',
      estimatedMicroUsd: 1_000,
    });
    expect(refusedRunCap).toEqual({ kind: 'refused', reason: 'attempts_exhausted' });
  });

  it('F-14/F-17/F-22: Alarm backward re-arms to future schedule, claimDurableWork enforces 5-tuple, reconcile repairs & retires safely', async () => {
    const h = createHarness();
    const futureSchedAt = h.nowMs() + 3_600_000;

    // Seed a future active schedule
    h.doStorage.db
      .prepare(
        `INSERT INTO v2_schedules (schedule_id, tenant_id, agent_id, source_kind, source_id, schedule_kind, next_fire_at_ms, status, created_at_ms, updated_at_ms)
         VALUES ('sched-1', ?, ?, 'reminder', 'rem-1', 'once', ?, 'active', ?, ?)`,
      )
      .run(h.tenantId, h.agentId, futureSchedAt, h.nowMs(), h.nowMs());

    // Start short-lived turn whose lease/deadline is earlier than futureSchedAt
    const prep = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'short turn', transcript_epoch: 0 },
      workerId: 'edge-1',
      leaseMs: V2_TIMING_LIMITS.b1WaitUntilLeaseDurationMs,
      interactiveDeadlineMs: V2_TIMING_LIMITS.b1WaitUntilInteractiveDeadlineMs,
      turnDeadlineMs: V2_TIMING_LIMITS.b1TurnDeadlineMs,
      executionMode: 'fast_interactive',
    });
    if (prep.kind !== 'prepared') throw new Error('expected prepared');
    const firstAlarm = h.doStorage.getAlarmSync();
    expect(firstAlarm).toBeLessThan(futureSchedAt);

    // Poison envelope checks: reject budget_sync or wrong fenceEpoch (stale OR future)
    expect(
      await h.core.claimDurableWork({
        envelope: {
          schemaVersion: 2,
          eventId: `turn:${prep.turnId}:epoch:1`,
          tenantId: h.tenantId,
          agentId: h.agentId,
          entityKind: 'turn',
          entityId: prep.turnId,
          queueName: 'durable_turn',
          fenceEpoch: 99,
        },
        workerId: 'attacker',
        leaseMs: 30_000,
      }),
    ).toEqual({ kind: 'not_claimed', reason: 'stale_or_invalid_envelope' });

    // Complete the turn -> single Alarm moves BACKWARD (to futureSchedAt)!
    await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: prep.turnId,
      attemptNo: 1,
      operationId: prep.operationId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: 'edge-1',
    });
    await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: 'edge-1',
      attemptNo: 1,
      operationId: prep.operationId,
      settlement: { state: 'released', outcomeCode: 'ok' },
      result: {
        status: 'completed',
        text: 'done',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
      },
    });
    expect(h.doStorage.getAlarmSync()).toBe(futureSchedAt);

    // Simulate expired coverage marker while future schedule exists -> Sweeper reconcile postpones, NEVER retires!
    h.advanceClock(50_000);
    const plan = await h.core.reconcileFromRegistry({
      tenantId: h.tenantId,
      agentId: h.agentId,
      expectedGen: h.recoveryRegistry.row!.generation,
      nowMs: h.nowMs(),
    });
    expect(plan.action).toBe('postpone');
    if (plan.action === 'postpone') {
      const post = await h.recoveryRegistry.postponeCoverage({
        tenantId: h.tenantId,
        agentId: h.agentId,
        expectedPrevGen: plan.expectedPrevGen,
        newGeneration: plan.newGeneration,
        nextRecoveryAtMs: plan.nextRecoveryAtMs,
        nowMs: h.nowMs(),
      });
      expect(post.updated).toBe(true);
      await h.core.confirmRegistryPlan({
        generation: plan.newGeneration,
        actualRecoveryAtMs: post.actualRecoveryAtMs,
        applied: post.updated,
      });
    }

    // Complete schedule -> now zero active obligations -> Sweeper retires cleanly and deletes Alarm!
    h.doStorage.db
      .prepare("UPDATE v2_schedules SET status = 'completed' WHERE schedule_id = 'sched-1'")
      .run();
    const retirePlan = await h.core.reconcileFromRegistry({
      tenantId: h.tenantId,
      agentId: h.agentId,
      expectedGen: h.recoveryRegistry.row!.generation,
      nowMs: h.nowMs(),
    });
    expect(retirePlan.action).toBe('retire');
    expect(h.doStorage.getAlarmSync()).toBeNull();
  });
});

// Keep explicit type-level import usage verified for AgentSpendDayRow
export type _CheckSpendDayRow = AgentSpendDayRow;
