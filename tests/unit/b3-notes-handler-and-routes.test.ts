import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  B1TaskDetailDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
  DelegateNotesActionItemsArgsSchema,
  NotesActionItemsInputSchema,
  TaskCommandSchema,
} from '@ember/contracts';
import { DomainError, type LeasedRun } from '@ember/domain';
import {
  DeterministicExecutionRouter,
  createDefaultSentinelPolicy,
  resolveSentinelCategory,
  systemExecutionClock,
  type SentinelPolicy,
} from '@ember/execution';
import {
  MODEL_LIMITS,
  ModelGatewayFailure,
  type ConversationTurnInput,
  type ConversationTurnOutput,
  type ModelBudgetCeilings,
  type ModelCallResult,
  type ModelGateway,
  type ModelRateRow,
  type NotesActionItemsInput,
  type NotesActionItemsOutput,
} from '@ember/model-gateway';
import type {
  B1AssistantTurnDto,
  B1TaskDetailDto,
  B1TaskListDto,
  B1TaskResultDto,
  RunExecutionContext,
} from '@ember/contracts';
import type {
  B1AuthenticatedSession,
  B1ProvisionedSession,
  B1SessionRotationResult,
  B1TaskListQuery,
  B1TaskReadRepository,
  B1TaskResultRepository,
  B2AttemptCharge,
  B2ClaimOutcome,
  B2PublicationResult,
  B2ReserveOutcome,
  B2SettlementOutcome,
  B2TaskDelegationCommand,
  B2TurnContextRow,
  B2TurnLease,
  NotesAttemptCharge,
  NotesCommitCompletionCommand,
  NotesCommitResult,
  NotesReserveAttemptCommand,
  NotesReserveOutcome,
} from '@ember/postgres';
import { createApp } from '../../apps/api/src/app.js';
import type { B1SessionRuntime } from '../../apps/api/src/auth/b1-auth-runtime.js';
import { createSessionService } from '../../apps/api/src/auth/session-service.js';
import { generateSessionToken } from '../../apps/api/src/auth/session-token.js';
import {
  createModelTurnResponder,
  type ModelTurnExecutionPort,
} from '../../apps/worker/src/b1/model-turn-responder.js';
import {
  createNotesTaskHandler,
  type NotesTaskExecutionRepositoryPort,
} from '../../apps/worker/src/notes-task-handler.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const TURN_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const AGENT_ID = '77777777-7777-4777-8777-777777777777';

const TEST_RATE: ModelRateRow = {
  providerId: 'openrouter',
  modelId: 'nvidia/nemotron-3.5-lightning',
  inputMicroUsdPerMillion: 60_000,
  outputMicroUsdPerMillion: 160_000,
  rateVersion: 'test-rate-v1',
  provenance: 'official_price_verified',
  source: 'unit test',
};

const TEST_CEILINGS: ModelBudgetCeilings = {
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
};

const POLICY = {
  baseDelayMs: 100,
  capDelayMs: 1_000,
} as const;

const SILENT_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('B3-A1 contracts, router and sentinel', () => {
  it('validates notes.action_items Task commands and controlled tool arguments', () => {
    const args = DelegateNotesActionItemsArgsSchema.parse({
      title: 'Meeting Action Items',
      notes: '- Alice to update docs\n- Bob to review PR',
      instructions: 'Sort by priority',
    });
    expect(args.title).toBe('Meeting Action Items');

    const parsedInput = NotesActionItemsInputSchema.parse({
      notes: args.notes,
      instructions: args.instructions,
    });
    expect(parsedInput).toEqual({
      notes: args.notes,
      instructions: args.instructions,
    });

    const command = TaskCommandSchema.parse({
      agentId: AGENT_ID,
      kind: 'notes.action_items',
      title: args.title,
      input: parsedInput,
      idempotencyKey: `turn:${TURN_ID}`,
    });
    expect(command.title).toBe('Meeting Action Items');
    expect(DelegateNotesActionItemsArgsSchema.safeParse({ notes: '   ' }).success).toBe(false);
    expect(
      DelegateNotesActionItemsArgsSchema.safeParse({ notes: 'ok', tenant_id: TENANT_ID }).success,
    ).toBe(false);
  });

  it('routes notes.action_items to standard and maps Sentinel category to mock.compute', async () => {
    const decision = await new DeterministicExecutionRouter().decideForExecution({
      policyVersion: 1,
      kind: 'notes.action_items',
      input: { notes: '- Ship release notes' },
    });
    expect(decision).toEqual({
      path: 'standard',
      reason: 'notes_action_items_standard',
      policyVersion: 1,
    });
    expect(resolveSentinelCategory('notes.action_items', 'produce')).toBe('mock.compute');
  });
});

describe('B3-A1 model-turn-responder delegation forwarding', () => {
  function responderRepository() {
    const published: Array<{
      readonly delegation?: B2TaskDelegationCommand;
      readonly text?: string;
    }> = [];
    const repo: ModelTurnExecutionPort = {
      listRunningTurns: () =>
        Promise.resolve([
          { tenantId: TENANT_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID },
        ]),
      expireTurnIfDue: () => Promise.resolve(null),
      claimTurn: () =>
        Promise.resolve<B2ClaimOutcome>({
          kind: 'claimed',
          lease: {
            tenantId: TENANT_ID,
            conversationId: CONVERSATION_ID,
            turnId: TURN_ID,
            leaseEpoch: 1,
            leaseOwner: 'worker-1',
            deadlineAt: new Date(Date.now() + 30_000).toISOString(),
            leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
          } satisfies B2TurnLease,
        }),
      loadTurnContext: () =>
        Promise.resolve<readonly B2TurnContextRow[]>([
          { sequence: 1, kind: 'user', text: '帮我整理会议笔记' },
        ]),
      reserveAttempt: () =>
        Promise.resolve<B2ReserveOutcome>({
          kind: 'reserved',
          attempt: {
            attemptNo: 1,
            operationId: randomUUID(),
            utcDay: '2026-11-15',
            reservedMicroUsd: 500,
          },
        }),
      markAttemptSent: () => Promise.resolve(true),
      settleAttempt: (_charge: B2AttemptCharge) =>
        Promise.resolve<B2SettlementOutcome>({
          kind: 'applied',
          state: 'settled',
          appliedMicroUsd: 100,
          overageMicroUsd: 0,
          incidentsOpened: 0,
        }),
      publishCompletion: (command) => {
        if (command.result.status !== 'completed') {
          return Promise.resolve<B2PublicationResult>({
            outcome: 'published',
            turn: {
              turn_id: TURN_ID,
              conversation_id: CONVERSATION_ID,
              source_message_id: randomUUID(),
              status: 'failed',
              created_at: '2026-11-15T00:00:00.000Z',
              updated_at: '2026-11-15T00:00:01.000Z',
              response_message_id: null,
              failure_reason: command.result.failureReason,
            } satisfies B1AssistantTurnDto,
          });
        }

        const delegation = command.result.delegation;
        published.push({
          text: command.result.text,
          ...(delegation === undefined ? {} : { delegation }),
        });
        return Promise.resolve<B2PublicationResult>({
          outcome: 'published',
          ...(delegation === undefined ? {} : { delegatedTaskId: TASK_ID }),
          turn: {
            turn_id: TURN_ID,
            conversation_id: CONVERSATION_ID,
            source_message_id: randomUUID(),
            status: 'completed',
            created_at: '2026-11-15T00:00:00.000Z',
            updated_at: '2026-11-15T00:00:01.000Z',
            response_message_id: randomUUID(),
            failure_reason: null,
          } satisfies B1AssistantTurnDto,
        });
      },
    };
    return { repo, published };
  }

  it('forwards controlled tool delegation into publishCompletion and calls onTaskDelegated', async () => {
    const { repo, published } = responderRepository();
    let delegatedHooks = 0;

    const gateway: ModelGateway = {
      providerId: 'openrouter',
      modelLabel: TEST_RATE.modelId,
      simulated: false,
      operations: ['conversation.turn', 'task.notes_action_items'],
      generateConversationTurn(): Promise<ModelCallResult<ConversationTurnOutput>> {
        return Promise.resolve({
          output: {
            kind: 'delegate',
            toolName: 'delegate_notes_action_items',
            text: '我已为你创建整理任务。',
            finishReason: 'stop',
            delegation: {
              toolName: 'delegate_notes_action_items',
              arguments: {
                title: 'Meeting Notes',
                notes: 'Alice to ship API',
                instructions: 'Bullet points',
              },
            },
          },
          modelLabel: TEST_RATE.modelId,
          simulated: false,
          usage: {
            inputTokens: 20,
            outputTokens: 15,
            costMicroUsd: 50,
            rateVersion: TEST_RATE.rateVersion,
          },
        });
      },
      extractNotesActionItems() {
        return Promise.reject(new Error('unused'));
      },
    };

    const summary = await createModelTurnResponder({
      mode: 'real',
      repository: repo,
      gateway,
      workerId: 'worker-1',
      leaseMs: 30_000,
      ceilings: TEST_CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: 5_000,
      rate: TEST_RATE,
      onTaskDelegated: () => {
        delegatedHooks += 1;
      },
    }).processOnce();

    expect(summary.completed).toBe(1);
    expect(delegatedHooks).toBe(1);
    expect(published).toEqual([
      {
        text: '我已为你创建整理任务。',
        delegation: {
          toolName: 'delegate_notes_action_items',
          title: 'Meeting Notes',
          input: {
            notes: 'Alice to ship API',
            instructions: 'Bullet points',
          },
        },
      },
    ]);
  });

  it('keeps normal conversation replies free of task delegation', async () => {
    const { repo, published } = responderRepository();
    let delegatedHooks = 0;

    const gateway: ModelGateway = {
      providerId: 'openrouter',
      modelLabel: TEST_RATE.modelId,
      simulated: false,
      operations: ['conversation.turn', 'task.notes_action_items'],
      generateConversationTurn(
        _input: ConversationTurnInput,
      ): Promise<ModelCallResult<ConversationTurnOutput>> {
        return Promise.resolve({
          output: { kind: 'reply', text: '普通聊天回复', finishReason: 'stop' },
          modelLabel: TEST_RATE.modelId,
          simulated: false,
          usage: {
            inputTokens: 10,
            outputTokens: 8,
            costMicroUsd: 20,
            rateVersion: TEST_RATE.rateVersion,
          },
        });
      },
      extractNotesActionItems() {
        return Promise.reject(new Error('unused'));
      },
    };

    const summary = await createModelTurnResponder({
      mode: 'real',
      repository: repo,
      gateway,
      workerId: 'worker-1',
      leaseMs: 30_000,
      ceilings: TEST_CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: 5_000,
      rate: TEST_RATE,
      onTaskDelegated: () => {
        delegatedHooks += 1;
      },
    }).processOnce();

    expect(summary.completed).toBe(1);
    expect(delegatedHooks).toBe(0);
    expect(published).toEqual([{ text: '普通聊天回复' }]);
  });
});

describe('B3-A1 notes task handler orchestration and safety guards', () => {
  const lease: LeasedRun = {
    tenantId: TENANT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  };

  function makeContext(
    overrides: Partial<{ kind: 'notes.action_items' | 'mock.chat'; input: unknown }> = {},
  ): RunExecutionContext {
    return {
      tenantId: TENANT_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      agentId: AGENT_ID,
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: lease.leaseExpiresAt,
      workerId: 'worker-1',
      policyVersion: 1,
      kind: overrides.kind ?? 'notes.action_items',
      input: (overrides.input ?? {
        notes: 'Alice to verify staging release tomorrow.',
      }) as RunExecutionContext['input'],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  class MemoryNotesRepo implements NotesTaskExecutionRepositoryPort {
    readonly reserved: NotesReserveAttemptCommand[] = [];
    readonly settled: NotesAttemptCharge[] = [];
    readonly committed: NotesCommitCompletionCommand[] = [];
    reserveOutcome: NotesReserveOutcome | null = null;
    markSentResult = true;
    commitResult: NotesCommitResult = {
      outcome: 'committed',
      taskStatus: 'completed',
      runStatus: 'succeeded',
    };
    private attemptCounter = 0;

    reserveAttempt(command: NotesReserveAttemptCommand): Promise<NotesReserveOutcome> {
      this.reserved.push(command);
      if (this.reserveOutcome !== null) {
        return Promise.resolve(this.reserveOutcome);
      }
      this.attemptCounter += 1;
      return Promise.resolve({
        kind: 'reserved',
        attempt: {
          attemptNo: this.attemptCounter,
          operationId: randomUUID(),
          utcDay: '2026-11-15',
          reservedMicroUsd: command.reservedMicroUsd,
        },
      });
    }

    markAttemptSent(): Promise<boolean> {
      return Promise.resolve(this.markSentResult);
    }

    settleAttempt(charge: NotesAttemptCharge): Promise<unknown> {
      this.settled.push(charge);
      return Promise.resolve({ kind: 'applied' });
    }

    commitCompletion(command: NotesCommitCompletionCommand): Promise<NotesCommitResult> {
      this.committed.push(command);
      return Promise.resolve(this.commitResult);
    }
  }

  function makeHandler(
    repo: MemoryNotesRepo,
    script: Array<'ok' | 'usage_null' | 'model_unavailable' | 'model_invalid_output'>,
    overrides: Partial<{ sentinelPolicy: SentinelPolicy }> = {},
  ) {
    const queue = [...script];
    const gateway: ModelGateway = {
      providerId: 'openrouter',
      modelLabel: TEST_RATE.modelId,
      simulated: false,
      operations: ['conversation.turn', 'task.notes_action_items'],
      generateConversationTurn() {
        return Promise.reject(new Error('unused'));
      },
      extractNotesActionItems(
        input: NotesActionItemsInput,
      ): Promise<ModelCallResult<NotesActionItemsOutput>> {
        const next = queue.shift() ?? 'ok';
        if (next === 'model_unavailable' || next === 'model_invalid_output') {
          return Promise.reject(new ModelGatewayFailure(next));
        }
        return Promise.resolve({
          output: {
            summaryText: '1 action item extracted.',
            detailText: `- [ ] Complete notes for ${input.taskId}`,
            truncated: false,
            finishReason: 'stop',
          },
          modelLabel: TEST_RATE.modelId,
          simulated: false,
          usage:
            next === 'usage_null'
              ? null
              : {
                  inputTokens: 80,
                  outputTokens: 30,
                  costMicroUsd: 25,
                  rateVersion: TEST_RATE.rateVersion,
                },
        });
      },
    };

    return createNotesTaskHandler({
      mode: 'real',
      contextReader: { read: () => Promise.resolve(makeContext()) },
      router: new DeterministicExecutionRouter(),
      repository: repo,
      gateway,
      policy: POLICY,
      ceilings: {
        perAttemptMicroUsd: TEST_CEILINGS.perAttemptMicroUsd,
        tenantDailyMicroUsd: TEST_CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: TEST_CEILINGS.globalDailyMicroUsd,
      },
      maxAttemptsPerTask: MODEL_LIMITS.maxModelAttemptsPerTask,
      maxTaskCostMicroUsd: MODEL_LIMITS.maxModelCostPerTaskMicroUsd,
      attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
      rate: TEST_RATE,
      clock: systemExecutionClock,
      logger: SILENT_LOGGER,
      sentinelPolicy:
        overrides.sentinelPolicy ??
        createDefaultSentinelPolicy({
          policyId: 'b3-unit-policy',
          policyVersion: 1,
          tenantId: TENANT_ID,
        }),
    });
  }

  it('retries retryable provider error once, bills unknown_billed then settled, and commits completion', async () => {
    const repo = new MemoryNotesRepo();
    const handler = makeHandler(repo, ['model_unavailable', 'ok']);

    const completion = await handler.handle(lease, new AbortController().signal, makeContext());

    expect(completion.type).toBe('committed');
    expect(repo.settled).toMatchObject([
      { attemptNo: 1, state: 'unknown_billed', outcomeCode: 'model_unavailable' },
      { attemptNo: 2, state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 25 },
    ]);
    expect(repo.committed).toHaveLength(1);
    expect(repo.committed[0]?.summaryText).toBe('1 action item extracted.');
  });

  it('books conservative_billed when provider omits usage and still commits the result', async () => {
    const repo = new MemoryNotesRepo();
    const handler = makeHandler(repo, ['usage_null']);

    const completion = await handler.handle(lease, new AbortController().signal, makeContext());

    expect(completion.type).toBe('committed');
    expect(repo.settled).toMatchObject([
      { attemptNo: 1, state: 'conservative_billed', outcomeCode: 'usage_missing' },
    ]);
    expect(repo.committed).toHaveLength(1);
  });

  it('releases reservation and throws STALE_LEASE when markAttemptSent is fenced', async () => {
    const repo = new MemoryNotesRepo();
    repo.markSentResult = false;
    const handler = makeHandler(repo, ['ok']);

    const err = await handler
      .handle(lease, new AbortController().signal, makeContext())
      .catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('STALE_LEASE');
    expect(repo.settled).toMatchObject([
      { attemptNo: 1, state: 'released', outcomeCode: 'not_sent' },
    ]);
    expect(repo.committed).toHaveLength(0);
  });

  it('fails terminally before egress on budget refusal or malformed notes input', async () => {
    const budgetRepo = new MemoryNotesRepo();
    budgetRepo.reserveOutcome = { kind: 'task_budget_exhausted', reason: 'cost_exceeded' };
    const budgetHandler = makeHandler(budgetRepo, ['ok']);

    await expect(
      budgetHandler.handle(lease, new AbortController().signal, makeContext()),
    ).resolves.toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(budgetRepo.committed).toHaveLength(0);

    const invalidRepo = new MemoryNotesRepo();
    const invalidHandler = makeHandler(invalidRepo, ['ok']);
    await expect(
      invalidHandler.handle(
        lease,
        new AbortController().signal,
        makeContext({ input: { notes: '' } }),
      ),
    ).resolves.toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(invalidRepo.reserved).toHaveLength(0);
  });

  it('returns committed without double-finish when DB commit converges to cancelled or deadline_exceeded', async () => {
    for (const outcome of ['cancelled', 'deadline_exceeded'] as const) {
      const repo = new MemoryNotesRepo();
      repo.commitResult = { outcome };
      const handler = makeHandler(repo, ['ok']);
      const result = await handler.handle(lease, new AbortController().signal, makeContext());
      expect(result.type).toBe('committed');
    }
  });
});

describe('B3-A1 HTTP task routes & auth split', () => {
  const token = generateSessionToken();

  function makeSessionRuntime(): B1SessionRuntime {
    const session = {
      sessionId: randomUUID(),
      consumerId: randomUUID(),
      tenantId: TENANT_ID,
      expiresAt: '2026-12-05T00:00:00.000Z',
      idleExpiresAt: '2026-11-19T00:00:00.000Z',
      revokedAt: null,
    } as const;
    const authenticated: B1AuthenticatedSession = {
      session,
      principalId: PRINCIPAL_ID,
      policyVersion: 1,
    };
    const service = createSessionService({
      ports: {
        provisioning: {
          provisionIdentityAndCreateSession(): Promise<B1ProvisionedSession> {
            return Promise.reject(new Error('unused'));
          },
        },
        sessions: {
          findActiveSession: () => Promise.resolve(authenticated),
          rotateSession: () => Promise.resolve<B1SessionRotationResult>({ kind: 'inactive' }),
          revokeSession: () => Promise.resolve(),
        },
        me: {
          getMeForTenant: () => Promise.resolve(null),
        },
      },
    });
    return {
      service,
      appleVerifier: { provider: 'apple', verify: () => Promise.reject(new Error('unused')) },
      devVerifier: { provider: 'dev', verify: () => Promise.reject(new Error('unused')) },
      devProvider: { evaluate: () => ({ enabled: false, deniedBy: ['opt_in_missing'] }) },
      me: { getMeForTenant: () => Promise.resolve(null) },
    };
  }

  function makeApp() {
    const queries: B1TaskListQuery[] = [];
    const sampleResult: B1TaskResultDto = {
      task_id: TASK_ID,
      task_status: 'completed',
      result_state: 'available',
      result: {
        summary_text: '2 action items found.',
        detail_text: '- [ ] Finish docs (Owner: Alice)',
        model_label: TEST_RATE.modelId,
        simulated: false,
        produced_at: '2026-11-15T00:00:05.000Z',
      },
    };
    const sampleDetail: B1TaskDetailDto = {
      task_id: TASK_ID,
      agent_id: AGENT_ID,
      kind: 'notes.action_items',
      title: 'Weekly Sync',
      status: 'completed',
      attempt_count: 1,
      created_at: '2026-11-15T00:00:00.000Z',
      updated_at: '2026-11-15T00:00:05.000Z',
      deadline_at: '2026-11-15T00:05:00.000Z',
      result_state: 'available',
      result: sampleResult.result,
    };
    const sampleList: B1TaskListDto = {
      tasks: [
        {
          task_id: TASK_ID,
          agent_id: AGENT_ID,
          kind: 'notes.action_items',
          title: 'Weekly Sync',
          status: 'completed',
          attempt_count: 1,
          created_at: '2026-11-15T00:00:00.000Z',
          updated_at: '2026-11-15T00:00:05.000Z',
          deadline_at: '2026-11-15T00:05:00.000Z',
          result_state: 'available',
        },
      ],
    };

    const taskResults: B1TaskResultRepository = {
      getTaskResult: (tenantId, taskId) =>
        Promise.resolve(tenantId === TENANT_ID && taskId === TASK_ID ? sampleResult : null),
    };
    const taskReads: B1TaskReadRepository = {
      listTasks: (tenantId, query) => {
        queries.push(query ?? {});
        return Promise.resolve(tenantId === TENANT_ID ? sampleList : { tasks: [] });
      },
      getTaskDetail: (tenantId, taskId) =>
        Promise.resolve(tenantId === TENANT_ID && taskId === TASK_ID ? sampleDetail : null),
    };

    const app = createApp({
      b1Session: makeSessionRuntime(),
      b1TaskResultRepository: taskResults,
      b1TaskReadRepository: taskReads,
    });
    return { app, queries, sampleList, sampleDetail, sampleResult };
  }

  it('serves /v1/me/tasks, /v1/me/tasks/:taskId, and /v1/tasks/:taskId/result with ems_ session while keeping /v1/tasks/:taskId tenantAuth-gated', async () => {
    const { app, queries, sampleList, sampleDetail, sampleResult } = makeApp();
    const auth = { authorization: `Bearer ${token}` };

    expect((await app.request('/v1/me/tasks')).status).toBe(401);
    expect((await app.request(`/v1/tasks/${TASK_ID}`, { headers: auth })).status).toBe(401);

    const listRes = await app.request('/v1/me/tasks?status=completed&limit=10', { headers: auth });
    expect(listRes.status).toBe(200);
    expect(B1TaskListDtoSchema.parse(await listRes.json())).toEqual(sampleList);
    expect(queries).toEqual([{ status: 'completed', limit: 10 }]);

    const detailRes = await app.request(`/v1/me/tasks/${TASK_ID}`, { headers: auth });
    expect(detailRes.status).toBe(200);
    expect(B1TaskDetailDtoSchema.parse(await detailRes.json())).toEqual(sampleDetail);

    const resultRes = await app.request(`/v1/tasks/${TASK_ID}/result`, { headers: auth });
    expect(resultRes.status).toBe(200);
    expect(B1TaskResultDtoSchema.parse(await resultRes.json())).toEqual(sampleResult);

    const missing = await app.request(`/v1/me/tasks/${randomUUID()}`, { headers: auth });
    expect(missing.status).toBe(404);
  });

  it('rejects malformed UUIDs, client-supplied scope, and invalid list query parameters with 400', async () => {
    const { app } = makeApp();
    const auth = { authorization: `Bearer ${token}` };

    const badStatuses = await Promise.all([
      app.request('/v1/me/tasks/not-a-uuid', { headers: auth }),
      app.request('/v1/tasks/not-a-uuid/result', { headers: auth }),
      app.request(`/v1/me/tasks?tenant_id=${TENANT_ID}`, { headers: auth }),
      app.request('/v1/me/tasks', { headers: { ...auth, 'x-tenant-id': TENANT_ID } }),
      app.request('/v1/me/tasks?status=unknown', { headers: auth }),
      app.request('/v1/me/tasks?limit=0', { headers: auth }),
      app.request('/v1/me/tasks?limit=51', { headers: auth }),
      app.request(`/v1/tasks/${TASK_ID}/result?extra=1`, { headers: auth }),
    ]);

    expect(badStatuses.map((res) => res.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 400]);
  });
});
