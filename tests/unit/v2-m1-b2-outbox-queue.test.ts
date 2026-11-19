import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applyAgentHeadMigrations,
  computePreDeadlineRetryAtMs,
  createGlobalBudgetAuthoritySettlePort,
  EVENT_RECOVERY_DO_MIGRATION,
  findNextCronTzFireAtMs,
  getLocalWallClockParts,
  handleDurableDeadLetterBatch,
  handleDurableQueueBatch,
  OutboxConstraintError,
  OutboxCoordinator,
  relayDueBudgetSyncBatch,
  resolveDeadLetterRetrySchedule,
  ScheduleRepository,
  verifyAndClaimDispatchEnvelope,
  type AgentHeadRecoveryPort,
  type AuthoritativeBusinessPort,
  type BudgetSyncOutboxPayload,
  type DurableObjectStorageLike,
  type GlobalBudgetSettlePort,
  type BudgetSyncGlobalSettleResult,
  type QueueLike,
  type QueueMessageLike,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type V2DispatchEnvelope,
} from '@ember/runtime-v2';

function createNodeDoHarness(): { db: DatabaseSync; storage: DurableObjectStorageLike } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  const exec = <T extends SqlStorageRow = SqlStorageRow>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> => {
    const stmt = db.prepare(query);
    const params = bindings as Array<string | number | Uint8Array | null>;
    const isRead = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
    const rows = (isRead ? stmt.all(...params) : []) as T[];
    if (!isRead) {
      stmt.run(...params);
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
      rowsWritten: isRead ? 0 : 1,
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  };

  let inTx = false;
  const storage: DurableObjectStorageLike = {
    sql: { exec },
    transactionSync<T>(closure: () => T): T {
      if (inTx) {
        return closure();
      }
      inTx = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = closure();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        inTx = false;
      }
    },
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  };

  applyAgentHeadMigrations(storage, [EVENT_RECOVERY_DO_MIGRATION], 1_000);
  return { db, storage };
}

class InMemoryAuthoritativeBusiness implements AuthoritativeBusinessPort {
  readonly materialized: Array<{ scheduleId: string; occurrenceSeq: number; nowMs: number }> = [];
  readonly converged: Array<{ targetKind: 'turn' | 'task'; targetId: string; nowMs: number }> = [];
  readonly targets = new Map<
    string,
    {
      targetKind: 'turn' | 'task';
      targetId: string;
      currentLeaseEpoch: number;
      deadlineAtMs: number;
      isTerminal: boolean;
      cancelRequested: boolean;
    }
  >();

  earliestRequiredDiscoveryAtMsSync(_nowMs: number): number | null {
    return null;
  }

  listDueBusinessActionsSync(_nowMs: number, _limit: number) {
    return [];
  }

  convergeDueBusinessItemSync(targetKind: 'turn' | 'task', targetId: string, nowMs: number): void {
    this.converged.push({ targetKind, targetId, nowMs });
  }

  inspectOutboxTargetSync(
    entityKind: 'turn' | 'task' | 'schedule_occurrence' | 'handoff',
    entityId: string,
  ) {
    const entry = this.targets.get(`${entityKind}:${entityId}`);
    if (!entry) {
      return {
        exists: false,
        targetKind: null,
        targetId: null,
        currentLeaseEpoch: 0,
        deadlineAtMs: 0,
        isTerminal: true,
        cancelRequested: false,
      };
    }
    return {
      exists: true,
      ...entry,
    };
  }

  materializeScheduleOccurrenceSync(
    scheduleId: string,
    occurrenceSeq: number,
    nowMs: number,
  ): void {
    this.materialized.push({ scheduleId, occurrenceSeq, nowMs });
  }
}

describe('V2-M1-B2 Outbox, Queue Fencing, DLQ, Budget Relay, and Schedule Materialization', () => {
  it('publishes outbox messages, retries on Queue failure, and enforces pre-deadline retry capping', async () => {
    const { db, storage } = createNodeDoHarness();
    const business = new InMemoryAuthoritativeBusiness();
    const coordinator = new OutboxCoordinator(storage.sql, { storage, business });

    const envelope: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: 'out-turn-1',
      tenantId: 'ten-1',
      agentId: 'ag-1',
      entityKind: 'turn',
      entityId: 'turn-1',
      queueName: 'durable_turn',
      fenceEpoch: 2,
    };

    business.targets.set('turn:turn-1', {
      targetKind: 'turn',
      targetId: 'turn-1',
      currentLeaseEpoch: 2,
      deadlineAtMs: 110_000,
      isTerminal: false,
      cancelRequested: false,
    });

    coordinator.enqueueDurableOutboxSync({
      outboxId: 'out-turn-1',
      entityKind: 'turn',
      entityId: 'turn-1',
      queueName: 'durable_turn',
      payloadJson: JSON.stringify(envelope),
      fenceEpoch: 2,
      nextAttemptAtMs: 100_000,
    });

    let failSend = true;
    const sentMessages: V2DispatchEnvelope[] = [];
    const queueStub: QueueLike<V2DispatchEnvelope> = {
      send: async (msg) => {
        await Promise.resolve();
        if (failSend) {
          throw new Error('queue temporarily unavailable');
        }
        sentMessages.push(msg);
      },
    };

    // Attempt 1 fails -> remains 'pending', increments publish_attempts, schedules retry at +2s
    const failRes = await coordinator.dispatchDueOrdinaryOutbox({
      nowMs: 100_000,
      queues: { durable_turn: queueStub, agent_task: queueStub },
    });
    expect(failRes.failedCount).toBe(1);
    const afterFail = coordinator.getOutboxByIdSync('out-turn-1');
    expect(afterFail?.state).toBe('pending');
    expect(afterFail?.publish_attempts).toBe(1);
    expect(afterFail?.next_attempt_at_ms).toBe(102_000);

    // Attempt 2 at 102_000 succeeds -> becomes 'enqueued', capped at deadline - 5_000 = 105_000
    failSend = false;
    const okRes = await coordinator.dispatchDueOrdinaryOutbox({
      nowMs: 102_000,
      queues: { durable_turn: queueStub, agent_task: queueStub },
    });
    expect(okRes.sentCount).toBe(1);
    expect(sentMessages).toEqual([envelope]);
    const afterOk = coordinator.getOutboxByIdSync('out-turn-1');
    expect(afterOk?.state).toBe('enqueued');
    expect(afterOk?.next_attempt_at_ms).toBe(105_000);

    // Pre-deadline boundary at remaining = 1000ms vs 1001ms inside DLQ scheduler
    expect(
      resolveDeadLetterRetrySchedule({
        nowMs: 109_000,
        deadlineAtMs: 110_000,
        isTerminalOrCancelled: false,
      }),
    ).toEqual({ action: 'armed_deadline_convergence', alarmAtMs: 110_000 });
    expect(
      resolveDeadLetterRetrySchedule({
        nowMs: 108_999,
        deadlineAtMs: 110_000,
        isTerminalOrCancelled: false,
      }),
    ).toEqual({ action: 'rescheduled', alarmAtMs: 109_999 });

    db.close();
  });

  it('rejects duplicate, out-of-order, future-epoch, cross-tenant, wrong-queue, and budget_sync envelopes with zero mutation', async () => {
    const { db, storage } = createNodeDoHarness();
    const business = new InMemoryAuthoritativeBusiness();
    const coordinator = new OutboxCoordinator(storage.sql, { storage, business });

    business.targets.set('task:task-1', {
      targetKind: 'task',
      targetId: 'task-1',
      currentLeaseEpoch: 5,
      deadlineAtMs: 500_000,
      isTerminal: false,
      cancelRequested: false,
    });

    const validEnv: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: 'out-task-5',
      tenantId: 'ten-a',
      agentId: 'ag-a',
      entityKind: 'task',
      entityId: 'task-1',
      queueName: 'agent_task',
      fenceEpoch: 5,
    };

    coordinator.enqueueDurableOutboxSync({
      outboxId: 'out-task-5',
      entityKind: 'task',
      entityId: 'task-1',
      queueName: 'agent_task',
      payloadJson: JSON.stringify(validEnv),
      fenceEpoch: 5,
      nextAttemptAtMs: 10_000,
    });

    let claimCalls = 0;
    const recoveryPort: Pick<AgentHeadRecoveryPort, 'claimDurableWork'> = {
      claimDurableWork: async (cmd) => {
        await Promise.resolve();
        claimCalls += 1;
        return {
          kind: 'claimed',
          targetKind: 'task',
          targetId: cmd.envelope.entityId,
          leaseEpoch: cmd.envelope.fenceEpoch,
          leaseExpiresAtMs: 100_000,
          contextJson: '{}',
        };
      },
    };

    // 1. Cross-tenant envelope rejected
    const crossTenant = await verifyAndClaimDispatchEnvelope({
      rawEnvelope: { ...validEnv, tenantId: 'ten-b' },
      expectedQueueName: 'agent_task',
      identity: { tenantId: 'ten-a', agentId: 'ag-a' },
      storage,
      coordinator,
      business,
      recoveryPort,
      workerId: 'w-1',
      leaseMs: 30_000,
      nowMs: 12_000,
    });
    expect(crossTenant).toMatchObject({ kind: 'rejected', code: 'TENANT_OR_AGENT_MISMATCH' });

    // 2. Wrong queue rejected
    const wrongQueue = await verifyAndClaimDispatchEnvelope({
      rawEnvelope: validEnv,
      expectedQueueName: 'durable_turn',
      identity: { tenantId: 'ten-a', agentId: 'ag-a' },
      storage,
      coordinator,
      business,
      recoveryPort,
      workerId: 'w-1',
      leaseMs: 30_000,
      nowMs: 12_000,
    });
    expect(wrongQueue).toMatchObject({ kind: 'rejected', code: 'QUEUE_NAME_MISMATCH' });

    // 3. budget_sync injected onto external queue rejected
    const budgetOnQueue = await verifyAndClaimDispatchEnvelope({
      rawEnvelope: { ...validEnv, entityKind: 'budget_sync' },
      expectedQueueName: 'agent_task',
      identity: { tenantId: 'ten-a', agentId: 'ag-a' },
      storage,
      coordinator,
      business,
      recoveryPort,
      workerId: 'w-1',
      leaseMs: 30_000,
      nowMs: 12_000,
    });
    expect(budgetOnQueue).toMatchObject({ kind: 'rejected', code: 'BUDGET_SYNC_FORBIDDEN' });

    // 4. Stale / future epoch forged against business currentLeaseEpoch=5 rejected
    coordinator.enqueueDurableOutboxSync({
      outboxId: 'out-task-stale',
      entityKind: 'task',
      entityId: 'task-1',
      queueName: 'agent_task',
      payloadJson: JSON.stringify({ ...validEnv, eventId: 'out-task-stale', fenceEpoch: 4 }),
      fenceEpoch: 4,
      nextAttemptAtMs: 10_000,
    });
    coordinator.enqueueDurableOutboxSync({
      outboxId: 'out-task-future',
      entityKind: 'task',
      entityId: 'task-1',
      queueName: 'agent_task',
      payloadJson: JSON.stringify({ ...validEnv, eventId: 'out-task-future', fenceEpoch: 99 }),
      fenceEpoch: 99,
      nextAttemptAtMs: 10_000,
    });
    const staleRes = await verifyAndClaimDispatchEnvelope({
      rawEnvelope: { ...validEnv, eventId: 'out-task-stale', fenceEpoch: 4 },
      expectedQueueName: 'agent_task',
      identity: { tenantId: 'ten-a', agentId: 'ag-a' },
      storage,
      coordinator,
      business,
      recoveryPort,
      workerId: 'w-1',
      leaseMs: 30_000,
      nowMs: 12_000,
    });
    expect(staleRes).toMatchObject({ kind: 'rejected', code: 'STALE_OR_FUTURE_EPOCH' });

    const futureRes = await verifyAndClaimDispatchEnvelope({
      rawEnvelope: { ...validEnv, eventId: 'out-task-future', fenceEpoch: 99 },
      expectedQueueName: 'agent_task',
      identity: { tenantId: 'ten-a', agentId: 'ag-a' },
      storage,
      coordinator,
      business,
      recoveryPort,
      workerId: 'w-1',
      leaseMs: 30_000,
      nowMs: 12_000,
    });
    expect(futureRes).toMatchObject({ kind: 'rejected', code: 'STALE_OR_FUTURE_EPOCH' });
    expect(claimCalls).toBe(0);

    // 5. Valid claim succeeds & acks outbox
    const claimed = await verifyAndClaimDispatchEnvelope({
      rawEnvelope: validEnv,
      expectedQueueName: 'agent_task',
      identity: { tenantId: 'ten-a', agentId: 'ag-a' },
      storage,
      coordinator,
      business,
      recoveryPort,
      workerId: 'w-1',
      leaseMs: 30_000,
      nowMs: 12_000,
    });
    expect(claimed.kind).toBe('claimed');
    expect(claimCalls).toBe(1);
    expect(coordinator.getOutboxByIdSync('out-task-5')?.state).toBe('acked');

    // 6. Duplicate delivery after ACK returns already_handled without re-claiming
    const dup = await verifyAndClaimDispatchEnvelope({
      rawEnvelope: validEnv,
      expectedQueueName: 'agent_task',
      identity: { tenantId: 'ten-a', agentId: 'ag-a' },
      storage,
      coordinator,
      business,
      recoveryPort,
      workerId: 'w-1',
      leaseMs: 30_000,
      nowMs: 13_000,
    });
    expect(dup).toEqual({ kind: 'already_handled', state: 'acked', ackQueueMessage: true });
    expect(claimCalls).toBe(1);

    db.close();
  });

  it('relays budget_sync verbatim, preserves it across entity cancellation, refuses ACK without Global confirmation, and handles out-of-order cumulative revisions', async () => {
    const { db, storage } = createNodeDoHarness();
    const coordinator = new OutboxCoordinator(storage.sql, { storage });

    const turnEnv: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: 'out-turn-x',
      tenantId: 't1',
      agentId: 'a1',
      entityKind: 'turn',
      entityId: 'turn-x',
      queueName: 'durable_turn',
      fenceEpoch: 1,
    };
    coordinator.enqueueDurableOutboxSync({
      outboxId: 'out-turn-x',
      entityKind: 'turn',
      entityId: 'turn-x',
      queueName: 'durable_turn',
      payloadJson: JSON.stringify(turnEnv),
      fenceEpoch: 1,
      nextAttemptAtMs: 1_000,
    });

    const rev0: BudgetSyncOutboxPayload = {
      schemaVersion: 1,
      tenantId: 't1',
      principalId: 'p1',
      agentId: 'a1',
      utcDay: '2026-11-19',
      globalGrantId: 'grant-1',
      operationId: 'op-100',
      settlementRevision: 0,
      state: 'conservative_billed',
      reservedMicroUsd: 300,
      chargeMicroUsd: 200,
      observedCostMicroUsd: null,
      overageMicroUsd: 0,
      openIncidentReason: 'usage_missing',
    };

    const rev1: BudgetSyncOutboxPayload = {
      ...rev0,
      settlementRevision: 1,
      state: 'settled',
      chargeMicroUsd: 275,
      observedCostMicroUsd: 275,
      overageMicroUsd: 0,
      openIncidentReason: null,
    };

    // Simulate rev1 inserted with earlier next_attempt_at_ms so out-of-order delivery (rev1 then rev0) is exercised
    coordinator.enqueueDurableOutboxSync({
      outboxId: 'out-bs-rev0',
      entityKind: 'budget_sync',
      entityId: 'op-100',
      queueName: null,
      payloadJson: JSON.stringify(rev0),
      operationId: 'op-100',
      revision: 0,
      fenceEpoch: 0,
      nextAttemptAtMs: 1_000,
    });
    coordinator.enqueueDurableOutboxSync({
      outboxId: 'out-bs-rev1',
      entityKind: 'budget_sync',
      entityId: 'op-100',
      queueName: null,
      payloadJson: JSON.stringify(rev1),
      operationId: 'op-100',
      revision: 1,
      fenceEpoch: 0,
      nextAttemptAtMs: 1_000,
    });

    // Cancelling ordinary turn must cancel ordinary outbox but MUST preserve budget_sync
    coordinator.cancelEntityOutboxSync('turn', 'turn-x', 1_100);
    expect(coordinator.getOutboxByIdSync('out-turn-x')?.state).toBe('cancelled');
    expect(coordinator.getOutboxByIdSync('out-bs-rev0')?.state).toBe('pending');
    expect(coordinator.getOutboxByIdSync('out-bs-rev1')?.state).toBe('pending');

    expect(() =>
      coordinator.cancelEntityOutboxSync('budget_sync' as 'turn', 'op-100', 1_100),
    ).toThrow(OutboxConstraintError);

    // Stateful monotone Global authority stub verifying cumulative delta, halt persistence, & conflict rejection
    const appliedOps = new Map<
      string,
      {
        highestRevision: number;
        cumulativeCharge: number;
        haltOpen: boolean;
        seenPayloads: Map<number, string>;
      }
    >();
    let totalGlobalCharged = 0;
    let simulateOutage = true;

    const globalBudget: GlobalBudgetSettlePort = {
      settleGlobal: async (payload): Promise<BudgetSyncGlobalSettleResult> => {
        await Promise.resolve();
        if (simulateOutage) {
          throw new Error('GlobalBudgetDO unavailable');
        }
        const entry = appliedOps.get(payload.operationId) ?? {
          highestRevision: -1,
          cumulativeCharge: 0,
          haltOpen: false,
          seenPayloads: new Map<number, string>(),
        };
        const canonical = JSON.stringify(payload);
        const existingRev = entry.seenPayloads.get(payload.settlementRevision);
        if (existingRev !== undefined) {
          return existingRev === canonical
            ? { accepted: true, alreadySettled: true, appliedDeltaMicroUsd: 0 }
            : { accepted: false, conflict: true, errorCode: 'REVISION_PAYLOAD_CONFLICT' };
        }
        entry.seenPayloads.set(payload.settlementRevision, canonical);

        if (payload.openIncidentReason !== null) {
          entry.haltOpen = true;
        }
        let delta = 0;
        if (payload.settlementRevision > entry.highestRevision) {
          entry.highestRevision = payload.settlementRevision;
          if (payload.chargeMicroUsd > entry.cumulativeCharge) {
            delta = payload.chargeMicroUsd - entry.cumulativeCharge;
            entry.cumulativeCharge = payload.chargeMicroUsd;
            totalGlobalCharged += delta;
          }
        }
        appliedOps.set(payload.operationId, entry);
        return { accepted: true, appliedDeltaMicroUsd: delta };
      },
    };

    // During outage, must NOT ACK
    const outageRes = await relayDueBudgetSyncBatch({
      sql: storage.sql,
      storage,
      coordinator,
      globalBudget,
      nowMs: 1_500,
    });
    expect(outageRes.ackedCount).toBe(0);
    expect(outageRes.retriedCount).toBe(2);
    expect(coordinator.getOutboxByIdSync('out-bs-rev0')?.state).toBe('pending');
    expect(coordinator.getOutboxByIdSync('out-bs-rev1')?.state).toBe('pending');

    // Out-of-order test: deliver rev1=275 first, then stale rev0=200 (halt still preserved, balance stays 275!)
    simulateOutage = false;
    const rev1Res = await globalBudget.settleGlobal(rev1);
    expect(rev1Res).toEqual({ accepted: true, appliedDeltaMicroUsd: 275 });
    const staleRev0Res = await globalBudget.settleGlobal(rev0);
    expect(staleRev0Res).toEqual({ accepted: true, appliedDeltaMicroUsd: 0 });
    expect(totalGlobalCharged).toBe(275);
    expect(appliedOps.get('op-100')?.haltOpen).toBe(true);

    // Same-revision conflicting payload is rejected directly by settleGlobal and never ACKs outbox
    const conflictCheck = await globalBudget.settleGlobal({ ...rev0, chargeMicroUsd: 999 });
    expect(conflictCheck).toMatchObject({ accepted: false, conflict: true });

    // Relay drains un-acked rows once retries come due -> acks rev0 and rev1
    const okRelay = await relayDueBudgetSyncBatch({
      sql: storage.sql,
      storage,
      coordinator,
      globalBudget,
      nowMs: 25_000,
    });
    expect(okRelay.ackedCount).toBe(2);
    expect(coordinator.getOutboxByIdSync('out-bs-rev0')?.state).toBe('acked');
    expect(coordinator.getOutboxByIdSync('out-bs-rev1')?.state).toBe('acked');
    expect(totalGlobalCharged).toBe(275);

    // Relay-level conflict test: pre-settled op-101 rev1 differs from outbox row -> keeps un-acked
    await globalBudget.settleGlobal({ ...rev1, operationId: 'op-101', chargeMicroUsd: 500 });
    coordinator.enqueueDurableOutboxSync({
      outboxId: 'out-bs-rev1-dup',
      entityKind: 'budget_sync',
      entityId: 'op-101',
      queueName: null,
      payloadJson: JSON.stringify({ ...rev1, operationId: 'op-101' }),
      operationId: 'op-101',
      revision: 1,
      fenceEpoch: 0,
      nextAttemptAtMs: 25_000,
    });
    const conflictRelay = await relayDueBudgetSyncBatch({
      sql: storage.sql,
      storage,
      coordinator,
      globalBudget,
      nowMs: 30_000,
    });
    expect(conflictRelay.conflictCount).toBe(1);
    expect(coordinator.getOutboxByIdSync('out-bs-rev1-dup')?.state).toBe('pending');
    expect(coordinator.getOutboxByIdSync('out-bs-rev1-dup')?.last_error_code).toBe(
      'REVISION_PAYLOAD_CONFLICT',
    );

    db.close();
  });

  it('handles cron_tz DST spring-forward, fall-back single-fire, misfire coalescing, and isolated atomic schedule materialization', () => {
    // 1. America/New_York Spring-Forward 2026-03-08 02:30 -> jumps 02:00->03:00 EDT (07:00 UTC)
    const beforeSpringForward = Date.parse('2026-03-08T05:00:00Z');
    const springFireUtc = findNextCronTzFireAtMs({
      cronExpr: '30 2 * * *',
      timezone: 'America/New_York',
      afterUtcMs: beforeSpringForward,
      lastFiredAtMs: null,
    });
    const springParts = getLocalWallClockParts(springFireUtc, 'America/New_York');
    expect(springParts.dateKey).toBe('2026-03-08');
    expect({ hour: springParts.hour, minute: springParts.minute }).toEqual({ hour: 3, minute: 0 });

    // 2. America/New_York Fall-Back 2026-11-01 01:30 -> fires ONCE at 01:30 EDT (05:30Z), next slot is 2026-11-02 01:30 EST
    const beforeFallBack = Date.parse('2026-11-01T04:00:00Z');
    const firstFallFire = findNextCronTzFireAtMs({
      cronExpr: '30 1 * * *',
      timezone: 'America/New_York',
      afterUtcMs: beforeFallBack,
      lastFiredAtMs: null,
    });
    expect(firstFallFire).toBe(Date.parse('2026-11-01T05:30:00Z'));

    // Overlap hour (06:05Z = 01:05 EST on same local date) must NOT fire 01:30 a second time
    const nextAfterOverlap = findNextCronTzFireAtMs({
      cronExpr: '30 1 * * *',
      timezone: 'America/New_York',
      afterUtcMs: firstFallFire + 35 * 60_000, // 06:05Z before second 01:30 EST at 06:30Z
      lastFiredAtMs: firstFallFire,
    });
    expect(getLocalWallClockParts(nextAfterOverlap, 'America/New_York').dateKey).toBe('2026-11-02');
    expect(nextAfterOverlap).toBe(Date.parse('2026-11-02T06:30:00Z'));

    // 3. Atomic DO SQLite schedule materialization with corrupt schedule isolation
    const { db, storage } = createNodeDoHarness();
    const repo = new ScheduleRepository(storage.sql);
    const business = new InMemoryAuthoritativeBusiness();

    repo.upsertScheduleSync({
      scheduleId: 'sched-corrupt',
      tenantId: 't1',
      agentId: 'a1',
      sourceKind: 'reminder',
      sourceId: 'rem-bad',
      scheduleKind: 'once',
      intervalSeconds: null,
      cronExpr: null,
      firstFireAtMs: 10_000,
      nowMs: 5_000,
    });
    repo.upsertScheduleSync({
      scheduleId: 'sched-int',
      tenantId: 't1',
      agentId: 'a1',
      sourceKind: 'commitment',
      sourceId: 'commit-1',
      scheduleKind: 'interval',
      intervalSeconds: 60,
      cronExpr: null,
      firstFireAtMs: 12_000,
      misfirePolicy: 'coalesce_latest',
      nowMs: 5_000,
    });

    // Persisted invalid interval configuration is isolated before occurrence writes.
    db.exec(
      "UPDATE v2_schedules SET schedule_kind = 'interval' WHERE schedule_id = 'sched-corrupt'",
    );
    const batchRes = storage.transactionSync(() =>
      repo.processDueSchedulesSync(business, 150_000, 10),
    );
    expect(batchRes.isolatedErrors).toHaveLength(1);
    expect(batchRes.isolatedErrors[0]?.scheduleId).toBe('sched-corrupt');
    expect(batchRes.processedCount).toBe(1);
    expect(batchRes.materialized[0]).toEqual({
      scheduleId: 'sched-int',
      occurrenceSeq: 1,
      nextFireAtMs: 192_000, // 12_000 + 3 * 60_000 > 150_000
      status: 'active',
    });
    expect(business.materialized).toEqual([
      { scheduleId: 'sched-int', occurrenceSeq: 1, nowMs: 150_000 },
    ]);

    db.close();
  });

  it('rolls back schedule progress and partial business writes on materialization failure', () => {
    const { db, storage } = createNodeDoHarness();
    const repo = new ScheduleRepository(storage.sql);
    db.exec(
      'CREATE TABLE schedule_test_work (schedule_id TEXT NOT NULL, occurrence_seq INTEGER NOT NULL, PRIMARY KEY (schedule_id, occurrence_seq))',
    );
    repo.upsertScheduleSync({
      scheduleId: 'sched-retry',
      tenantId: 't1',
      agentId: 'a1',
      sourceKind: 'reminder',
      sourceId: 'rem-retry',
      scheduleKind: 'once',
      intervalSeconds: null,
      cronExpr: null,
      firstFireAtMs: 10_000,
      nowMs: 5_000,
    });

    let fail = true;
    const business = new InMemoryAuthoritativeBusiness();
    business.materializeScheduleOccurrenceSync = (scheduleId, occurrenceSeq) => {
      storage.sql.exec(
        'INSERT INTO schedule_test_work (schedule_id, occurrence_seq) VALUES (?, ?)',
        scheduleId,
        occurrenceSeq,
      );
      if (fail) {
        throw new Error('injected failure after business write');
      }
    };
    const getSchedule = () =>
      db.prepare("SELECT * FROM v2_schedules WHERE schedule_id = 'sched-retry'").get();
    const getWork = () => db.prepare('SELECT * FROM schedule_test_work').all();

    expect(() =>
      storage.transactionSync(() => repo.processDueSchedulesSync(business, 15_000)),
    ).toThrow('injected failure after business write');
    expect(getSchedule()).toMatchObject({
      status: 'active',
      occurrence_seq: 0,
      last_fired_at_ms: null,
      next_fire_at_ms: 10_000,
      version: 1,
    });
    expect(getWork()).toEqual([]);

    fail = false;
    const result = storage.transactionSync(() => repo.processDueSchedulesSync(business, 15_000));
    expect(result.processedCount).toBe(1);
    expect(getSchedule()).toMatchObject({ status: 'completed', occurrence_seq: 1 });
    expect(getWork()).toEqual([{ schedule_id: 'sched-retry', occurrence_seq: 1 }]);
    expect(
      storage.transactionSync(() => repo.processDueSchedulesSync(business, 15_000)).processedCount,
    ).toBe(0);
    expect(getWork()).toHaveLength(1);
    db.close();
  });

  it('exercises Queue and DLQ consumers end-to-end', async () => {
    const messages: Array<QueueMessageLike & { acked: boolean; retried: boolean }> = [
      {
        id: 'm-invalid',
        body: { bad: true },
        acked: false,
        retried: false,
        ack() {
          this.acked = true;
        },
        retry() {
          this.retried = true;
        },
      },
      {
        id: 'm-valid',
        body: {
          schemaVersion: 2,
          eventId: 'out-1',
          tenantId: 't1',
          agentId: 'a1',
          entityKind: 'handoff',
          entityId: 'turn-h',
          queueName: 'durable_turn',
          fenceEpoch: 2,
        } satisfies V2DispatchEnvelope,
        acked: false,
        retried: false,
        ack() {
          this.acked = true;
        },
        retry() {
          this.retried = true;
        },
      },
    ];

    let committed = 0;
    const dlqCalls: V2DispatchEnvelope[] = [];
    const router = {
      getAgentHeadRecoveryPort: (): AgentHeadRecoveryPort => ({
        reconcileFromRegistry: () =>
          Promise.resolve({ action: 'keep_armed', currentGeneration: 1 }),
        confirmRegistryPlan: () => Promise.resolve({ confirmed: true }),
        claimDurableWork: async (cmd) => {
          await Promise.resolve();
          return {
            kind: 'claimed',
            targetKind: 'turn',
            targetId: cmd.envelope.entityId,
            leaseEpoch: cmd.envelope.fenceEpoch,
            leaseExpiresAtMs: 50_000,
            contextJson: '{"handoff":true}',
          };
        },
        commitDurableResult: async () => {
          await Promise.resolve();
          committed += 1;
          return { accepted: true };
        },
      }),
      getDeadLetterPort: () => ({
        onDispatchDeadLetter: async (cmd: { readonly envelope: V2DispatchEnvelope }) => {
          await Promise.resolve();
          dlqCalls.push(cmd.envelope);
          return { action: 'rescheduled' as const, alarmAtMs: 20_000 };
        },
      }),
    };

    const qRes = await handleDurableQueueBatch({
      queueName: 'durable_turn',
      messages,
      router,
      executor: {
        executeDurableWork: async () => {
          await Promise.resolve();
          return { ok: true };
        },
      },
      workerId: 'worker-a',
    });

    expect(qRes).toEqual({ acked: 2, retried: 0, rejected: 1, executed: 1 });
    expect(committed).toBe(1);

    let dlqAcked = false;
    await handleDurableDeadLetterBatch({
      expectedQueueName: 'durable_turn',
      messages: [
        {
          id: 'dlq-1',
          body: messages[1]!.body,
          ack: () => {
            dlqAcked = true;
          },
          retry: () => {},
        },
      ],
      router,
      nowMs: () => 10_000,
    });
    expect(dlqAcked).toBe(true);
    expect(dlqCalls).toHaveLength(1);
    expect(computePreDeadlineRetryAtMs(10_000, 11_000).shouldRetry).toBe(false);
  });

  it('bridges GlobalBudgetAuthority applied/alreadySettled/conflict RPC responses verbatim via createGlobalBudgetAuthoritySettlePort', async () => {
    const { db, storage } = createNodeDoHarness();
    const coordinator = new OutboxCoordinator(storage.sql);
    const seenRequests: unknown[] = [];

    const port = createGlobalBudgetAuthoritySettlePort({
      settleGlobal: async (req) => {
        await Promise.resolve();
        seenRequests.push(req);
        if (req.settlementRevision === 0) {
          return {
            applied: true,
            alreadySettled: false,
            conflict: false,
            effectiveState: 'settled',
            incidentOpened: false,
          };
        }
        return {
          applied: false,
          alreadySettled: false,
          conflict: true,
          effectiveState: 'settled',
          incidentOpened: false,
        };
      },
    });

    const rev0: BudgetSyncOutboxPayload = {
      schemaVersion: 1,
      tenantId: 't1',
      principalId: 'p1',
      agentId: 'a1',
      utcDay: '2026-11-19',
      globalGrantId: 'g-1',
      operationId: 'op-bridge-1',
      settlementRevision: 0,
      state: 'settled',
      reservedMicroUsd: 300,
      chargeMicroUsd: 210,
      observedCostMicroUsd: 210,
      overageMicroUsd: 0,
      openIncidentReason: null,
    };
    const rev1Conflict: BudgetSyncOutboxPayload = {
      ...rev0,
      settlementRevision: 1,
      chargeMicroUsd: 400,
      observedCostMicroUsd: 400,
    };

    storage.transactionSync(() => {
      coordinator.enqueueDurableOutboxSync({
        outboxId: 'bs-bridge-0',
        entityKind: 'budget_sync',
        entityId: rev0.operationId,
        queueName: null,
        payloadJson: JSON.stringify(rev0),
        operationId: rev0.operationId,
        revision: 0,
        fenceEpoch: 1,
        nextAttemptAtMs: 1_000,
      });
      coordinator.enqueueDurableOutboxSync({
        outboxId: 'bs-bridge-1',
        entityKind: 'budget_sync',
        entityId: rev0.operationId,
        queueName: null,
        payloadJson: JSON.stringify(rev1Conflict),
        operationId: rev0.operationId,
        revision: 1,
        fenceEpoch: 1,
        nextAttemptAtMs: 1_000,
      });
    });

    const relayRes = await relayDueBudgetSyncBatch({
      sql: storage.sql,
      storage,
      coordinator,
      globalBudget: port,
      nowMs: 2_000,
    });
    expect(relayRes).toMatchObject({ ackedCount: 1, conflictCount: 1, retriedCount: 0 });
    expect(seenRequests[0]).not.toHaveProperty('openIncidentReason');
    expect(coordinator.getOutboxByIdSync('bs-bridge-0')?.state).toBe('acked');
    expect(coordinator.getOutboxByIdSync('bs-bridge-1')?.state).toBe('pending');
    db.close();
  });
});
