import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ModelGatewayFailure,
  PROACTIVE_SCHEDULE_CREATE_SYSTEM_INSTRUCTION,
} from '@ember/model-gateway';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  PROACTIVE_SCHEDULE_INVALID_REPLY,
  toAgentHeadDurableCommitOutcome,
  type DurableObjectStorageLike,
  type GlobalBudgetAuthority,
  type ProactiveScheduleList,
  type QueueLike,
  type RecoveryRegistryPort,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type V2DispatchEnvelope,
} from '@ember/runtime-v2';
import { describe, expect, it } from 'vitest';
import {
  CREATE_PROACTIVE_SCHEDULE_TOOL_NAME,
  buildConversationTurnMessages,
  getConversationTools,
  parseConversationTurnChoice,
} from '../../packages/model-gateway/src/providers/shared.js';

function createInMemoryDoStorage(onExec?: (query: string) => void) {
  const db = new DatabaseSync(':memory:');
  let inTransaction = false;
  let currentAlarm: number | null = null;

  const storage: DurableObjectStorageLike = {
    sql: {
      exec<T extends SqlStorageRow = SqlStorageRow>(
        query: string,
        ...bindings: unknown[]
      ): SqlStorageCursorLike<T> {
        onExec?.(query);
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
            if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}`);
            return rows[0]!;
          },
          rowsRead: rows.length,
          rowsWritten: isReader ? 0 : 1,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      if (inTransaction) return closure();
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
    getAlarm: () => Promise.resolve(currentAlarm),
    setAlarm: (time) => {
      currentAlarm = typeof time === 'number' ? time : time.getTime();
      return Promise.resolve();
    },
    deleteAlarm: () => {
      currentAlarm = null;
      return Promise.resolve();
    },
  };

  return { db, storage, getAlarm: () => currentAlarm };
}

function createFakeRegistry(): {
  readonly registry: RecoveryRegistryPort;
  readonly upsertCount: () => number;
} {
  const state = new Map<string, { generation: number; recoveryAtMs: number }>();
  let upserts = 0;
  return {
    upsertCount: () => upserts,
    registry: {
      upsertCoverage(cmd) {
        upserts += 1;
        const key = `${cmd.tenantId}:${cmd.agentId}`;
        const existing = state.get(key);
        if (existing === undefined || cmd.generation > existing.generation) {
          state.set(key, { generation: cmd.generation, recoveryAtMs: cmd.recoveryAtMs });
        } else if (cmd.generation === existing.generation) {
          existing.recoveryAtMs = Math.min(existing.recoveryAtMs, cmd.recoveryAtMs);
        }
        const cur = state.get(key)!;
        return Promise.resolve({
          accepted: cur.generation === cmd.generation && cur.recoveryAtMs <= cmd.recoveryAtMs,
          currentGeneration: cur.generation,
          actualRecoveryAtMs: cur.recoveryAtMs,
        });
      },
      postponeCoverage(cmd) {
        const key = `${cmd.tenantId}:${cmd.agentId}`;
        const existing = state.get(key);
        if (existing === undefined || existing.generation !== cmd.expectedPrevGen) {
          return Promise.resolve({
            updated: false,
            currentGeneration: existing?.generation ?? 0,
            actualRecoveryAtMs: existing?.recoveryAtMs ?? null,
          });
        }
        state.set(key, { generation: cmd.newGeneration, recoveryAtMs: cmd.nextRecoveryAtMs });
        return Promise.resolve({
          updated: true,
          currentGeneration: cmd.newGeneration,
          actualRecoveryAtMs: cmd.nextRecoveryAtMs,
        });
      },
      retireCoverage(cmd) {
        const key = `${cmd.tenantId}:${cmd.agentId}`;
        const existing = state.get(key);
        if (existing !== undefined && existing.generation <= cmd.retireUpToGen) {
          state.delete(key);
          return Promise.resolve({ retired: true });
        }
        return Promise.resolve({ retired: false });
      },
      getCoverage(cmd) {
        const key = `${cmd.tenantId}:${cmd.agentId}`;
        const existing = state.get(key);
        if (existing === undefined) {
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
          currentGeneration: existing.generation,
          actualRecoveryAtMs: existing.recoveryAtMs,
          status: 'armed',
          retryNotBeforeMs: null,
        });
      },
    },
  };
}

function createNoopBudget(): GlobalBudgetAuthority {
  return {
    reserveGlobal: () =>
      Promise.resolve({ kind: 'reserved', globalGrantId: randomUUID(), replayed: false }),
    authorizeGlobalSend: () =>
      Promise.resolve({ authorized: true, startBeforeMs: Date.now() + 60_000 }),
    renewGlobalGrant: () => Promise.resolve({ renewed: true, state: 'reserved' }),
    settleGlobal: () =>
      Promise.resolve({
        applied: true,
        alreadySettled: false,
        conflict: false,
        effectiveState: 'settled',
        incidentOpened: false,
      }),
  };
}

function createHarness(
  initialNowMs = Date.parse('2026-11-20T08:00:00.000Z'),
  onExec?: (query: string) => void,
) {
  let now = initialNowMs;
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const principalId = randomUUID();
  const conversationId = randomUUID();
  const { storage, getAlarm } = createInMemoryDoStorage(onExec);
  const { registry, upsertCount } = createFakeRegistry();
  const globalBudget = createNoopBudget();
  const sent: V2DispatchEnvelope[] = [];
  const queue: QueueLike<V2DispatchEnvelope> = {
    send: (body) => {
      sent.push(body);
      return Promise.resolve();
    },
  };

  let events!: AgentEventRuntimeFacade;
  const core: AgentHeadCore = new AgentHeadCore({
    storage,
    tenantId,
    agentId,
    recoveryRegistry: registry,
    globalBudget,
    nowMs: () => now,
    eventRuntimeFactory(business) {
      events = new AgentEventRuntimeFacade({ storage, tenantId, agentId, business });
      return {
        recoveryAdmission: events.coverage,
        eventCoordinator: events.outbox,
        recoveryHooks: events.asTurnRecoveryHooks({
          globalBudget: {
            settleGlobal: (req) => core.createGlobalBudgetSettlePort().settleGlobal(req),
          },
        }),
      };
    },
  });

  core.bootstrapHead({ conversationId });

  async function prepareInteractiveTurn(text: string) {
    const workerId = randomUUID();
    const prep = await core.prepareTurn({
      scope: { tenantId, principalId, agentId, requestId: randomUUID(), policyVersion: 1 },
      conversationId,
      request: {
        client_submission_id: randomUUID(),
        text,
        transcript_epoch: 0,
      },
      executionMode: 'fast_interactive',
      workerId,
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-m1',
        maxAttempts: 1,
        estimatedMicroUsd: 10,
      },
    });
    if (prep.kind !== 'prepared') throw new Error('expected prepared turn');
    const auth = await core.markAttemptSent({
      scope: { tenantId, agentId },
      subjectType: 'turn',
      subjectId: prep.turnId,
      attemptNo: prep.attemptNo,
      operationId: prep.operationId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: workerId,
    });
    if (!auth.authorized) throw new Error('expected authorized send');
    return { prep, workerId };
  }

  return {
    core,
    events,
    tenantId,
    principalId,
    agentId,
    conversationId,
    getAlarm,
    upsertCount,
    queue,
    sent,
    setNow: (ms: number) => {
      now = ms;
    },
    prepareInteractiveTurn,
  };
}

describe('Agent E — create_proactive_schedule capability gate, V1 safety & atomic fenced commit', () => {
  it('gates create_proactive_schedule strictly to V2 opt-in turns and rejects floating/ambiguous timestamps', () => {
    // Default (V1 / scheduled briefs): tool and instruction are NOT advertised.
    const defaultTools = getConversationTools();
    expect(defaultTools.some((t) => t.function.name === CREATE_PROACTIVE_SCHEDULE_TOOL_NAME)).toBe(
      false,
    );

    const v1Messages = buildConversationTurnMessages({
      conversationId: 'c1',
      turnId: 't1',
      context: [{ role: 'user', text: 'Remind me tomorrow morning' }],
      maxOutputTokens: 256,
    });
    expect(v1Messages[0]?.content).not.toContain(PROACTIVE_SCHEDULE_CREATE_SYSTEM_INSTRUCTION);

    // V2 user-initiated conversation: tool, instruction, and authoritative UTC time are included.
    const v2Tools = getConversationTools({
      allowSavePersonalMemory: true,
      allowCreateProactiveSchedule: true,
    });
    expect(v2Tools.some((t) => t.function.name === CREATE_PROACTIVE_SCHEDULE_TOOL_NAME)).toBe(true);

    const v2Messages = buildConversationTurnMessages({
      conversationId: 'c1',
      turnId: 't1',
      context: [{ role: 'user', text: 'Remind me in 2 hours to call Alex' }],
      enablePersonalMemorySaveTool: true,
      enableProactiveScheduleTool: true,
      currentTimeIso: '2026-11-20T08:00:00.000Z',
      maxOutputTokens: 256,
    });
    expect(v2Messages[0]?.content).toContain(PROACTIVE_SCHEDULE_CREATE_SYSTEM_INSTRUCTION);
    expect(v2Messages[0]?.content).toContain(
      'Authoritative current UTC time: 2026-11-20T08:00:00.000Z.',
    );

    const relativeChoice = {
      finish_reason: 'tool_calls' as const,
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: CREATE_PROACTIVE_SCHEDULE_TOOL_NAME,
              arguments: JSON.stringify({
                kind: 'reminder',
                title: 'Call Alex',
                prompt: 'Call Alex about Q4 invoice',
                trigger_type: 'once',
                fire_at: '2026-11-20T10:00:00-08:00',
              }),
            },
          },
        ],
      },
    };

    // Denied when capability flag is false/omitted (V1 / scheduled brief).
    expect(() => parseConversationTurnChoice(relativeChoice)).toThrow(ModelGatewayFailure);

    // Accepted when explicitly enabled and offset is explicit.
    const parsed = parseConversationTurnChoice(relativeChoice, {
      allowCreateProactiveSchedule: true,
    });
    expect(parsed.kind).toBe('create_schedule');

    // Ambiguous floating timestamp without Z or ±HH:MM offset MUST be rejected.
    expect(() =>
      parseConversationTurnChoice(
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_float',
                type: 'function',
                function: {
                  name: CREATE_PROACTIVE_SCHEDULE_TOOL_NAME,
                  arguments: JSON.stringify({
                    kind: 'reminder',
                    title: 'Call Alex',
                    prompt: 'Call Alex',
                    trigger_type: 'once',
                    fire_at: '2026-11-21T08:00:00',
                  }),
                },
              },
            ],
          },
        },
        { allowCreateProactiveSchedule: true },
      ),
    ).toThrow(ModelGatewayFailure);
  });

  it('commits schedule atomically with fenced turn, blocks cancelled/fenced/cleared turns, and deduplicates retries', async () => {
    const h = createHarness(Date.parse('2026-11-20T08:00:00.000Z'));

    // 1. Happy path: atomic schedule creation + D1 coverage + server-owned confirmation.
    const { prep, workerId } = await h.prepareInteractiveTurn(
      'Prepare my daily morning brief at 8am LA',
    );
    const commitRes = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      attemptNo: prep.attemptNo,
      operationId: prep.operationId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: workerId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 10 },
      result: {
        status: 'completed',
        text: 'Model-generated unverified text',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        proactiveScheduleCreate: {
          kind: 'brief',
          title: 'Morning Brief',
          prompt: 'Summarize my priorities for today.',
          triggerType: 'cron',
          cronExpr: '0 8 * * *',
          timezone: 'America/Los_Angeles',
        },
      },
    });
    expect(commitRes.outcome).toBe('published');
    expect(h.upsertCount()).toBeGreaterThan(0);
    expect(h.getAlarm()).not.toBeNull();

    const list1 = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
    })) as ProactiveScheduleList;
    expect(list1.schedules).toHaveLength(1);
    expect(list1.schedules[0]?.title).toBe('Morning Brief');

    // Duplicate commit replay does NOT create a second schedule.
    const dupCommit = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      attemptNo: prep.attemptNo,
      operationId: prep.operationId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: workerId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 10 },
      result: {
        status: 'completed',
        text: 'Duplicate',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        proactiveScheduleCreate: {
          kind: 'brief',
          title: 'Morning Brief',
          prompt: 'Summarize my priorities for today.',
          triggerType: 'cron',
          cronExpr: '0 8 * * *',
          timezone: 'America/Los_Angeles',
        },
      },
    });
    expect(dupCommit.outcome).toBe('fenced');
    const listAfterDup = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
    })) as ProactiveScheduleList;
    expect(listAfterDup.schedules).toHaveLength(1);

    // 2. Cancellation between provider result and commit -> ZERO new schedule created.
    const cancelledTurn = await h.prepareInteractiveTurn('Remind me in 1 hour');
    await h.core.cancelTurn({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      turnId: cancelledTurn.prep.turnId,
    });
    const cancelCommit = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: cancelledTurn.prep.turnId,
      attemptNo: cancelledTurn.prep.attemptNo,
      operationId: cancelledTurn.prep.operationId,
      leaseEpoch: cancelledTurn.prep.leaseEpoch,
      leaseOwner: cancelledTurn.workerId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 10 },
      result: {
        status: 'completed',
        text: 'Scheduled',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        proactiveScheduleCreate: {
          kind: 'reminder',
          title: 'Must Not Exist After Cancel',
          prompt: 'Should never persist',
          triggerType: 'once',
          fireAt: '2026-11-20T09:00:00.000Z',
        },
      },
    });
    expect(cancelCommit.outcome).toBe('fenced');

    // 3. Stale lease fence -> ZERO new schedule created.
    const fencedTurn = await h.prepareInteractiveTurn('Remind me in 2 hours');
    const fencedCommit = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: fencedTurn.prep.turnId,
      attemptNo: fencedTurn.prep.attemptNo,
      operationId: fencedTurn.prep.operationId,
      leaseEpoch: fencedTurn.prep.leaseEpoch + 99,
      leaseOwner: fencedTurn.workerId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 10 },
      result: {
        status: 'completed',
        text: 'Scheduled',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        proactiveScheduleCreate: {
          kind: 'reminder',
          title: 'Must Not Exist When Fenced',
          prompt: 'Should never persist',
          triggerType: 'once',
          fireAt: '2026-11-20T10:00:00.000Z',
        },
      },
    });
    expect(fencedCommit.outcome).toBe('fenced');

    // 4. Invalid timezone inside commit -> ZERO new schedule created, truthful error reply.
    const invalidTzCommit = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: fencedTurn.prep.turnId,
      attemptNo: fencedTurn.prep.attemptNo,
      operationId: fencedTurn.prep.operationId,
      leaseEpoch: fencedTurn.prep.leaseEpoch,
      leaseOwner: fencedTurn.workerId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 10 },
      result: {
        status: 'completed',
        text: 'False success text',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        proactiveScheduleCreate: {
          kind: 'brief',
          title: 'Bad TZ',
          prompt: 'Invalid tz',
          triggerType: 'cron',
          cronExpr: '0 8 * * *',
          timezone: 'Mars/Olympus',
        },
      },
    });
    expect(invalidTzCommit.outcome).toBe('published');

    const finalList = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
    })) as ProactiveScheduleList;
    expect(finalList.schedules).toHaveLength(1);

    const msgs = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 20,
    });
    const lastMsg = msgs.messages.at(-1);
    expect(lastMsg?.kind === 'ember' ? lastMsg.text : null).toBe(PROACTIVE_SCHEDULE_INVALID_REPLY);

    // 5. Malformed durable schedule payload fails the turn instead of silently dropping the schedule.
    const badDurable = toAgentHeadDurableCommitOutcome({
      targetKind: 'turn',
      context: {
        entityKind: 'turn',
        entityId: randomUUID(),
        operationId: 'op-1',
        attemptNo: 1,
        sendState: 'sent',
        sendAuthorizingAtMs: Date.now() - 100,
        sendStartedAtMs: Date.now() - 50,
        providerJobHandle: 'h-1',
        deadlineAtMs: Date.now() + 60_000,
      },
      outcome: {
        status: 'succeeded',
        operationId: 'op-1',
        providerJobHandle: 'h-1',
        outputJson: JSON.stringify({
          text: 'False success',
          proactiveScheduleCreate: {
            kind: 'reminder',
            title: 'Floating time',
            prompt: 'Missing offset',
            triggerType: 'once',
            fireAt: '2026-11-21T08:00:00',
          },
        }),
        errorCode: null,
        usage: { inputTokens: 5, outputTokens: 5, costMicroUsd: 10 },
      },
    });
    expect(badDurable['status']).toBe('failed');
  });

  it('rejects past once/explicit firstFireAt on Fast Path & Durable Path while preserving idempotent replays', async () => {
    const h = createHarness(Date.parse('2026-11-20T12:00:00.000Z'));

    // 1. Fast Path: past `once` fireAt is rejected truthfully with zero schedules created.
    const fastPast = await h.prepareInteractiveTurn('Remind me at 9am UTC today');
    const fastPastCommit = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: fastPast.prep.turnId,
      attemptNo: fastPast.prep.attemptNo,
      operationId: fastPast.prep.operationId,
      leaseEpoch: fastPast.prep.leaseEpoch,
      leaseOwner: fastPast.workerId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 10 },
      result: {
        status: 'completed',
        text: 'False success',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        proactiveScheduleCreate: {
          kind: 'reminder',
          title: 'Stale Past Reminder',
          prompt: 'Should not fire immediately',
          triggerType: 'once',
          fireAt: '2026-11-20T09:00:00.000Z',
        },
      },
    });
    expect(fastPastCommit.outcome).toBe('published');

    // 2. Durable Path: past explicit `interval.firstFireAt` is rejected truthfully with zero schedules created.
    const durableWorkerId = randomUUID();
    const durablePrep = await h.core.prepareTurn({
      scope: {
        tenantId: h.tenantId,
        principalId: h.principalId,
        agentId: h.agentId,
        requestId: randomUUID(),
        policyVersion: 1,
      },
      conversationId: h.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Check status every hour starting 2 hours ago',
        transcript_epoch: 0,
      },
      executionMode: 'durable_queue',
      workerId: durableWorkerId,
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-m1',
        maxAttempts: 1,
        estimatedMicroUsd: 10,
      },
    });
    if (durablePrep.kind !== 'prepared') throw new Error('expected prepared durable turn');
    await h.events.alarm.runAlarmCycle({
      nowMs: Date.parse('2026-11-20T12:00:00.000Z'),
      queues: { durable_turn: h.queue, agent_task: h.queue },
      globalBudget: {
        settleGlobal: (req) => h.core.createGlobalBudgetSettlePort().settleGlobal(req),
      },
    });
    const turnEnvelope = h.sent.find((env) => env.entityId === durablePrep.turnId);
    if (turnEnvelope === undefined) throw new Error('expected durable turn envelope');
    const claimed = await h.core.claimDurableWork({
      envelope: turnEnvelope,
      workerId: durableWorkerId,
      leaseMs: 30_000,
    });
    if (claimed.kind !== 'claimed') throw new Error('expected claimed durable turn');
    await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: durablePrep.turnId,
      attemptNo: durablePrep.attemptNo,
      operationId: durablePrep.operationId,
      leaseEpoch: claimed.leaseEpoch,
      leaseOwner: durableWorkerId,
    });

    const durableOutcome = toAgentHeadDurableCommitOutcome({
      targetKind: 'turn',
      context: {
        entityKind: 'turn',
        entityId: durablePrep.turnId,
        operationId: durablePrep.operationId,
        attemptNo: durablePrep.attemptNo,
        sendState: 'sent',
        sendAuthorizingAtMs: Date.parse('2026-11-20T12:00:00.000Z'),
        sendStartedAtMs: Date.parse('2026-11-20T12:00:00.000Z'),
        providerJobHandle: 'h-past-durable',
        deadlineAtMs: Date.parse('2026-11-20T12:10:00.000Z'),
      },
      outcome: {
        status: 'succeeded',
        operationId: durablePrep.operationId,
        providerJobHandle: 'h-past-durable',
        outputJson: JSON.stringify({
          text: 'False durable success',
          proactiveScheduleCreate: {
            kind: 'follow_up',
            title: 'Backdated Interval',
            prompt: 'Check status',
            triggerType: 'interval',
            intervalSeconds: 3600,
            fireAt: '2026-11-20T10:00:00.000Z',
          },
        }),
        errorCode: null,
        usage: { inputTokens: 5, outputTokens: 5, costMicroUsd: 10 },
      },
      modelLabel: 'ember-fake-model-gateway-1',
      simulated: true,
    });
    const durableCommit = await h.core.commitDurableResult({
      tenantId: h.tenantId,
      agentId: h.agentId,
      entityType: 'turn',
      entityId: durablePrep.turnId,
      leaseEpoch: claimed.leaseEpoch,
      workerId: durableWorkerId,
      outcome: durableOutcome,
    });
    expect(durableCommit.accepted).toBe(true);

    const schedules = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
    })) as ProactiveScheduleList;
    expect(schedules.schedules).toHaveLength(0);

    const msgs = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 20,
    });
    const emberReplies = msgs.messages.filter((m) => m.kind === 'ember').map((m) => m.text);
    expect(emberReplies).toEqual([
      PROACTIVE_SCHEDULE_INVALID_REPLY,
      PROACTIVE_SCHEDULE_INVALID_REPLY,
    ]);
  });

  it('prevents schedule creation on clearTranscript before commit and rolls back atomically on mid-tx failure then commits once on retry', async () => {
    let failMessageInsertOnce = false;
    let sawProactiveInsert = false;
    const h = createHarness(Date.parse('2026-11-20T08:00:00.000Z'), (query) => {
      if (query.includes('INSERT INTO proactive_schedules')) {
        sawProactiveInsert = true;
      }
      if (
        failMessageInsertOnce &&
        sawProactiveInsert &&
        query.includes('INSERT INTO conversation_messages')
      ) {
        failMessageInsertOnce = false;
        throw new Error('INJECTED_MID_TX_ROLLBACK');
      }
    });

    // 1. clearTranscript before commit -> fenced, zero schedules created.
    const clearedTurn = await h.prepareInteractiveTurn('Remind me in 30 minutes');
    await h.core.clearTranscript({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
    });
    const postClearCommit = await h.core.commitTurn({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: clearedTurn.prep.turnId,
      attemptNo: clearedTurn.prep.attemptNo,
      operationId: clearedTurn.prep.operationId,
      leaseEpoch: clearedTurn.prep.leaseEpoch,
      leaseOwner: clearedTurn.workerId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 10 },
      result: {
        status: 'completed',
        text: 'Scheduled',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        proactiveScheduleCreate: {
          kind: 'reminder',
          title: 'Must Not Persist After Clear',
          prompt: 'Cleared turn',
          triggerType: 'once',
          fireAt: '2026-11-20T08:30:00.000Z',
        },
      },
    });
    expect(postClearCommit.outcome).toBe('fenced');
    const afterClearList = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
    })) as ProactiveScheduleList;
    expect(afterClearList.schedules).toHaveLength(0);

    // 2. Mid-transaction rollback after schedule insert / before assistant message insert:
    //    zero schedules and zero confirmation messages persist; valid retry commits exactly one of each.
    const workerId = randomUUID();
    const prep = await h.core.prepareTurn({
      scope: {
        tenantId: h.tenantId,
        principalId: h.principalId,
        agentId: h.agentId,
        requestId: randomUUID(),
        policyVersion: 1,
      },
      conversationId: h.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Remind me at 9am UTC to review PRs',
        transcript_epoch: 1,
      },
      executionMode: 'fast_interactive',
      workerId,
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-m1',
        maxAttempts: 1,
        estimatedMicroUsd: 10,
      },
    });
    if (prep.kind !== 'prepared') throw new Error('expected prepared turn after clear');
    await h.core.markAttemptSent({
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      subjectType: 'turn',
      subjectId: prep.turnId,
      attemptNo: prep.attemptNo,
      operationId: prep.operationId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: workerId,
    });

    const commitCmd = {
      scope: { tenantId: h.tenantId, agentId: h.agentId },
      conversationId: h.conversationId,
      turnId: prep.turnId,
      attemptNo: prep.attemptNo,
      operationId: prep.operationId,
      leaseEpoch: prep.leaseEpoch,
      leaseOwner: workerId,
      settlement: {
        state: 'settled' as const,
        outcomeCode: 'ok' as const,
        observedCostMicroUsd: 10,
      },
      result: {
        status: 'completed' as const,
        text: 'Unverified model text',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        proactiveScheduleCreate: {
          kind: 'reminder' as const,
          title: 'Review PRs',
          prompt: 'Review open PRs at 9am UTC',
          triggerType: 'once' as const,
          fireAt: '2026-11-20T09:00:00.000Z',
        },
      },
    };

    failMessageInsertOnce = true;
    await expect(h.core.commitTurn(commitCmd)).rejects.toThrow('INJECTED_MID_TX_ROLLBACK');
    expect(sawProactiveInsert).toBe(true);

    // Rolled back: zero schedules and zero ember confirmation messages exist.
    const afterRollbackList = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
    })) as ProactiveScheduleList;
    expect(afterRollbackList.schedules).toHaveLength(0);
    const afterRollbackMsgs = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 10,
    });
    expect(afterRollbackMsgs.messages.filter((m) => m.kind === 'ember')).toHaveLength(0);

    // Retry succeeds atomically: exactly one schedule and one confirmation message.
    const retryRes = await h.core.commitTurn(commitCmd);
    expect(retryRes.outcome).toBe('published');
    const afterRetryList = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: h.tenantId,
      principalId: h.principalId,
      agentId: h.agentId,
      requestId: randomUUID(),
    })) as ProactiveScheduleList;
    expect(afterRetryList.schedules).toHaveLength(1);
    expect(afterRetryList.schedules[0]?.title).toBe('Review PRs');
    const afterRetryMsgs = await h.core.readMessages({
      tenantId: h.tenantId,
      agentId: h.agentId,
      conversationId: h.conversationId,
      after: 0,
      limit: 10,
    });
    const emberAfterRetry = afterRetryMsgs.messages.filter((m) => m.kind === 'ember');
    expect(emberAfterRetry).toHaveLength(1);
    expect(emberAfterRetry[0]?.kind === 'ember' ? emberAfterRetry[0].text : '').toContain(
      'Scheduled "Review PRs"',
    );
  });
});
