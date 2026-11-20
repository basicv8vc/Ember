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
  type BudgetSyncOutboxPayload,
  type DurableObjectStorageLike,
  type EventRuntimeCoordinatorPort,
  type GlobalBudgetAuthority,
  type GlobalBudgetAuthorizeSendRequest,
  type GlobalBudgetRenewGrantRequest,
  type GlobalBudgetReserveRequest,
  type GlobalBudgetSettleRequest,
  type ModelAttemptRow,
  type RecoveryAdmissionPort,
  type RecoveryRegistryPort,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type TurnRecoverySeamHooks,
  type V2DispatchOutboxRow,
  type V2RecoveryCoverageRow,
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

function createTestBRuntimeSeam(deps: {
  doStorage: ReturnType<typeof createInstrumentedDoStorage>;
  tenantId: string;
  agentId: string;
  nowMs: () => number;
  getCore: () => Pick<
    AgentHeadCore,
    | 'earliestRequiredDiscoveryAtMsSync'
    | 'listDueBusinessActionsSync'
    | 'convergeDueBusinessItemSync'
    | 'createGlobalBudgetSettlePort'
  >;
}) {
  const { doStorage, tenantId, agentId, nowMs, getCore } = deps;
  const sql = doStorage.storage.sql;

  const ensureCoverageRowSync = (tsNow: number): V2RecoveryCoverageRow => {
    const existing = sql
      .exec<V2RecoveryCoverageRow & SqlStorageRow>(
        'SELECT * FROM v2_recovery_coverage WHERE id = 1',
      )
      .toArray()[0];
    if (existing !== undefined) {
      return existing;
    }
    sql.exec(
      `INSERT INTO v2_recovery_coverage (
         id, tenant_id, agent_id, generation, coverage_state,
         covered_recovery_at_ms, pending_kind, pending_prev_generation,
         pending_target_at_ms, armed_alarm_at_ms, alarm_fail_count,
         last_d1_sync_at_ms, updated_at_ms
       ) VALUES (1, ?, ?, 0, 'uncovered', NULL, NULL, NULL, NULL, NULL, 0, NULL, ?)`,
      tenantId,
      agentId,
      tsNow,
    );
    return sql
      .exec<V2RecoveryCoverageRow & SqlStorageRow>(
        'SELECT * FROM v2_recovery_coverage WHERE id = 1',
      )
      .one();
  };

  const getCoverageRowSync = (): V2RecoveryCoverageRow | null => {
    const rows = sql
      .exec<V2RecoveryCoverageRow & SqlStorageRow>(
        'SELECT * FROM v2_recovery_coverage WHERE id = 1',
      )
      .toArray();
    return rows[0] ?? null;
  };

  const getOutboxByIdSync = (outboxId: string): V2DispatchOutboxRow | null => {
    const rows = sql
      .exec<V2DispatchOutboxRow & SqlStorageRow>(
        'SELECT * FROM v2_dispatch_outbox WHERE outbox_id = ?',
        outboxId,
      )
      .toArray();
    return rows[0] ?? null;
  };

  const recoveryAdmission: RecoveryAdmissionPort = {
    inspectCoverageSync(requiredRecoveryAtMs, tsNow) {
      const row = ensureCoverageRowSync(tsNow);
      if (
        row.coverage_state === 'covered' &&
        row.covered_recovery_at_ms !== null &&
        row.covered_recovery_at_ms <= requiredRecoveryAtMs
      ) {
        return {
          kind: 'covered',
          generation: row.generation,
          coveredRecoveryAtMs: row.covered_recovery_at_ms,
        };
      }
      const nextGen = row.generation + 1;
      const targetAtMs =
        row.covered_recovery_at_ms !== null
          ? Math.min(requiredRecoveryAtMs, row.covered_recovery_at_ms)
          : requiredRecoveryAtMs;
      const prevGen = row.generation;
      const nextState = row.coverage_state === 'covered' ? 'covered' : 'registering';
      sql.exec(
        `UPDATE v2_recovery_coverage
            SET generation = ?,
                coverage_state = ?,
                pending_kind = 'ensure',
                pending_prev_generation = ?,
                pending_target_at_ms = ?,
                updated_at_ms = ?
          WHERE id = 1`,
        nextGen,
        nextState,
        prevGen,
        targetAtMs,
        tsNow,
      );
      return { kind: 'register', generation: nextGen, targetAtMs };
    },

    confirmCoverageSync(cmd) {
      const row = getCoverageRowSync();
      if (
        row === null ||
        row.generation !== cmd.generation ||
        !cmd.applied ||
        cmd.actualRecoveryAtMs === null ||
        cmd.actualRecoveryAtMs > cmd.earliestRequiredRecoveryMs
      ) {
        return false;
      }
      sql.exec(
        `UPDATE v2_recovery_coverage
            SET coverage_state = 'covered',
                covered_recovery_at_ms = ?,
                pending_kind = NULL,
                pending_prev_generation = NULL,
                pending_target_at_ms = NULL,
                last_d1_sync_at_ms = ?,
                updated_at_ms = ?
          WHERE id = 1`,
        cmd.actualRecoveryAtMs,
        cmd.nowMs,
        cmd.nowMs,
      );
      return true;
    },
  };

  const eventCoordinator: EventRuntimeCoordinatorPort = {
    enqueueDurableOutboxSync(cmd) {
      const ts = nowMs();
      sql.exec(
        `INSERT INTO v2_dispatch_outbox (
           outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id,
           revision, state, next_attempt_at_ms, publish_attempts, dlq_count, fence_epoch,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?, ?)
         ON CONFLICT(outbox_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           state = 'pending',
           next_attempt_at_ms = excluded.next_attempt_at_ms,
           fence_epoch = excluded.fence_epoch,
           updated_at_ms = excluded.updated_at_ms`,
        cmd.outboxId,
        cmd.entityKind,
        cmd.entityId,
        cmd.queueName,
        cmd.payloadJson,
        cmd.operationId ?? null,
        cmd.revision ?? 0,
        cmd.nextAttemptAtMs,
        cmd.fenceEpoch,
        ts,
        ts,
      );
    },

    cancelEntityOutboxSync(entityKind, entityId, tsNow) {
      sql.exec(
        `UPDATE v2_dispatch_outbox
            SET state = 'cancelled',
                updated_at_ms = ?
          WHERE entity_kind = ? AND entity_id = ? AND state IN ('pending', 'enqueued')`,
        tsNow,
        entityKind,
        entityId,
      );
    },

    ackOutboxSync(outboxId, fenceEpoch, tsNow) {
      sql.exec(
        `UPDATE v2_dispatch_outbox
            SET state = 'acked',
                updated_at_ms = ?
          WHERE outbox_id = ? AND fence_epoch <= ? AND state IN ('pending', 'enqueued')`,
        tsNow,
        outboxId,
        fenceEpoch,
      );
    },

    applyOutboxDeadLetterSync(cmd) {
      sql.exec(
        `UPDATE v2_dispatch_outbox
            SET state = 'dead_lettered',
                dlq_count = dlq_count + 1,
                last_error_code = ?,
                next_attempt_at_ms = ?,
                updated_at_ms = ?
          WHERE outbox_id = ? AND fence_epoch <= ?`,
        cmd.errorCode,
        cmd.nextAttemptAtMs,
        cmd.nowMs,
        cmd.outboxId,
        cmd.fenceEpoch,
      );
      return true;
    },

    recomputeAlarmSync(_tsNow) {
      const core = getCore();
      const bizDue = core
        .listDueBusinessActionsSync(Number.MAX_SAFE_INTEGER, 10)
        .map((a) => a.deadlineAtMs);
      const outboxRow = sql
        .exec<{ readonly m: number | null } & SqlStorageRow>(
          `SELECT MIN(next_attempt_at_ms) AS m
             FROM v2_dispatch_outbox
            WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
        )
        .one().m;
      const schedRow = sql
        .exec<{ readonly m: number | null } & SqlStorageRow>(
          `SELECT MIN(next_fire_at_ms) AS m
             FROM v2_schedules
            WHERE status = 'active'`,
        )
        .one().m;
      const candidates = [...bizDue, outboxRow, schedRow].filter((v): v is number => v !== null);
      return candidates.length === 0 ? null : Math.min(...candidates);
    },
  };

  const syncPlatformAlarm = async (targetAlarmAtMs: number | null, tsNow: number) => {
    const current = await doStorage.storage.getAlarm();
    if (targetAlarmAtMs === null) {
      if (current !== null) {
        await doStorage.storage.deleteAlarm();
      }
      sql.exec(
        'UPDATE v2_recovery_coverage SET armed_alarm_at_ms = NULL, updated_at_ms = ? WHERE id = 1',
        tsNow,
      );
      return;
    }
    if (current !== targetAlarmAtMs) {
      await doStorage.storage.setAlarm(targetAlarmAtMs);
      sql.exec(
        'UPDATE v2_recovery_coverage SET armed_alarm_at_ms = ?, updated_at_ms = ? WHERE id = 1',
        targetAlarmAtMs,
        tsNow,
      );
    }
  };

  const relayBudgetSync = async (tsNow: number) => {
    const core = getCore();
    const dueRows = sql
      .exec<V2DispatchOutboxRow & SqlStorageRow>(
        `SELECT *
           FROM v2_dispatch_outbox
          WHERE entity_kind = 'budget_sync'
            AND state IN ('pending', 'enqueued', 'dead_lettered')
            AND next_attempt_at_ms <= ?
          ORDER BY created_at_ms ASC`,
        tsNow,
      )
      .toArray();
    if (dueRows.length === 0) {
      return;
    }
    const settlePort = core.createGlobalBudgetSettlePort();
    for (const row of dueRows) {
      try {
        const payload = JSON.parse(row.payload_json) as BudgetSyncOutboxPayload;
        const result = await settlePort.settleGlobal(payload);
        if (result.accepted) {
          doStorage.storage.transactionSync(() => {
            eventCoordinator.ackOutboxSync(row.outbox_id, row.fence_epoch, tsNow);
          });
        } else {
          const backoffMs = Math.min(30_000, 1_000 * 2 ** row.publish_attempts);
          doStorage.storage.transactionSync(() => {
            sql.exec(
              `UPDATE v2_dispatch_outbox
                  SET publish_attempts = publish_attempts + 1,
                      state = 'pending',
                      next_attempt_at_ms = ?,
                      updated_at_ms = ?
                WHERE outbox_id = ?`,
              tsNow + backoffMs,
              tsNow,
              row.outbox_id,
            );
          });
        }
      } catch {
        const backoffMs = Math.min(30_000, 1_000 * 2 ** row.publish_attempts);
        doStorage.storage.transactionSync(() => {
          sql.exec(
            `UPDATE v2_dispatch_outbox
                SET publish_attempts = publish_attempts + 1,
                    state = 'pending',
                    next_attempt_at_ms = ?,
                    updated_at_ms = ?
              WHERE outbox_id = ?`,
            tsNow + backoffMs,
            tsNow,
            row.outbox_id,
          );
        });
      }
    }
  };

  const recoveryHooks: TurnRecoverySeamHooks = {
    reconcileCoverageSync({ expectedGen, nowMs: tsNow }) {
      const row = ensureCoverageRowSync(tsNow);
      if (row.generation > expectedGen) {
        return { action: 'noop_stale', currentGeneration: row.generation };
      }
      const openD = getCore().earliestRequiredDiscoveryAtMsSync(tsNow);
      if (row.pending_kind !== null || openD !== null) {
        if (row.pending_kind === 'retire' && openD === null) {
          const nextGen = Math.max(row.generation, expectedGen) + 1;
          sql.exec(
            `UPDATE v2_recovery_coverage
                SET generation = ?,
                    coverage_state = 'uncovered',
                    covered_recovery_at_ms = NULL,
                    pending_kind = NULL,
                    pending_prev_generation = NULL,
                    pending_target_at_ms = NULL,
                    updated_at_ms = ?
              WHERE id = 1`,
            nextGen,
            tsNow,
          );
          return { action: 'retire', retireUpToGen: nextGen - 1 };
        }
        const candidates: number[] = [];
        if (openD !== null) {
          candidates.push(openD);
        }
        if (
          (row.pending_kind === 'ensure' || row.pending_kind === 'postpone') &&
          row.pending_target_at_ms !== null
        ) {
          candidates.push(row.pending_target_at_ms);
        }
        if (candidates.length > 0) {
          const requiredAtMs = Math.min(...candidates);
          if (
            row.pending_kind === null &&
            row.coverage_state === 'covered' &&
            row.covered_recovery_at_ms !== null &&
            row.covered_recovery_at_ms <= requiredAtMs
          ) {
            if (row.covered_recovery_at_ms <= tsNow) {
              const newGen = Math.max(row.generation, expectedGen) + 1;
              sql.exec(
                `UPDATE v2_recovery_coverage
                    SET generation = ?,
                        pending_kind = 'postpone',
                        pending_prev_generation = ?,
                        pending_target_at_ms = ?,
                        updated_at_ms = ?
                  WHERE id = 1`,
                newGen,
                row.generation,
                requiredAtMs,
                tsNow,
              );
              return {
                action: 'postpone',
                expectedPrevGen: row.generation,
                newGeneration: newGen,
                nextRecoveryAtMs: requiredAtMs,
              };
            }
            return { action: 'keep_armed', currentGeneration: row.generation };
          }
          const newGen = Math.max(row.generation, expectedGen) + 1;
          sql.exec(
            `UPDATE v2_recovery_coverage
                SET generation = ?,
                    coverage_state = 'registering',
                    pending_kind = 'ensure',
                    pending_prev_generation = ?,
                    pending_target_at_ms = ?,
                    updated_at_ms = ?
              WHERE id = 1`,
            newGen,
            row.generation,
            requiredAtMs,
            tsNow,
          );
          return { action: 'repair_ensure', generation: newGen, recoveryAtMs: requiredAtMs };
        }
      }
      sql.exec(
        `UPDATE v2_recovery_coverage
            SET coverage_state = 'uncovered',
                covered_recovery_at_ms = NULL,
                pending_kind = NULL,
                pending_prev_generation = NULL,
                pending_target_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = 1`,
        tsNow,
      );
      return { action: 'retire', retireUpToGen: row.generation };
    },

    confirmCoveragePlanSync({ generation, actualRecoveryAtMs, applied, nowMs: tsNow }) {
      const row = getCoverageRowSync();
      if (
        row === null ||
        !applied ||
        row.generation !== generation ||
        actualRecoveryAtMs === null
      ) {
        return { confirmed: false };
      }
      sql.exec(
        `UPDATE v2_recovery_coverage
            SET coverage_state = 'covered',
                covered_recovery_at_ms = ?,
                pending_kind = NULL,
                pending_prev_generation = NULL,
                pending_target_at_ms = NULL,
                last_d1_sync_at_ms = ?,
                updated_at_ms = ?
          WHERE id = 1`,
        actualRecoveryAtMs,
        tsNow,
        tsNow,
      );
      return { confirmed: true };
    },

    getCoverageRowSync,
    getOutboxByIdSync,
    syncPlatformAlarm,
    relayBudgetSync,
  };

  const runAlarmCycle = async () => {
    const ts = nowMs();
    doStorage.consumeAlarmForFire();
    const core = getCore();
    doStorage.storage.transactionSync(() => {
      const due = core.listDueBusinessActionsSync(ts, 64);
      for (const item of due) {
        core.convergeDueBusinessItemSync(item.targetKind, item.targetId, ts);
      }
    });
    await relayBudgetSync(ts);
    const nextAlarm = doStorage.storage.transactionSync(() =>
      eventCoordinator.recomputeAlarmSync(ts),
    );
    await syncPlatformAlarm(nextAlarm, ts);
  };

  return {
    recoveryAdmission,
    eventCoordinator,
    recoveryHooks,
    runAlarmCycle,
  };
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

  const coreRef: { current?: AgentHeadCore } = {};
  const seam = createTestBRuntimeSeam({
    doStorage,
    tenantId,
    agentId,
    nowMs,
    getCore: () => {
      if (coreRef.current === undefined) {
        throw new Error('AgentHeadCore not yet initialized');
      }
      return coreRef.current;
    },
  });

  const core = new AgentHeadCore({
    storage: doStorage.storage,
    tenantId,
    agentId,
    recoveryAdmission: seam.recoveryAdmission,
    eventCoordinator: seam.eventCoordinator,
    recoveryHooks: seam.recoveryHooks,
    recoveryRegistry,
    globalBudget,
    nowMs,
    ...(options.globalDailyCeilingMicroUsd !== undefined
      ? { globalDailyCeilingMicroUsd: options.globalDailyCeilingMicroUsd }
      : {}),
  });
  coreRef.current = core;

  core.bootstrapHead({ conversationId, policyVersion: 1 });

  return {
    core,
    seam,
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
    await h.seam.runAlarmCycle();

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
    await h.seam.runAlarmCycle();

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
    await h.seam.runAlarmCycle();
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

  it('B4/F seam: supports single-step eventRuntimeFactory, exposes DurableExecutionClaimContext fields, and enforces delegation coverage atomically', async () => {
    const clock = { ms: 1_700_100_000_000 };
    const nowMs = () => clock.ms;
    const doStorage = createInstrumentedDoStorage();
    const recoveryRegistry = new FakeRecoveryRegistry();
    const globalBudget = new FakeGlobalBudgetAuthority(nowMs);
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    let seamRef!: ReturnType<typeof createTestBRuntimeSeam>;
    const core = new AgentHeadCore({
      storage: doStorage.storage,
      tenantId,
      agentId,
      recoveryRegistry,
      globalBudget,
      nowMs,
      eventRuntimeFactory: (business) => {
        seamRef = createTestBRuntimeSeam({
          doStorage,
          tenantId,
          agentId,
          nowMs,
          getCore: () => ({
            earliestRequiredDiscoveryAtMsSync: (ts) =>
              business.earliestRequiredDiscoveryAtMsSync(ts),
            listDueBusinessActionsSync: (ts, limit) =>
              business.listDueBusinessActionsSync(ts, limit),
            convergeDueBusinessItemSync: (kind, id, ts) =>
              business.convergeDueBusinessItemSync(kind, id, ts),
            createGlobalBudgetSettlePort: () => core.createGlobalBudgetSettlePort(),
          }),
        });
        return seamRef;
      },
    });
    core.bootstrapHead({ conversationId, policyVersion: 1 });

    // 1. Hand off an in-flight paid turn and verify B4 DurableExecutionClaimContext fields
    const prep = await core.prepareTurn({
      scope: { tenantId, principalId, agentId, policyVersion: 1, requestId: randomUUID() },
      conversationId,
      request: { client_submission_id: randomUUID(), text: 'b4 handoff', transcript_epoch: 0 },
      workerId: 'edge-sse',
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
        estimatedMicroUsd: 1_200,
      },
    });
    expect(prep.kind).toBe('prepared');
    if (prep.kind !== 'prepared') return;

    const sent = await core.markAttemptSent({
      scope: { tenantId, agentId },
      subjectType: 'turn',
      subjectId: prep.turnId,
      attemptNo: 1,
      operationId: prep.operationId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: 'edge-sse',
    });
    expect(sent.authorized).toBe(true);

    const handedOff = await core.handoffTurnToDurable({
      scope: { tenantId, agentId },
      conversationId,
      turnId: prep.turnId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: 'edge-sse',
      reason: 'client_disconnect_handoff',
      providerJobHandle: 'job-b4-1',
    });
    expect(handedOff.outcome).toBe('handed_off');
    if (handedOff.outcome !== 'handed_off') return;

    const claim = await core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `handoff:${prep.turnId}:epoch:${handedOff.nextLeaseEpoch}`,
        tenantId,
        agentId,
        entityKind: 'handoff',
        entityId: prep.turnId,
        queueName: 'durable_turn',
        fenceEpoch: handedOff.nextLeaseEpoch,
      },
      workerId: 'durable-worker-1',
      leaseMs: 60_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;
    const claimCtx = JSON.parse(claim.contextJson) as Record<string, unknown>;
    expect(claimCtx).toMatchObject({
      entityKind: 'turn',
      entityId: prep.turnId,
      operationId: prep.operationId,
      attemptId: '1',
      attemptNo: 1,
      sendState: 'sent',
      providerJobHandle: 'job-b4-1',
      interactiveHandoff: true,
    });
    expect(typeof claimCtx.sendAuthorizingAtMs).toBe('number');
    expect(typeof claimCtx.sendStartedAtMs).toBe('number');

    // Missing settlement in Turn commitDurableResult MUST NOT publish!
    const missingSettle = await core.commitDurableResult({
      tenantId,
      agentId,
      entityType: 'turn',
      entityId: prep.turnId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'durable-worker-1',
      outcome: {
        status: 'completed',
        text: 'Should be rejected without settlement',
      },
    });
    expect(missingSettle.accepted).toBe(false);

    const durableCommit = await core.commitDurableResult({
      tenantId,
      agentId,
      entityType: 'turn',
      entityId: prep.turnId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'durable-worker-1',
      outcome: {
        attemptNo: 1,
        operationId: prep.operationId,
        status: 'completed',
        text: 'Recovered durable answer',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
        settlement: {
          state: 'settled',
          outcomeCode: 'ok',
          observedCostMicroUsd: 900,
          inputTokens: 50,
          outputTokens: 120,
        },
      },
    });
    expect(durableCommit.accepted).toBe(true);
    expect(globalBudget.consumedMicroUsd).toBe(900);

    // 2. Delegation in commitTurn fails closed with DB_UNAVAILABLE if coverage is lost before commit
    const prepDel = await core.prepareTurn({
      scope: { tenantId, principalId, agentId, policyVersion: 1, requestId: randomUUID() },
      conversationId,
      request: { client_submission_id: randomUUID(), text: 'delegate fail', transcript_epoch: 0 },
      workerId: 'edge-sse-2',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
    });
    if (prepDel.kind !== 'prepared') throw new Error('expected prepared');
    doStorage.db
      .prepare(
        "UPDATE v2_recovery_coverage SET coverage_state = 'uncovered', covered_recovery_at_ms = NULL WHERE id = 1",
      )
      .run();
    recoveryRegistry.mode = 'unavailable';

    await expect(
      core.commitTurn({
        scope: { tenantId, agentId },
        conversationId,
        turnId: prepDel.turnId,
        leaseEpoch: prepDel.leaseEpoch,
        leaseOwner: 'edge-sse-2',
        attemptNo: 1,
        operationId: prepDel.operationId,
        settlement: { state: 'released', outcomeCode: 'ok' },
        result: {
          status: 'completed',
          text: 'Delegating...',
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          simulated: true,
          delegation: {
            toolName: 'delegate_notes_action_items',
            title: 'Should fail closed',
            input: { notes: 'Must not commit without coverage' },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });

    const taskCount = doStorage.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as {
      c: number;
    };
    expect(taskCount.c).toBe(0);
    // Keep seamRef referenced for closure lifecycle verification
    expect(seamRef).toBeDefined();
  });

  it('P1-1: reconciles late 400 overage on 250 hold after clearTranscript/cancel/expired Durable with UTC day, D1 coverage & conflict/wrong-op guards', async () => {
    const h = createHarness();
    // 2023-11-14T23:55:00.000Z
    const day1Ms = Date.UTC(2023, 10, 14, 23, 55, 0);
    h.setClock(day1Ms);

    // 1. Prepare 250 hold, markAttemptSent, then clearTranscript (250 conservative hold -> 0 turns left)
    const pClear = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'clear then late bill',
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
        estimatedMicroUsd: 250,
      },
    });
    if (pClear.kind !== 'prepared') throw new Error('expected prepared');
    await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: pClear.turnId,
      attemptNo: 1,
      operationId: pClear.operationId,
      leaseEpoch: pClear.leaseEpoch,
      leaseOwner: 'edge-1',
    });

    await h.core.clearTranscript({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
    });
    expect(h.globalBudget.consumedMicroUsd).toBe(250);

    // Simulate Sweeper retiring D1 coverage after transcript clear
    h.doStorage.db
      .prepare(
        "UPDATE v2_recovery_coverage SET coverage_state = 'uncovered', covered_recovery_at_ms = NULL WHERE id = 1",
      )
      .run();
    const upsertsBeforeLate = h.recoveryRegistry.upsertCalls;

    // Cross UTC midnight to 2023-11-15T00:05:00.000Z
    // Advance +6m across UTC midnight to 2023-11-15T00:01:00Z (still inside 600s turnDeadlineMs)
    h.advanceClock(360_000);

    // Late 400 on 250 hold after clearTranscript -> books 150 delta on ORIGINAL 2023-11-14 day & re-arms D1 coverage!
    const lateClear = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: pClear.turnId,
      leaseEpoch: pClear.leaseEpoch,
      leaseOwner: 'edge-1',
      attemptNo: 1,
      operationId: pClear.operationId,
      settlement: {
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 400,
        inputTokens: 20,
        outputTokens: 60,
      },
      result: {
        status: 'completed',
        text: 'late cleared answer',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
      },
    });
    expect(lateClear).toEqual({ outcome: 'fenced', turn: null });
    expect(h.recoveryRegistry.upsertCalls).toBe(upsertsBeforeLate + 1);
    expect(h.globalBudget.consumedMicroUsd).toBe(400);
    expect(h.globalBudget.overageMicroUsd).toBe(150);
    expect(h.globalBudget.globalIncident).toBe('reservation_exceeded');

    // Original UTC day & reservation overage preserved in local spend & model_attempts ledgers
    const day1Spend = h.doStorage.db
      .prepare(
        "SELECT consumed_micro_usd, overage_micro_usd FROM agent_spend_days WHERE scope_kind = 'tenant' AND utc_day = '2023-11-14'",
      )
      .get() as { consumed_micro_usd: number; overage_micro_usd: number };
    expect(day1Spend).toEqual({ consumed_micro_usd: 400, overage_micro_usd: 0 });
    const attemptOverage = h.doStorage.db
      .prepare(
        'SELECT applied_cost_micro_usd, overage_micro_usd, settlement_revision, utc_day FROM model_attempts WHERE operation_id = ?',
      )
      .get(pClear.operationId) as {
      applied_cost_micro_usd: number;
      overage_micro_usd: number;
      settlement_revision: number;
      utc_day: string;
    };
    expect(attemptOverage).toEqual({
      applied_cost_micro_usd: 400,
      overage_micro_usd: 150,
      settlement_revision: 1,
      utc_day: '2023-11-14',
    });
    expect(
      h.doStorage.db
        .prepare(
          "SELECT * FROM agent_spend_days WHERE scope_kind = 'tenant' AND utc_day = '2023-11-15'",
        )
        .all(),
    ).toHaveLength(0);

    // Repeated 400 & conflicting lower 300 or released evidence must NEVER rebook or refund
    for (const evidence of [400, 300, null]) {
      const rep = await h.core.commitTurn({
        scope: { tenantId: h.tenantId, agentId: h.agentId },
        conversationId: h.conversationId,
        turnId: pClear.turnId,
        leaseEpoch: pClear.leaseEpoch,
        leaseOwner: 'edge-1',
        attemptNo: 1,
        operationId: pClear.operationId,
        settlement:
          evidence === null
            ? { state: 'released', outcomeCode: 'not_sent' }
            : { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: evidence },
        result: {
          status: 'completed',
          text: 'repeat',
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          simulated: true,
        },
      });
      expect(rep.outcome).toBe('fenced');
    }
    expect(h.globalBudget.consumedMicroUsd).toBe(400);

    // Wrong operationId & wrong tenant rejection
    const wrongOp = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: pClear.turnId,
      leaseEpoch: 1,
      leaseOwner: 'edge-1',
      attemptNo: 1,
      operationId: randomUUID(),
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 900 },
      result: {
        status: 'completed',
        text: 'wrong op',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
      },
    });
    expect(wrongOp.outcome).toBe('fenced');
    expect(h.globalBudget.consumedMicroUsd).toBe(400);

    await expect(
      h.core.commitTurn({
        scope: { tenantId: randomUUID(), agentId: h.agentId },
        conversationId: h.conversationId,
        turnId: pClear.turnId,
        leaseEpoch: 1,
        leaseOwner: 'edge-1',
        attemptNo: 1,
        operationId: pClear.operationId,
        settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 900 },
        result: {
          status: 'completed',
          text: 'wrong tenant',
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          simulated: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    // Clear incidents so next test turns can reserve
    h.doStorage.db.prepare('UPDATE agent_budget_incidents SET resolved_at_ms = ?').run(h.nowMs());
    h.globalBudget.globalIncident = null;

    // 2. Cancel turn -> late overage reconciles via cancel path with 0 publications
    const pCancel = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'cancel then late',
        transcript_epoch: 1,
      },
      workerId: 'edge-c',
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
        estimatedMicroUsd: 200,
      },
    });
    if (pCancel.kind !== 'prepared') throw new Error('expected prepared');
    await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: pCancel.turnId,
      attemptNo: 1,
      operationId: pCancel.operationId,
      leaseEpoch: pCancel.leaseEpoch,
      leaseOwner: 'edge-c',
    });
    await h.core.cancelTurn({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      turnId: pCancel.turnId,
    });
    expect(
      await h.core.markAttemptSent({
        scope: { tenantId: h.tenantId, agentId: h.agentId },
        subjectType: 'turn',
        subjectId: pCancel.turnId,
        attemptNo: 1,
        operationId: pCancel.operationId,
        leaseEpoch: pCancel.leaseEpoch,
        leaseOwner: 'edge-c',
      }),
    ).toEqual({ authorized: false, reason: 'cancelled' });
    const lateCancel = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: pCancel.turnId,
      leaseEpoch: 1,
      leaseOwner: 'edge-c',
      attemptNo: 1,
      operationId: pCancel.operationId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 350 },
      result: {
        status: 'completed',
        text: 'cancelled reply',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
      },
    });
    expect(lateCancel.outcome).toBe('fenced');
    expect(lateCancel.turn?.status).toBe('cancelled');
    expect(h.globalBudget.consumedMicroUsd).toBe(400 + 350);

    h.doStorage.db.prepare('UPDATE agent_budget_incidents SET resolved_at_ms = ?').run(h.nowMs());
    h.globalBudget.globalIncident = null;

    // 3. Expired stale Durable commitDurableResult -> no publication, late 150 delta booked cleanly
    const pDurable = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'stale durable', transcript_epoch: 1 },
      workerId: 'edge-d',
      leaseMs: 20_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'durable_queue',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        rateVersion: 'v1',
        maxAttempts: 2,
        estimatedMicroUsd: 250,
      },
    });
    if (pDurable.kind !== 'prepared') throw new Error('expected prepared');
    const claimStale = await h.core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `turn:${pDurable.turnId}:epoch:1`,
        tenantId: h.tenantId,
        agentId: h.agentId,
        entityKind: 'turn',
        entityId: pDurable.turnId,
        queueName: 'durable_turn',
        fenceEpoch: 1,
      },
      workerId: 'durable-stale',
      leaseMs: 10_000,
    });
    if (claimStale.kind !== 'claimed') throw new Error('expected claimed');
    await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: pDurable.turnId,
      attemptNo: 1,
      operationId: pDurable.operationId,
      leaseEpoch: claimStale.leaseEpoch,
      leaseOwner: 'durable-stale',
    });

    // Expire durable lease via Alarm -> converges turn failed / attempt unknown_billed (250)
    h.advanceClock(15_000);
    await h.seam.runAlarmCycle();
    expect(h.globalBudget.consumedMicroUsd).toBe(750 + 250);

    const lateDurable = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'turn',
      entityId: pDurable.turnId,
      leaseEpoch: claimStale.leaseEpoch,
      workerId: 'durable-stale',
      outcome: {
        attemptNo: 1,
        operationId: pDurable.operationId,
        status: 'completed',
        text: 'Too late durable response',
        settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 400 },
      },
    });
    expect(lateDurable.accepted).toBe(false);
    expect(h.globalBudget.consumedMicroUsd).toBe(750 + 400);
    const turnDurable = await h.core.getTurn({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      turnId: pDurable.turnId,
    });
    expect(turnDurable?.status).toBe('failed');

    // 4. Stale worker / wrong operation MUST NEVER settle or terminalize a live active attempt
    h.doStorage.db.prepare('UPDATE agent_budget_incidents SET resolved_at_ms = ?').run(h.nowMs());
    h.globalBudget.globalIncident = null;
    const pActive = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'live active', transcript_epoch: 1 },
      workerId: 'edge-live',
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
        estimatedMicroUsd: 250,
      },
    });
    if (pActive.kind !== 'prepared') throw new Error('expected prepared');

    const staleOnActive = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: pActive.turnId,
      leaseEpoch: 99,
      leaseOwner: 'stale-worker',
      attemptNo: 1,
      operationId: pActive.operationId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 400 },
      result: {
        status: 'completed',
        text: 'hijack',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
      },
    });
    expect(staleOnActive.outcome).toBe('fenced');
    const wrongOpOnActive = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'turn',
      entityId: pActive.turnId,
      leaseEpoch: pActive.leaseEpoch,
      workerId: 'edge-live',
      outcome: {
        attemptNo: 1,
        operationId: randomUUID(),
        status: 'completed',
        text: 'wrong op',
        settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 400 },
      },
    });
    expect(wrongOpOnActive.accepted).toBe(false);

    const activeAttemptRow = h.doStorage.db
      .prepare('SELECT state FROM model_attempts WHERE operation_id = ?')
      .get(pActive.operationId) as { state: string };
    expect(activeAttemptRow.state).toBe('reserved');
    expect(
      (
        await h.core.getTurn({
          tenantId: h.tenantId,
          agentId: h.agentId,
          conversationId: h.conversationId,
          turnId: pActive.turnId,
        })
      )?.status,
    ).toBe('running');

    // The former lease holder can report usage for the exact send after handoff.
    const scope = { tenantId: h.tenantId, agentId: h.agentId };
    const oldLease = {
      scope,
      conversationId: h.conversationId,
      turnId: pActive.turnId,
      leaseEpoch: pActive.leaseEpoch,
      leaseOwner: 'edge-live',
    };
    expect(
      await h.core.markAttemptSent({
        scope,
        subjectType: 'turn',
        subjectId: pActive.turnId,
        attemptNo: pActive.attemptNo,
        operationId: pActive.operationId,
        leaseEpoch: oldLease.leaseEpoch,
        leaseOwner: oldLease.leaseOwner,
      }),
    ).toMatchObject({ authorized: true });
    expect(
      await h.core.handoffTurnToDurable({
        ...oldLease,
        reason: 'client_disconnect_handoff',
        providerJobHandle: 'same-provider-job',
      }),
    ).toMatchObject({ outcome: 'handed_off' });
    const usage = {
      scope,
      turnId: pActive.turnId,
      attemptNo: pActive.attemptNo,
      operationId: pActive.operationId,
      observedCostMicroUsd: 115,
    };
    await h.core.turnService.recordTurnUsage(usage);
    await h.core.turnService.recordTurnUsage(usage);
    expect(h.globalBudget.consumedMicroUsd).toBe(750 + 400 + 115);
    expect(
      await h.core.getTurn({ ...scope, conversationId: h.conversationId, turnId: pActive.turnId }),
    ).toMatchObject({ status: 'running', response_message_id: null });
  });

  it('P1-2: exposes sendAuthorizingAtMs & original utcDay on Durable claim, fences Task markAttemptSent worker/run, fails closed on missing global grant & binds Task settlements', async () => {
    const h = createHarness();
    const day1Ms = Date.UTC(2023, 10, 14, 23, 55, 0);
    h.setClock(day1Ms);

    // 1. Metered prepareTurn with 0 estimatedMicroUsd must fail closed immediately
    await expect(
      h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        request: { client_submission_id: randomUUID(), text: 'zero metered', transcript_epoch: 0 },
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
          estimatedMicroUsd: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // 2. Lost authorization ACK (`send_authorizing_at_ms` set, `send_started_at_ms` null) -> Durable claim MUST NOT treat as clean unsent & MUST keep original utcDay across midnight
    const prepAuthLost = await h.core.prepareTurn({
      scope: h.makeScope(),
      conversationId: h.conversationId,
      request: { client_submission_id: randomUUID(), text: 'auth ack lost', transcript_epoch: 0 },
      workerId: 'edge-lost-ack',
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
        estimatedMicroUsd: 300,
      },
    });
    if (prepAuthLost.kind !== 'prepared') throw new Error('expected prepared');

    // Simulate send_authorizing_at_ms written locally just before DO/provider ACK loss
    h.doStorage.db
      .prepare('UPDATE model_attempts SET send_authorizing_at_ms = ? WHERE operation_id = ?')
      .run(day1Ms + 100, prepAuthLost.operationId);

    // Handoff inside live 45s lease on Day 1, then advance across UTC midnight before claimDurableWork
    h.advanceClock(200);
    const handoffAckLost = await h.core.handoffTurnToDurable({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prepAuthLost.turnId,
      leaseEpoch: prepAuthLost.leaseEpoch,
      leaseOwner: 'edge-lost-ack',
      reason: 'interactive_deadline_120s',
      providerJobHandle: 'job-uncertain-ack',
    });
    expect(handoffAckLost.outcome).toBe('handed_off');
    if (handoffAckLost.outcome !== 'handed_off') return;

    // Advance +6m across UTC midnight to 2023-11-15T00:01:00Z (still inside 600s turnDeadlineMs)
    h.advanceClock(360_000);

    const claimAckLost = await h.core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `handoff:${prepAuthLost.turnId}:epoch:${handoffAckLost.nextLeaseEpoch}`,
        tenantId: h.tenantId,
        agentId: h.agentId,
        entityKind: 'handoff',
        entityId: prepAuthLost.turnId,
        queueName: 'durable_turn',
        fenceEpoch: handoffAckLost.nextLeaseEpoch,
      },
      workerId: 'durable-poll-worker',
      leaseMs: 45_000,
    });
    if (claimAckLost.kind !== 'claimed') throw new Error('expected claimed');
    const ackLostCtx = JSON.parse(claimAckLost.contextJson) as Record<string, unknown>;
    expect(ackLostCtx).toMatchObject({
      sendStartedAtMs: null,
      sendAuthorizingAtMs: day1Ms + 100,
      sendState: 'authorizing_unknown',
      utcDay: '2023-11-14',
      operationId: prepAuthLost.operationId,
      attemptNo: 1,
    });

    // markAttemptSent refuses outbound send after authorizing_unknown (`already_sent`)
    const blockedResend = await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: prepAuthLost.turnId,
      attemptNo: 1,
      operationId: prepAuthLost.operationId,
      leaseEpoch: claimAckLost.leaseEpoch,
      leaseOwner: 'durable-poll-worker',
    });
    expect(blockedResend).toEqual({ authorized: false, reason: 'already_sent' });

    // 3. Metered attempt missing global_grant_id fails closed (`budget_halted`)
    h.doStorage.db
      .prepare(
        'UPDATE model_attempts SET send_authorizing_at_ms = NULL, global_grant_id = NULL WHERE operation_id = ?',
      )
      .run(prepAuthLost.operationId);
    const noGrantSend = await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: prepAuthLost.turnId,
      attemptNo: 1,
      operationId: prepAuthLost.operationId,
      leaseEpoch: claimAckLost.leaseEpoch,
      leaseOwner: 'durable-poll-worker',
    });
    expect(noGrantSend).toEqual({ authorized: false, reason: 'budget_halted' });

    // 4. Task markAttemptSent checks current run worker owner & epoch; Durable task commit binds settlement & preserves non-model tasks
    const taskModelId = randomUUID();
    const taskNonModelId = randomUUID();
    const now = h.nowMs();
    for (const [tid, kind, path] of [
      [taskModelId, 'python.agent', 'heavy'],
      [taskNonModelId, 'notes.action_items', 'standard'],
    ] as const) {
      h.doStorage.db
        .prepare(
          `INSERT INTO tasks (id, kind, input_json, digest, idempotency_key, status, execution_path, execution_target, attempt_count, max_attempts, lease_epoch, next_run_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, '{"prompt":"p"}', ?, ?, 'queued', ?, 'cloud', 0, 3, 1, ?, ?, ?)`,
        )
        .run(tid, kind, tid, tid, path, now, now, now);
      h.doStorage.db
        .prepare(
          `INSERT INTO v2_dispatch_outbox (outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id, revision, state, next_attempt_at_ms, publish_attempts, dlq_count, fence_epoch, created_at_ms, updated_at_ms)
           VALUES (?, 'task', ?, 'agent_task', '{}', NULL, 0, 'pending', ?, 0, 0, 1, ?, ?)`,
        )
        .run(`task:${tid}:epoch:1`, tid, now, now, now);
    }

    // Non-model task succeeds without settlement
    const nonModelClaim = await h.core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `task:${taskNonModelId}:epoch:1`,
        tenantId: h.tenantId,
        agentId: h.agentId,
        entityKind: 'task',
        entityId: taskNonModelId,
        queueName: 'agent_task',
        fenceEpoch: 1,
      },
      workerId: 'notes-worker',
      leaseMs: 30_000,
    });
    if (nonModelClaim.kind !== 'claimed') throw new Error('expected non-model claim');
    const nonModelCommit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: taskNonModelId,
      leaseEpoch: nonModelClaim.leaseEpoch,
      workerId: 'notes-worker',
      outcome: { status: 'completed', summaryText: 'Extracted 2 action items' },
    });
    expect(nonModelCommit.accepted).toBe(true);

    // Model-backed task: worker owner check on markAttemptSent + mandatory bound settlement on commitDurableResult
    const modelClaim = await h.core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `task:${taskModelId}:epoch:1`,
        tenantId: h.tenantId,
        agentId: h.agentId,
        entityKind: 'task',
        entityId: taskModelId,
        queueName: 'agent_task',
        fenceEpoch: 1,
      },
      workerId: 'python-worker-1',
      leaseMs: 30_000,
    });
    if (modelClaim.kind !== 'claimed') throw new Error('expected model claim');
    const claimedRun = JSON.parse(modelClaim.contextJson) as { readonly runId: string };

    const taskRes = await h.core.reserveTaskModelAttempt({
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      taskId: taskModelId,
      runId: claimedRun.runId,
      leaseEpoch: modelClaim.leaseEpoch,
      providerId: 'fake',
      modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
      rateVersion: 'v1',
      budgetMode: 'simulated_full_protocol',
      estimatedMicroUsd: 500,
    });
    if (taskRes.kind !== 'reserved') throw new Error('expected reserved');

    // Wrong worker owner MUST be fenced on Task markAttemptSent
    const wrongWorkerSend = await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'task',
      subjectId: taskModelId,
      attemptNo: taskRes.attemptNo,
      operationId: taskRes.operationId,
      leaseEpoch: modelClaim.leaseEpoch,
      leaseOwner: 'wrong-python-worker',
    });
    expect(wrongWorkerSend).toEqual({ authorized: false, reason: 'fenced' });

    const ownerSend = await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'task',
      subjectId: taskModelId,
      attemptNo: taskRes.attemptNo,
      operationId: taskRes.operationId,
      leaseEpoch: modelClaim.leaseEpoch,
      leaseOwner: 'python-worker-1',
    });
    expect(ownerSend.authorized).toBe(true);

    // Committing model-backed task WITHOUT settlement MUST be rejected!
    const missingTaskSettle = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: taskModelId,
      leaseEpoch: modelClaim.leaseEpoch,
      workerId: 'python-worker-1',
      outcome: { status: 'completed', summaryText: 'missing settlement' },
    });
    expect(missingTaskSettle.accepted).toBe(false);

    // Committing with exact `(attemptNo, operationId, settlement)` completes & settles atomically
    const validTaskCommit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'task',
      entityId: taskModelId,
      leaseEpoch: modelClaim.leaseEpoch,
      workerId: 'python-worker-1',
      outcome: {
        status: 'completed',
        summaryText: 'Computed Python analysis',
        attemptNo: taskRes.attemptNo,
        operationId: taskRes.operationId,
        settlement: {
          state: 'settled',
          outcomeCode: 'ok',
          observedCostMicroUsd: 420,
          inputTokens: 30,
          outputTokens: 90,
        },
      },
    });
    expect(validTaskCommit.accepted).toBe(true);
    expect(h.globalBudget.consumedMicroUsd).toBe(420);
  });
});

// Keep explicit type-level import usage verified for AgentSpendDayRow
export type _CheckSpendDayRow = AgentSpendDayRow;
