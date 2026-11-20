import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AgentEventRuntimeFacade,
  applyAgentHeadMigrations,
  computePreDeadlineRetryAtMs,
  EVENT_RECOVERY_DO_MIGRATION,
  executeRecoveredOrFreshDurableWork,
  parseClaimExecutionContext,
  toAgentHeadDurableCommitOutcome,
  validateHandoffTransition,
  type AuthoritativeBusinessPort,
  type DurableObjectStorageLike,
  type DurableProviderExecutorPort,
  type MarkAttemptSentRequest,
  type MarkAttemptSentResult,
  type SqlStorageCursorLike,
  type SqlStorageRow,
} from '@ember/runtime-v2';

function createStorage(): { db: DatabaseSync; storage: DurableObjectStorageLike } {
  const db = new DatabaseSync(':memory:');
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
      one: () => rows[0]!,
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
        const res = closure();
        db.exec('COMMIT');
        return res;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
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

describe('V2-M1-B4 Durable Execution Integration & Handoff Guards', () => {
  it('polls existing providerJobHandle without blind replay and settles uncertain sent requests as unknown_billed', async () => {
    let startCalls = 0;
    let pollCalls = 0;

    const provider: DurableProviderExecutorPort = {
      pollProviderJob: async (cmd) => {
        pollCalls += 1;
        await Promise.resolve();
        return {
          status: 'succeeded',
          operationId: cmd.operationId,
          providerJobHandle: cmd.providerJobHandle,
          outputJson: '{"text":"resumed result"}',
          errorCode: null,
          usage: { inputTokens: 100, outputTokens: 50, costMicroUsd: 320 },
        };
      },
      startProviderJob: async (cmd) => {
        startCalls += 1;
        await Promise.resolve();
        return {
          status: 'succeeded',
          operationId: cmd.operationId,
          providerJobHandle: 'job-fresh-1',
          outputJson: '{"text":"fresh result"}',
          errorCode: null,
          usage: { inputTokens: 80, outputTokens: 20, costMicroUsd: 200 },
        };
      },
    };

    // 1. Existing handle -> MUST ONLY poll, never start a duplicate job
    const polled = await executeRecoveredOrFreshDurableWork({
      context: {
        operationId: 'op-handoff-1',
        entityKind: 'turn',
        entityId: 'turn-1',
        attemptNo: 1,
        sendState: 'sent',
        sendAuthorizingAtMs: 9_000,
        sendStartedAtMs: 10_000,
        deadlineAtMs: 60_000,
        providerJobHandle: 'prov-job-99',
        interactiveHandoff: true,
      },
      provider,
    });
    expect(polled.status).toBe('succeeded');
    expect(polled.operationId).toBe('op-handoff-1');
    expect(pollCalls).toBe(1);
    expect(startCalls).toBe(0);

    // 2. Uncertain outcome (`sendStartedAtMs !== null` && `providerJobHandle === null`) -> NEVER blind replay!
    const uncertain = await executeRecoveredOrFreshDurableWork({
      context: {
        operationId: 'op-uncertain-2',
        entityKind: 'turn',
        entityId: 'turn-2',
        attemptNo: 1,
        sendState: 'sent',
        sendAuthorizingAtMs: 11_000,
        sendStartedAtMs: 12_000,
        deadlineAtMs: 60_000,
        providerJobHandle: null,
      },
      provider,
    });
    expect(uncertain).toMatchObject({
      status: 'unknown_billed',
      operationId: 'op-uncertain-2',
      errorCode: 'UNCERTAIN_OUTCOME_NO_BLIND_REPLAY',
      usage: null,
    });
    expect(pollCalls).toBe(1);
    expect(startCalls).toBe(0);

    // 3. Clean unsent claim -> starts provider job once
    const context = {
      operationId: 'op-fresh-3',
      entityKind: 'task' as const,
      entityId: 'task-3',
      attemptNo: 1,
      sendState: 'unsent' as const,
      sendAuthorizingAtMs: null,
      sendStartedAtMs: null,
      providerJobHandle: null,
      deadlineAtMs: 60_000,
    };
    let authorizationCalls = 0;
    const sendGate = {
      scope: { tenantId: 't1', agentId: 'a1' },
      leaseEpoch: 3,
      leaseOwner: 'worker-1',
      leaseExpiresAtMs: 50_000,
      markAttemptSent: async (req: MarkAttemptSentRequest): Promise<MarkAttemptSentResult> => {
        await Promise.resolve();
        expect(req).toMatchObject({
          operationId: context.operationId,
          subjectId: context.entityId,
          attemptNo: 1,
          leaseEpoch: 3,
          leaseOwner: 'worker-1',
        });
        authorizationCalls += 1;
        return authorizationCalls === 1
          ? { authorized: true, sentAtMs: 15_000, startBeforeMs: 20_000 }
          : { authorized: false, reason: 'already_sent' };
      },
    };
    const fresh = await executeRecoveredOrFreshDurableWork({
      context,
      provider,
      sendGate,
      nowMs: () => 15_000,
    });
    expect(fresh.status).toBe('succeeded');
    expect(startCalls).toBe(1);

    const duplicate = await executeRecoveredOrFreshDurableWork({
      context,
      provider,
      sendGate,
      nowMs: () => 15_000,
    });
    expect(duplicate.status).toBe('unknown_billed');
    const unknown = await executeRecoveredOrFreshDurableWork({
      context: { ...context, sendState: 'authorizing_unknown', sendAuthorizingAtMs: 14_000 },
      provider,
      sendGate,
    });
    expect(unknown.status).toBe('unknown_billed');
    expect(authorizationCalls).toBe(2);
    await expect(executeRecoveredOrFreshDurableWork({ context, provider })).rejects.toThrow(
      'Authoritative durable send gate required',
    );
    const lostAck = await executeRecoveredOrFreshDurableWork({
      context,
      provider,
      nowMs: () => 15_000,
      sendGate: {
        ...sendGate,
        markAttemptSent: () => Promise.reject(new Error('lost ACK')),
      },
    });
    expect(lostAck.status).toBe('unknown_billed');
    expect(startCalls).toBe(1);
  });

  it('validates Fast Path -> Durable Handoff lease/deadline/cancel fencing and preserves original deadlineAtMs', () => {
    // Active renewed lease inside 120s window preserves original 600s deadlineAtMs
    expect(
      validateHandoffTransition({
        status: 'running',
        leaseOwner: 'sse-exec-1',
        callerLeaseOwner: 'sse-exec-1',
        leaseExpiresAtMs: 140_000,
        deadlineAtMs: 600_000,
        cancelRequestedAtMs: null,
        operationId: 'op-fp-1',
        nowMs: 112_000,
      }),
    ).toEqual({
      ok: true,
      preservedDeadlineAtMs: 600_000,
      preservedOperationId: 'op-fp-1',
    });

    // Expired lease rejected (must wait for reaper, cannot launder expired lease via handoff)
    expect(
      validateHandoffTransition({
        status: 'running',
        leaseOwner: 'sse-exec-1',
        callerLeaseOwner: 'sse-exec-1',
        leaseExpiresAtMs: 45_000,
        deadlineAtMs: 600_000,
        cancelRequestedAtMs: null,
        operationId: 'op-fp-1',
        nowMs: 46_000,
      }),
    ).toEqual({ ok: false, code: 'LEASE_EXPIRED' });

    // Cancelled entity, wrong owner, and past total deadline all rejected
    expect(
      validateHandoffTransition({
        status: 'running',
        leaseOwner: 'sse-exec-1',
        callerLeaseOwner: 'sse-exec-1',
        leaseExpiresAtMs: 140_000,
        deadlineAtMs: 600_000,
        cancelRequestedAtMs: 90_000,
        operationId: 'op-fp-1',
        nowMs: 100_000,
      }),
    ).toEqual({ ok: false, code: 'CANCEL_REQUESTED' });

    expect(
      validateHandoffTransition({
        status: 'running',
        leaseOwner: 'sse-exec-1',
        callerLeaseOwner: 'attacker-exec',
        leaseExpiresAtMs: 140_000,
        deadlineAtMs: 600_000,
        cancelRequestedAtMs: null,
        operationId: 'op-fp-1',
        nowMs: 100_000,
      }),
    ).toEqual({ ok: false, code: 'LEASE_OWNER_MISMATCH' });

    expect(
      validateHandoffTransition({
        status: 'running',
        leaseOwner: 'sse-exec-1',
        callerLeaseOwner: 'sse-exec-1',
        leaseExpiresAtMs: 700_000,
        deadlineAtMs: 600_000,
        cancelRequestedAtMs: null,
        operationId: 'op-fp-1',
        nowMs: 600_000,
      }),
    ).toEqual({ ok: false, code: 'DEADLINE_EXPIRED' });

    // All four FI-06 / M1 pre-deadline boundaries: 0 / 500 / 1000 / 1001 ms
    expect(computePreDeadlineRetryAtMs(60_000, 60_000)).toEqual({
      shouldRetry: false,
      alarmAtMs: 60_000,
      remainingMs: 0,
    });
    expect(computePreDeadlineRetryAtMs(59_500, 60_000)).toEqual({
      shouldRetry: false,
      alarmAtMs: 60_000,
      remainingMs: 500,
    });
    expect(computePreDeadlineRetryAtMs(59_000, 60_000)).toEqual({
      shouldRetry: false,
      alarmAtMs: 60_000,
      remainingMs: 1_000,
    });
    expect(computePreDeadlineRetryAtMs(58_999, 60_000)).toEqual({
      shouldRetry: true,
      nextAttemptAtMs: 59_999,
      remainingMs: 1_001,
    });
  });

  it('wires AgentEventRuntimeFacade cleanly around shared ports and Agent A/E seams', async () => {
    const { db, storage } = createStorage();
    const business: AuthoritativeBusinessPort = {
      earliestRequiredDiscoveryAtMsSync: () => null,
      listDueBusinessActionsSync: () => [],
      convergeDueBusinessItemSync: () => {},
      inspectOutboxTargetSync: () => ({
        exists: false,
        targetKind: null,
        targetId: null,
        currentLeaseEpoch: 0,
        deadlineAtMs: 0,
        isTerminal: true,
        cancelRequested: false,
      }),
      materializeScheduleOccurrenceSync: () => {},
    };

    const facade = new AgentEventRuntimeFacade({
      storage,
      tenantId: 't1',
      agentId: 'a1',
      business,
    });
    const inspect = facade.coverage.inspectCoverageSync(50_000, 1_000);
    expect(inspect).toEqual({ kind: 'register', generation: 1, targetAtMs: 50_000 });

    const turnClaimCtx = parseClaimExecutionContext({
      targetKind: 'turn',
      targetId: 'turn-a-1',
      leaseEpoch: 3,
      contextJson: JSON.stringify({
        turnId: 'turn-a-1',
        conversationId: 'conv-1',
        entityKind: 'turn',
        entityId: 'turn-a-1',
        operationId: 'op-a-1',
        attemptNo: 1,
        sendState: 'sent',
        sendStartedAtMs: 10_000,
        sendAuthorizingAtMs: 9_000,
        providerJobHandle: 'handle-a-1',
        deadlineAtMs: 120_000,
        context: [{ role: 'user', text: 'hi' }],
      }),
    });
    expect(turnClaimCtx).toMatchObject({
      operationId: 'op-a-1',
      entityKind: 'turn',
      entityId: 'turn-a-1',
      providerJobHandle: 'handle-a-1',
    });

    const mappedTurn = toAgentHeadDurableCommitOutcome({
      targetKind: 'turn',
      context: turnClaimCtx,
      outcome: {
        status: 'succeeded',
        operationId: turnClaimCtx.operationId,
        providerJobHandle: 'handle-a-1',
        outputJson: JSON.stringify({ text: 'Hello from Fake Provider' }),
        errorCode: null,
        usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 50 },
      },
      modelLabel: 'fake-model',
      simulated: true,
    });
    expect(mappedTurn).toEqual({
      attemptNo: 1,
      operationId: 'op-a-1',
      settlement: {
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 50,
        inputTokens: 10,
        outputTokens: 5,
      },
      status: 'completed',
      text: 'Hello from Fake Provider',
      modelLabel: 'fake-model',
      simulated: true,
    });

    expect(() =>
      parseClaimExecutionContext({
        targetKind: 'turn',
        targetId: 'turn-a-1',
        leaseEpoch: 3,
        contextJson: JSON.stringify({ turnId: 'turn-a-1' }),
      }),
    ).toThrow('Invalid authoritative durable claim context');

    const hooks = facade.asTurnRecoveryHooks({
      globalBudget: {
        settleGlobal: async () => {
          await Promise.resolve();
          return {
            applied: true,
            alreadySettled: false,
            conflict: false,
            effectiveState: 'settled',
            incidentOpened: false,
          };
        },
      },
    });
    expect(hooks.getCoverageRowSync()?.generation).toBe(1);
    await hooks.syncPlatformAlarm(80_000, 1_000);
    await hooks.relayBudgetSync(2_000);
    expect(hooks.getCoverageRowSync()?.armed_alarm_at_ms).toBe(80_000);
    db.close();
  });
});
