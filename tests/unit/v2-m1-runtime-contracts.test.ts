import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applyAgentHeadMigrations,
  BudgetSyncOutboxPayloadSchema,
  canTransitionTurn,
  checkTaskModelLimits,
  CommitTurnRequestSchema,
  computePreDeadlineRetryAtMs,
  createDefaultAgentHeadMigrations,
  evaluateTurnFence,
  GlobalBudgetReserveRequestSchema,
  GlobalBudgetSettleRequestSchema,
  MigrationChecksumMismatchError,
  OutboxConstraintError,
  parseCommitTurnRequest,
  parsePrepareTurnRequest,
  V2_B1_COMPAT_CONSTANTS,
  V2_BUDGET_LIMITS,
  V2_TIMING_LIMITS,
  V2DispatchEnvelopeSchema,
  validateOutboxEnqueueCommand,
  type AgentHeadMigrationStep,
  type AssistantTurnRow,
  type DurableObjectStorageLike,
  type SqlStorageCursorLike,
  type SqlStorageRow,
} from '@ember/runtime-v2';

function createInMemoryDoStorage(): {
  readonly storage: DurableObjectStorageLike;
  readonly db: DatabaseSync;
} {
  const db = new DatabaseSync(':memory:');
  let inTransaction = false;

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
      return Promise.resolve(null);
    },
    setAlarm(_scheduledTime: number | Date): Promise<void> {
      return Promise.resolve();
    },
    deleteAlarm(): Promise<void> {
      return Promise.resolve();
    },
  };

  return { storage, db };
}

describe('V2-M1-A1 shared runtime contracts, validators & unified migrations', () => {
  it('upgrades existing Agent Head storage for device execution and detects checksum drift', () => {
    const { storage, db } = createInMemoryDoStorage();
    const steps = createDefaultAgentHeadMigrations();
    expect(steps.map((s) => s.version)).toEqual([1, 2, 3]);

    const first = applyAgentHeadMigrations(storage, steps.slice(0, 2), 1_700_000_000_000);
    expect(first.appliedVersions).toEqual([1, 2]);
    expect(first.alreadyAppliedVersions).toEqual([]);

    db.exec(`INSERT INTO tasks
      (id, kind, input_json, digest, idempotency_key, execution_path, next_run_at_ms, created_at_ms, updated_at_ms)
      VALUES ('existing-task', 'mock.compute', '{}', 'digest', 'existing-operation', 'standard', 0, 0, 0)`);

    const upgrade = applyAgentHeadMigrations(storage, steps, 1_700_000_005_000);
    expect(upgrade.appliedVersions).toEqual([3]);
    expect(upgrade.alreadyAppliedVersions).toEqual([1, 2]);
    expect(
      db.prepare("SELECT status, execution_target FROM tasks WHERE id = 'existing-task'").get(),
    ).toEqual({ status: 'queued', execution_target: 'cloud' });

    const replay = applyAgentHeadMigrations(storage, steps, 1_700_000_005_000);
    expect(replay.appliedVersions).toEqual([]);
    expect(replay.alreadyAppliedVersions).toEqual([1, 2, 3]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    for (const required of [
      'agent_head_meta',
      'conversations',
      'conversation_messages',
      'message_attachments',
      'assistant_turns',
      'tasks',
      'runs',
      'task_events',
      'task_results',
      'approvals',
      'model_attempts',
      'agent_spend_days',
      'agent_budget_incidents',
      'v2_schedules',
      'v2_dispatch_outbox',
      'v2_recovery_coverage',
      'device_registrations',
      'device_task_placements',
    ]) {
      expect(names.has(required)).toBe(true);
    }

    const tampered: AgentHeadMigrationStep[] = [
      { version: steps[0]!.version, name: steps[0]!.name, statements: ['SELECT 1'] },
      ...steps.slice(1),
    ];
    expect(() => applyAgentHeadMigrations(storage, tampered, 1_700_000_010_000)).toThrow(
      MigrationChecksumMismatchError,
    );
  });

  it('enforces closed V2DispatchEnvelope & budget_sync outbox constraints (J5)', () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const turnId = randomUUID();
    const outboxId = `turn:${turnId}:epoch:1`;

    const envelope = {
      schemaVersion: 2 as const,
      eventId: outboxId,
      tenantId,
      agentId,
      entityKind: 'turn' as const,
      entityId: turnId,
      queueName: 'durable_turn' as const,
      fenceEpoch: 1,
    };
    expect(V2DispatchEnvelopeSchema.safeParse(envelope).success).toBe(true);

    expect(
      V2DispatchEnvelopeSchema.safeParse({
        ...envelope,
        promptText: 'secret prompt must never pass',
      }).success,
    ).toBe(false);

    expect(() =>
      validateOutboxEnqueueCommand({
        outboxId,
        entityKind: 'turn',
        entityId: turnId,
        queueName: null,
        payloadJson: JSON.stringify(envelope),
        fenceEpoch: 1,
        nextAttemptAtMs: 1_700_000_000_000,
      }),
    ).toThrow(OutboxConstraintError);

    const opId = randomUUID();
    const budgetPayload = {
      schemaVersion: 1 as const,
      tenantId,
      principalId: randomUUID(),
      agentId,
      utcDay: '2026-11-19',
      globalGrantId: 'grant-1',
      operationId: opId,
      settlementRevision: 0,
      state: 'settled' as const,
      reservedMicroUsd: 2_000,
      chargeMicroUsd: 1_250,
      observedCostMicroUsd: 1_250,
      overageMicroUsd: 0,
      openIncidentReason: null,
    };
    expect(BudgetSyncOutboxPayloadSchema.safeParse(budgetPayload).success).toBe(true);

    expect(() =>
      validateOutboxEnqueueCommand({
        outboxId: `budget_sync:${opId}:rev:0`,
        entityKind: 'budget_sync',
        entityId: opId,
        queueName: 'durable_turn',
        payloadJson: JSON.stringify(budgetPayload),
        operationId: opId,
        revision: 0,
        fenceEpoch: 1,
        nextAttemptAtMs: 1_700_000_000_000,
      }),
    ).toThrow(OutboxConstraintError);

    const validBudget = validateOutboxEnqueueCommand({
      outboxId: `budget_sync:${opId}:rev:0`,
      entityKind: 'budget_sync',
      entityId: opId,
      queueName: null,
      payloadJson: JSON.stringify(budgetPayload),
      operationId: opId,
      revision: 0,
      fenceEpoch: 1,
      nextAttemptAtMs: 1_700_000_000_000,
    });
    expect(validBudget.revision).toBe(0);
  });

  it('validates Agent E GlobalBudgetAuthority & Agent F AgentHeadRpc schemas', () => {
    const ids = {
      tenantId: randomUUID(),
      principalId: randomUUID(),
      agentId: randomUUID(),
      operationId: randomUUID(),
      requestId: randomUUID(),
      conversationId: randomUUID(),
      turnId: randomUUID(),
      clientSubmissionId: randomUUID(),
    };

    expect(
      GlobalBudgetReserveRequestSchema.safeParse({
        tenantId: ids.tenantId,
        principalId: ids.principalId,
        agentId: ids.agentId,
        operationId: ids.operationId,
        leaseEpoch: 1,
        utcDay: '2026-11-19',
        amountMicroUsd: 5_000,
        ceilingMicroUsd: V2_BUDGET_LIMITS.globalDailyMicroUsd,
        expiresAtMs: 1_700_000_120_000,
      }).success,
    ).toBe(true);

    // Released settlement must carry chargeMicroUsd=0
    expect(
      GlobalBudgetSettleRequestSchema.safeParse({
        tenantId: ids.tenantId,
        operationId: ids.operationId,
        settlementRevision: 0,
        globalGrantId: 'grant-1',
        state: 'released',
        chargeMicroUsd: 500,
        reservedMicroUsd: 2_000,
      }).success,
    ).toBe(false);

    // PrepareTurnRequest strict schema rejects unknown fields and validates B1 submission
    const prepared = parsePrepareTurnRequest({
      scope: {
        tenantId: ids.tenantId,
        principalId: ids.principalId,
        agentId: ids.agentId,
        policyVersion: 1,
        requestId: ids.requestId,
      },
      conversationId: ids.conversationId,
      request: {
        client_submission_id: ids.clientSubmissionId,
        text: 'Hello V2',
        transcript_epoch: 0,
      },
      workerId: 'edge-worker-1',
      leaseMs: V2_TIMING_LIMITS.sseLeaseDurationMs,
      interactiveDeadlineMs: V2_TIMING_LIMITS.sseInteractiveDeadlineMs,
      turnDeadlineMs: V2_TIMING_LIMITS.sseLongTurnDeadlineMs,
      executionMode: 'fast_interactive',
    });
    expect(prepared.executionMode).toBe('fast_interactive');

    // CommitTurnRequest rejects settled without observedCostMicroUsd
    expect(
      CommitTurnRequestSchema.safeParse({
        scope: { tenantId: ids.tenantId, agentId: ids.agentId },
        conversationId: ids.conversationId,
        turnId: ids.turnId,
        leaseEpoch: 1,
        leaseOwner: 'edge-worker-1',
        attemptNo: 1,
        operationId: ids.operationId,
        settlement: { state: 'settled', outcomeCode: 'ok' },
        result: {
          status: 'completed',
          text: 'hi',
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          simulated: true,
        },
      }).success,
    ).toBe(false);

    const parsedCommit = parseCommitTurnRequest({
      scope: { tenantId: ids.tenantId, agentId: ids.agentId },
      conversationId: ids.conversationId,
      turnId: ids.turnId,
      leaseEpoch: 1,
      leaseOwner: 'edge-worker-1',
      attemptNo: 1,
      operationId: ids.operationId,
      settlement: {
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 1_100,
        inputTokens: 100,
        outputTokens: 50,
      },
      result: {
        status: 'completed',
        text: 'hi',
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
      },
    });
    expect(parsedCommit.settlement.observedCostMicroUsd).toBe(1_100);
  });

  it('enforces Turn FSM, 4D fencing, pre-deadline retry edges (0/500/1000/1001ms), and Task limits', () => {
    expect(canTransitionTurn('running', 'completed')).toBe(true);
    expect(canTransitionTurn('completed', 'cancelled')).toBe(false);
    expect(canTransitionTurn('failed', 'running')).toBe(false);

    const baseTurn: AssistantTurnRow = {
      id: 't1',
      conversation_id: 'c1',
      source_message_id: 'm1',
      response_message_id: null,
      status: 'running',
      failure_reason: null,
      execution_mode: 'fast_interactive',
      deadline_at_ms: 100_000,
      interactive_deadline_ms: 90_000,
      lease_epoch: 2,
      lease_owner: 'worker-a',
      lease_expires_at_ms: 80_000,
      claim_count: 1,
      cancel_requested_at_ms: null,
      provider_job_handle: null,
      handoff_reason: null,
      linked_task_id: null,
      created_at_ms: 50_000,
      updated_at_ms: 50_000,
    };

    expect(evaluateTurnFence(baseTurn, 2, 'worker-a', 79_999).ok).toBe(true);
    expect(evaluateTurnFence(baseTurn, 1, 'worker-a', 79_999)).toEqual({
      ok: false,
      reason: 'fenced',
    });
    expect(evaluateTurnFence(baseTurn, 2, 'worker-b', 79_999)).toEqual({
      ok: false,
      reason: 'fenced',
    });
    expect(evaluateTurnFence(baseTurn, 2, 'worker-a', 80_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      evaluateTurnFence({ ...baseTurn, cancel_requested_at_ms: 60_000 }, 2, 'worker-a', 70_000),
    ).toEqual({
      ok: false,
      reason: 'cancelled',
    });

    // P2 boundary: remaining = 0 / 500 / 1_000 ms disallow retry; 1_001 ms yields now < next < deadline
    for (const rem of [0, 500, 1_000]) {
      const d = computePreDeadlineRetryAtMs(60_000 - rem, 60_000);
      expect(d.shouldRetry).toBe(false);
      if (!d.shouldRetry) {
        expect(d.alarmAtMs).toBe(60_000);
      }
    }
    const edge = computePreDeadlineRetryAtMs(60_000 - 1_001, 60_000);
    expect(edge.shouldRetry).toBe(true);
    if (edge.shouldRetry) {
      expect(edge.nextAttemptAtMs).toBe(59_999);
      expect(edge.nextAttemptAtMs).toBeGreaterThan(58_999);
      expect(edge.nextAttemptAtMs).toBeLessThan(60_000);
    }

    // V1 Task cumulative ceilings
    expect(
      checkTaskModelLimits({
        taskKind: 'notes.action_items',
        existingTaskAttempts: 4,
        existingRunAttempts: 0,
        existingTaskCostMicroUsd: 1_000,
        candidateReserveMicroUsd: 500,
      }),
    ).toEqual({ allowed: false, reason: 'attempts_exhausted' });

    expect(
      checkTaskModelLimits({
        taskKind: 'notes.action_items',
        existingTaskAttempts: 2,
        existingRunAttempts: 1,
        existingTaskCostMicroUsd: 18_000,
        candidateReserveMicroUsd: 2_001,
      }),
    ).toEqual({ allowed: false, reason: 'cost_ceiling_exceeded' });

    expect(
      checkTaskModelLimits({
        taskKind: 'python.agent',
        existingTaskAttempts: 4,
        existingRunAttempts: 4,
        existingTaskCostMicroUsd: 5_000,
        candidateReserveMicroUsd: 500,
      }),
    ).toEqual({ allowed: false, reason: 'attempts_exhausted' });

    expect(
      checkTaskModelLimits({
        taskKind: 'python.agent',
        existingTaskAttempts: 5,
        existingRunAttempts: 1,
        existingTaskCostMicroUsd: 28_000,
        candidateReserveMicroUsd: 2_500,
      }),
    ).toEqual({ allowed: false, reason: 'cost_ceiling_exceeded' });
  });
});
