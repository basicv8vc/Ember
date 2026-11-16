import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  B1TaskCancelDtoSchema,
  B1TaskDetailDtoSchema,
  B1TaskEventPageDtoSchema,
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
  B1TaskCancelDto,
  B1TaskDetailDto,
  B1TaskEventPageDto,
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
      stepPythonAgent() {
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
      stepPythonAgent() {
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
      stepPythonAgent() {
        return Promise.reject(new Error('unused'));
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
        principalDailyMicroUsd: TEST_CEILINGS.principalDailyMicroUsd,
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

  it('fails terminally before egress on budget refusal, principal unavailability, or malformed notes input', async () => {
    for (const refusal of [
      { kind: 'task_budget_exhausted' as const, reason: 'cost_exceeded' as const },
      { kind: 'budget_exceeded' as const, scope: 'principal' as const },
      { kind: 'principal_unavailable' as const },
    ]) {
      const budgetRepo = new MemoryNotesRepo();
      budgetRepo.reserveOutcome = refusal;
      const budgetHandler = makeHandler(budgetRepo, ['ok']);

      await expect(
        budgetHandler.handle(lease, new AbortController().signal, makeContext()),
      ).resolves.toEqual({ type: 'finish', outcome: 'failed_terminal' });
      expect(budgetRepo.committed).toHaveLength(0);
    }

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

  function makeApp(cancelOutcome?: B1TaskCancelDto) {
    const queries: B1TaskListQuery[] = [];
    const eventAfters: Array<number | undefined> = [];
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
      current_run_id: RUN_ID,
      attempt_count: 1,
      cancel_requested: false,
      created_at: '2026-11-15T00:00:00.000Z',
      updated_at: '2026-11-15T00:00:05.000Z',
      deadline_at: '2026-11-15T00:05:00.000Z',
    };
    const sampleList: B1TaskListDto = {
      tasks: [sampleDetail],
      next_after: null,
      has_more: false,
    };
    const sampleEvents: B1TaskEventPageDto = {
      task_id: TASK_ID,
      events: [
        {
          task_id: TASK_ID,
          sequence: 1,
          phase: 'accepted',
          occurred_at: '2026-11-15T00:00:00.000Z',
          trace_id: TURN_ID,
          payload: {},
        },
        {
          task_id: TASK_ID,
          sequence: 2,
          phase: 'completed',
          occurred_at: '2026-11-15T00:00:05.000Z',
          trace_id: TURN_ID,
          payload: { runId: RUN_ID, attempt: 1 },
        },
      ],
    };
    const sampleCancel: B1TaskCancelDto = cancelOutcome ?? {
      task_id: TASK_ID,
      status: 'cancelled',
      cancel_requested: true,
      cancel_requested_at: '2026-11-15T00:00:06.000Z',
      terminal: true,
      updated_at: '2026-11-15T00:00:06.000Z',
    };

    const taskResults: B1TaskResultRepository = {
      getTaskResult: (tenantId, taskId) =>
        Promise.resolve(tenantId === TENANT_ID && taskId === TASK_ID ? sampleResult : null),
    };
    const taskReads: B1TaskReadRepository = {
      listTasks: (tenantId, query) => {
        queries.push(query ?? {});
        return Promise.resolve(
          tenantId === TENANT_ID ? sampleList : { tasks: [], next_after: null, has_more: false },
        );
      },
      getTaskDetail: (tenantId, taskId) =>
        Promise.resolve(tenantId === TENANT_ID && taskId === TASK_ID ? sampleDetail : null),
      listTaskEvents: (tenantId, taskId, after) => {
        eventAfters.push(after);
        if (tenantId !== TENANT_ID || taskId !== TASK_ID) {
          return Promise.resolve(null);
        }
        const events = sampleEvents.events.filter((e) => e.sequence > (after ?? 0));
        return Promise.resolve({ task_id: TASK_ID, events });
      },
      cancelTask: (tenantId, taskId) =>
        Promise.resolve(tenantId === TENANT_ID && taskId === TASK_ID ? sampleCancel : null),
    };

    const app = createApp({
      b1Session: makeSessionRuntime(),
      b1TaskResultRepository: taskResults,
      b1TaskReadRepository: taskReads,
    });
    return {
      app,
      queries,
      eventAfters,
      sampleList,
      sampleDetail,
      sampleResult,
      sampleEvents,
      sampleCancel,
    };
  }

  it('serves B1/B3 session task routes (including /me/tasks/:id/events, /me/tasks/:id/result, /me/tasks/:id/cancel) while keeping M1 /v1/tasks* tenantAuth-gated', async () => {
    const {
      app,
      queries,
      eventAfters,
      sampleList,
      sampleDetail,
      sampleResult,
      sampleEvents,
      sampleCancel,
    } = makeApp();
    const auth = { authorization: `Bearer ${token}` };

    expect((await app.request('/v1/me/tasks')).status).toBe(401);
    // M1 tenantAuth routes MUST continue rejecting ems_ consumer session tokens with 401.
    expect((await app.request('/v1/tasks', { headers: auth })).status).toBe(401);
    expect((await app.request(`/v1/tasks/${TASK_ID}`, { headers: auth })).status).toBe(401);
    expect((await app.request(`/v1/tasks/${TASK_ID}/events`, { headers: auth })).status).toBe(401);
    expect(
      (await app.request(`/v1/tasks/${TASK_ID}/cancel`, { method: 'POST', headers: auth })).status,
    ).toBe(401);

    const listRes = await app.request('/v1/me/tasks?status=completed&limit=10&after=cursor_abc', {
      headers: auth,
    });
    expect(listRes.status).toBe(200);
    expect(B1TaskListDtoSchema.parse(await listRes.json())).toEqual(sampleList);
    expect(queries).toEqual([{ status: 'completed', limit: 10, after: 'cursor_abc' }]);

    const detailRes = await app.request(`/v1/me/tasks/${TASK_ID}`, { headers: auth });
    expect(detailRes.status).toBe(200);
    expect(B1TaskDetailDtoSchema.parse(await detailRes.json())).toEqual(sampleDetail);

    const eventsRes = await app.request(`/v1/me/tasks/${TASK_ID}/events?after=1`, {
      headers: auth,
    });
    expect(eventsRes.status).toBe(200);
    expect(B1TaskEventPageDtoSchema.parse(await eventsRes.json())).toEqual({
      task_id: TASK_ID,
      events: [sampleEvents.events[1]],
    });
    expect(eventAfters).toEqual([1]);

    const meResultRes = await app.request(`/v1/me/tasks/${TASK_ID}/result`, { headers: auth });
    expect(meResultRes.status).toBe(200);
    expect(B1TaskResultDtoSchema.parse(await meResultRes.json())).toEqual(sampleResult);

    const compatResultRes = await app.request(`/v1/tasks/${TASK_ID}/result`, { headers: auth });
    expect(compatResultRes.status).toBe(200);
    expect(B1TaskResultDtoSchema.parse(await compatResultRes.json())).toEqual(sampleResult);

    const terminalCancelRes = await app.request(`/v1/me/tasks/${TASK_ID}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(terminalCancelRes.status).toBe(200);
    expect(B1TaskCancelDtoSchema.parse(await terminalCancelRes.json())).toEqual(sampleCancel);

    const runningCancelApp = makeApp({
      task_id: TASK_ID,
      status: 'running',
      cancel_requested: true,
      cancel_requested_at: '2026-11-15T00:00:06.000Z',
      terminal: false,
      updated_at: '2026-11-15T00:00:06.000Z',
    });
    const inProgressCancelRes = await runningCancelApp.app.request(
      `/v1/me/tasks/${TASK_ID}/cancel`,
      {
        method: 'POST',
        headers: auth,
      },
    );
    expect(inProgressCancelRes.status).toBe(202);
    expect(B1TaskCancelDtoSchema.parse(await inProgressCancelRes.json())).toMatchObject({
      status: 'running',
      cancel_requested: true,
      terminal: false,
    });

    const missingId = randomUUID();
    expect((await app.request(`/v1/me/tasks/${missingId}`, { headers: auth })).status).toBe(404);
    expect((await app.request(`/v1/me/tasks/${missingId}/events`, { headers: auth })).status).toBe(
      404,
    );
    expect(
      (await app.request(`/v1/me/tasks/${missingId}/cancel`, { method: 'POST', headers: auth }))
        .status,
    ).toBe(404);
  });

  it('rejects malformed UUIDs, client-supplied scope, and invalid query parameters with 400', async () => {
    const { app } = makeApp();
    const auth = { authorization: `Bearer ${token}` };

    const badStatuses = await Promise.all([
      app.request('/v1/me/tasks/not-a-uuid', { headers: auth }),
      app.request('/v1/me/tasks/not-a-uuid/events', { headers: auth }),
      app.request('/v1/me/tasks/not-a-uuid/result', { headers: auth }),
      app.request('/v1/me/tasks/not-a-uuid/cancel', { method: 'POST', headers: auth }),
      app.request('/v1/tasks/not-a-uuid/result', { headers: auth }),
      app.request(`/v1/me/tasks?tenant_id=${TENANT_ID}`, { headers: auth }),
      app.request('/v1/me/tasks', { headers: { ...auth, 'x-tenant-id': TENANT_ID } }),
      app.request('/v1/me/tasks?status=unknown', { headers: auth }),
      app.request('/v1/me/tasks?limit=0', { headers: auth }),
      app.request('/v1/me/tasks?limit=51', { headers: auth }),
      app.request('/v1/me/tasks?after=', { headers: auth }),
      app.request(`/v1/me/tasks/${TASK_ID}/events?after=not-int`, { headers: auth }),
      app.request(`/v1/me/tasks/${TASK_ID}/events?after=-1`, { headers: auth }),
      app.request(`/v1/me/tasks/${TASK_ID}/events?extra=1`, { headers: auth }),
      app.request(`/v1/me/tasks/${TASK_ID}/result?extra=1`, { headers: auth }),
      app.request(`/v1/me/tasks/${TASK_ID}/cancel?extra=1`, { method: 'POST', headers: auth }),
      app.request(`/v1/tasks/${TASK_ID}/result?extra=1`, { headers: auth }),
    ]);

    expect(badStatuses.every((res) => res.status === 400)).toBe(true);
  });
});
