import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  B1TaskCancelDtoSchema,
  B1TaskDetailDtoSchema,
  B1TaskEventPageDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
} from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import {
  DeterministicExecutionRouter,
  createDefaultSentinelPolicy,
  SAFE_MOCK_ACTION_CATEGORIES,
  SENTINEL_POLICY_VERSION,
} from '@ember/execution';
import {
  DELEGATE_NOTES_TOOL_NAME,
  MODEL_LIMITS,
  OpenRouterModelGateway,
  type FetchLike,
  type FetchResponseLike,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
} from '@ember/model-gateway';
import {
  PostgresB1ConversationReadRepository,
  PostgresB1ConversationWriteRepository,
  PostgresB1TaskReadRepository,
  PostgresLeaseQueue,
  PostgresModelTurnExecutionRepository,
  PostgresNotesTaskExecutionRepository,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
  resolveLeaseQueueConfig,
  systemClock,
} from '@ember/postgres';
import { createModelTurnResponder } from '../../apps/worker/src/b1/model-turn-responder.js';
import type { WorkerLogger } from '../../apps/worker/src/logger.js';
import { createNotesTaskHandler } from '../../apps/worker/src/notes-task-handler.js';
import { backendPid, createTestDatabase, type TestDatabase } from './support/database.js';

const MODEL_LABEL = 'nvidia/nemotron-3.5-lightning';
const OPENROUTER_RATE: ModelRateRow = {
  providerId: 'openrouter',
  modelId: MODEL_LABEL,
  inputMicroUsdPerMillion: 60_000,
  outputMicroUsdPerMillion: 160_000,
  rateVersion: 'openrouter-b3-it-rate',
  provenance: 'official_price_verified',
  source: 'b3 postgres integration test',
  reasoningEffort: 'none',
  promptCacheMode: 'explicit',
};
const OPENROUTER_ROUTING: OpenRouterRoutingPolicy = Object.freeze({
  only: ['deepinfra'],
  allowFallbacks: false,
  dataCollection: 'deny',
  zdr: true,
  requireParameters: true,
});
const CEILINGS = {
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
};
const warnLogs: Array<{ readonly message: string; readonly fields?: unknown }> = [];
const SILENT_LOGGER: WorkerLogger = {
  debug: () => {},
  info: () => {},
  warn: (message, fields) => {
    warnLogs.push({ message, fields });
  },
  error: (message, fields) => {
    warnLogs.push({ message, fields });
  },
};
const SAMPLE_NOTES = [
  '2026-11-15 周会笔记:',
  '- Alice: 周五前完成 OpenAPI Schema 校验',
  '- Bob: 下周一提交压测报告',
  '- Carol: 确认 iOS B3 客户端开关发布时间',
].join('\n');

interface Fixture {
  readonly tenantId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly sourceMessageId: string;
}

let db: TestDatabase;
let writer: PostgresB1ConversationWriteRepository;
let reader: PostgresB1ConversationReadRepository;
let turnRepo: PostgresModelTurnExecutionRepository;
let notesRepo: PostgresNotesTaskExecutionRepository;
let taskReadRepo: PostgresB1TaskReadRepository;
let taskRepo: PostgresTaskRepository;
let contextReader: PostgresRunExecutionContextReader;
let leaseQueue: PostgresLeaseQueue;

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  };
}

function makeOpenRouterGateway(fetchImpl: FetchLike): OpenRouterModelGateway {
  return new OpenRouterModelGateway({
    apiKey: 'sk-or-test-key-integration-b3-0123456789abcdef',
    modelId: MODEL_LABEL,
    rate: OPENROUTER_RATE,
    routing: OPENROUTER_ROUTING,
    isAuthorized: () => true,
    fetchImpl,
  });
}

async function createTurnFixture(text: string): Promise<Fixture> {
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();

  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'b3 it tenant']);
  await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
    principalId,
    tenantId,
  ]);
  await db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
    randomUUID(),
    tenantId,
    principalId,
  ]);
  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, 'Ember'],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );

  const submitted = await writer.submitUserMessage({
    tenantId,
    conversationId,
    request: { client_submission_id: randomUUID(), text, transcript_epoch: 0 },
  });

  return {
    tenantId,
    principalId,
    agentId,
    conversationId,
    turnId: submitted.receipt.turn.turn_id,
    sourceMessageId: submitted.receipt.message.message_id,
  };
}

function makeNotesHandler(
  gateway: OpenRouterModelGateway,
  maxTaskCostMicroUsd: number = MODEL_LIMITS.maxModelCostPerTaskMicroUsd,
) {
  return createNotesTaskHandler({
    mode: 'real',
    contextReader,
    router: new DeterministicExecutionRouter(),
    repository: notesRepo,
    gateway,
    policy: resolveLeaseQueueConfig({ leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000 }),
    ceilings: CEILINGS,
    maxAttemptsPerTask: MODEL_LIMITS.maxModelAttemptsPerTask,
    maxTaskCostMicroUsd,
    attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
    rate: OPENROUTER_RATE,
    clock: systemClock,
    logger: SILENT_LOGGER,
    sentinelPolicy: (context) =>
      createDefaultSentinelPolicy({
        policyId: 'b3-it-sentinel',
        policyVersion: SENTINEL_POLICY_VERSION,
        tenantId: context.tenantId,
        allowedActions: SAFE_MOCK_ACTION_CATEGORIES,
      }),
  });
}

async function clearGlobalSpend(): Promise<void> {
  await db.pool.query(
    "DELETE FROM model_global_spend_days WHERE utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date",
  );
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 16 });
  const version = await db.pool.query<{ readonly server_version_num: string }>(
    'SHOW server_version_num',
  );
  const versionNumber = Number(version.rows[0]?.server_version_num ?? 0);
  expect(versionNumber).toBeGreaterThanOrEqual(170000);
  expect(versionNumber).toBeLessThan(180000);

  writer = new PostgresB1ConversationWriteRepository(db.pool);
  reader = new PostgresB1ConversationReadRepository(db.pool);
  turnRepo = new PostgresModelTurnExecutionRepository(db.pool);
  notesRepo = new PostgresNotesTaskExecutionRepository(db.pool);
  taskReadRepo = new PostgresB1TaskReadRepository(db.pool);
  taskRepo = new PostgresTaskRepository(db.pool);
  contextReader = new PostgresRunExecutionContextReader(db.pool, systemClock);
  leaseQueue = new PostgresLeaseQueue(db.pool, {
    claimableKinds: ['notes.action_items'],
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
  });
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('B3-A1 PostgreSQL 17 integration: migration 0020, atomic delegation, durable execution & isolation', () => {
  it('verifies migration 0020 schema extensions and constraints', async () => {
    const columns = await db.observerPool.query<{
      readonly table_name: string;
      readonly column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = $1
          AND (
            (table_name = 'tasks' AND column_name = 'title')
            OR (table_name = 'model_budget_incidents' AND column_name = 'task_id')
            OR (table_name = 'task_model_attempts' AND column_name IN ('task_id', 'attempt_no', 'state', 'applied_cost_micro_usd'))
          )`,
      [db.schema],
    );
    const colSet = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    expect(colSet.has('tasks.title')).toBe(true);
    expect(colSet.has('model_budget_incidents.task_id')).toBe(true);
    expect(colSet.has('task_model_attempts.task_id')).toBe(true);
    expect(colSet.has('task_model_attempts.attempt_no')).toBe(true);
    expect(colSet.has('task_model_attempts.state')).toBe(true);
    expect(colSet.has('task_model_attempts.applied_cost_micro_usd')).toBe(true);

    const indexes = await db.observerPool.query<{ readonly indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'conversation_messages_outcome_task_unique'`,
      [db.schema],
    );
    expect(indexes.rows).toHaveLength(1);
  });

  it('atomically creates queued task, accepted event, ember reply and task_reference without duplicating on retry', async () => {
    await clearGlobalSpend();
    const fixture = await createTurnFixture(
      `帮我把这些会议笔记整理成 Action Items:\n${SAMPLE_NOTES}`,
    );

    const gateway = makeOpenRouterGateway(() =>
      Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '好的，我已开始帮你整理这些会议笔记的 Action Items。',
                tool_calls: [
                  {
                    id: 'call_delegate_1',
                    type: 'function',
                    function: {
                      name: DELEGATE_NOTES_TOOL_NAME,
                      arguments: JSON.stringify({
                        title: '周会 Action Items 整理',
                        notes: SAMPLE_NOTES,
                        instructions: '提取负责人与截止时间',
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 45, cost: 0.000012 },
        }),
      ),
    );

    const delegatedEvents: Array<{ readonly taskId: string }> = [];
    const responder = createModelTurnResponder({
      mode: 'real',
      repository: turnRepo,
      gateway,
      workerId: 'worker-b3-it-1',
      leaseMs: 30_000,
      ceilings: CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: 20_000,
      rate: OPENROUTER_RATE,
      onlyTurn: {
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: fixture.turnId,
      },
      onTaskDelegated: (event) => {
        delegatedEvents.push({ taskId: event.taskId });
      },
    });

    const summary = await responder.processOnce();
    expect(summary.completed).toBe(1);
    expect(delegatedEvents).toHaveLength(1);
    const taskId = delegatedEvents[0]!.taskId;

    // Retrying the responder scans zero remaining running turns and never creates another task.
    const secondPass = await responder.processOnce();
    expect(secondPass.examined).toBe(0);

    // Even direct publishCompletion with a stale lease is refused by the lease fence.
    const stalePublish = await turnRepo.publishCompletion({
      lease: {
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: fixture.turnId,
        leaseEpoch: 1,
        leaseOwner: 'worker-b3-it-1',
        leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      },
      result: {
        status: 'completed',
        text: 'duplicate attempt',
        modelLabel: MODEL_LABEL,
        simulated: false,
        delegation: {
          toolName: DELEGATE_NOTES_TOOL_NAME,
          title: 'duplicate',
          input: { notes: SAMPLE_NOTES },
        },
      },
    });
    expect(stalePublish).toMatchObject({ outcome: 'fenced', turn: { status: 'completed' } });

    const tasks = await db.observerPool.query<{
      readonly id: string;
      readonly kind: string;
      readonly title: string | null;
      readonly status: string;
      readonly idempotency_key: string;
    }>('SELECT id, kind, title, status, idempotency_key FROM tasks WHERE tenant_id = $1', [
      fixture.tenantId,
    ]);
    expect(tasks.rows).toEqual([
      {
        id: taskId,
        kind: 'notes.action_items',
        title: '周会 Action Items 整理',
        status: 'queued',
        idempotency_key: `turn:${fixture.turnId}`,
      },
    ]);

    const taskEvents = await taskRepo.listEvents(
      { tenantId: fixture.tenantId, principalId: fixture.principalId, policyVersion: 1 },
      taskId,
    );
    expect(taskEvents.map((event) => event.phase)).toEqual(['accepted']);

    const page = await reader.readMessages({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      after: 0,
      limit: 20,
    });
    expect(page.messages.map((msg) => msg.kind)).toEqual(['user', 'ember', 'task_reference']);
    expect(page.messages[2]).toMatchObject({ kind: 'task_reference', task_id: taskId });
  });

  it('keeps normal chat zero-task and rolls back delegation via SAVEPOINT when turn deadline passes', async () => {
    await clearGlobalSpend();
    const normalFixture = await createTurnFixture('你好，今天天气怎么样？');
    const normalGateway = makeOpenRouterGateway(() =>
      Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: '你好！今天一切正常，有什么我可以帮你的？' },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 15, cost: 0.000004 },
        }),
      ),
    );

    const normalResponder = createModelTurnResponder({
      mode: 'real',
      repository: turnRepo,
      gateway: normalGateway,
      workerId: 'worker-b3-normal',
      leaseMs: 30_000,
      ceilings: CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: 20_000,
      rate: OPENROUTER_RATE,
      onlyTurn: {
        tenantId: normalFixture.tenantId,
        conversationId: normalFixture.conversationId,
        turnId: normalFixture.turnId,
      },
    });
    expect((await normalResponder.processOnce()).completed).toBe(1);
    const normalTaskCount = await db.observerPool.query<{ readonly count: string }>(
      'SELECT count(*)::text AS count FROM tasks WHERE tenant_id = $1',
      [normalFixture.tenantId],
    );
    expect(normalTaskCount.rows[0]?.count).toBe('0');

    // Now test expired turn during publishCompletion -> SAVEPOINT rollback leaves zero tasks.
    const expiredFixture = await createTurnFixture(`请整理笔记：\n${SAMPLE_NOTES}`);
    const claim = await turnRepo.claimTurn({
      turn: {
        tenantId: expiredFixture.tenantId,
        conversationId: expiredFixture.conversationId,
        turnId: expiredFixture.turnId,
      },
      workerId: 'worker-b3-expired',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    await db.pool.query(
      `UPDATE assistant_turns
          SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2`,
      [expiredFixture.tenantId, expiredFixture.turnId],
    );

    const published = await turnRepo.publishCompletion({
      lease: claim.lease,
      result: {
        status: 'completed',
        text: 'ack before expiry check',
        modelLabel: MODEL_LABEL,
        simulated: false,
        delegation: {
          toolName: DELEGATE_NOTES_TOOL_NAME,
          title: 'Should roll back',
          input: { notes: SAMPLE_NOTES },
        },
      },
    });
    expect(published.outcome).toBe('fenced');
    expect('delegatedTaskId' in published).toBe(false);

    // And the deadline sweeper converges the expired running turn -> failed(timeout) cleanly.
    const swept = await turnRepo.expireTurnIfDue({
      tenantId: expiredFixture.tenantId,
      conversationId: expiredFixture.conversationId,
      turnId: expiredFixture.turnId,
    });
    expect(swept).toMatchObject({ status: 'failed', failure_reason: 'timeout' });

    const expiredTaskCount = await db.observerPool.query<{ readonly count: string }>(
      'SELECT count(*)::text AS count FROM tasks WHERE tenant_id = $1',
      [expiredFixture.tenantId],
    );
    expect(expiredTaskCount.rows[0]?.count).toBe('0');
  });

  it('executes notes task durably, writes task_results + outcome_reference, enforces Q-3 & tenant isolation', async () => {
    await clearGlobalSpend();
    await db.pool.query(
      "UPDATE tasks SET status = 'cancelled' WHERE status IN ('queued', 'retryable_failed')",
    );
    const fixture = await createTurnFixture(`请整理笔记:\n${SAMPLE_NOTES}`);
    const claim = await turnRepo.claimTurn({
      turn: {
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: fixture.turnId,
      },
      workerId: 'worker-b3-exec',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    const delegated = await turnRepo.publishCompletion({
      lease: claim.lease,
      result: {
        status: 'completed',
        text: '好的，我正在整理笔记中的 Action Items。',
        modelLabel: MODEL_LABEL,
        simulated: false,
        delegation: {
          toolName: DELEGATE_NOTES_TOOL_NAME,
          title: '周会行动项',
          input: { notes: SAMPLE_NOTES },
        },
      },
    });
    expect(delegated.outcome).toBe('published');
    if (delegated.outcome !== 'published' || !delegated.delegatedTaskId) {
      throw new Error('expected published delegation with delegatedTaskId');
    }
    const taskId = delegated.delegatedTaskId;

    // Verify pending result state before worker runs.
    const pendingResult = await taskReadRepo.getTaskResult(fixture.tenantId, taskId);
    expect(B1TaskResultDtoSchema.parse(pendingResult)).toMatchObject({
      task_id: taskId,
      task_status: 'queued',
      result_state: 'pending',
      result: null,
    });

    const lease = await leaseQueue.claimNext('worker-notes-1', new Date(Date.now() + 1_000));
    expect(lease).not.toBeNull();
    expect(lease?.taskId).toBe(taskId);
    if (lease === null) return;

    const gateway = makeOpenRouterGateway(() =>
      Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  summary: '共整理出 3 条周会 Action Items。',
                  action_items: [
                    { action: '完成 OpenAPI Schema 校验', owner: 'Alice', due: '周五前' },
                    { action: '提交压测报告', owner: 'Bob', due: '下周一' },
                    { action: '确认 iOS B3 客户端开关发布时间', owner: 'Carol' },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 75, cost: 0.000019 },
        }),
      ),
    );

    warnLogs.length = 0;
    const handler = makeNotesHandler(gateway);
    const completion = await handler.handle(lease, new AbortController().signal);
    expect(completion.type, JSON.stringify(warnLogs)).toBe('committed');

    // Stale epoch cannot reserve or commit after completion.
    const staleLease = { ...lease, leaseEpoch: lease.leaseEpoch - 1 };
    const staleReserve = await notesRepo.reserveAttempt({
      lease: staleLease,
      ceilings: {
        perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
        principalDailyMicroUsd: CEILINGS.principalDailyMicroUsd,
        tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
      },
      maxAttemptsPerTask: 4,
      maxTaskCostMicroUsd: 20_000,
      reservedMicroUsd: 100,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(staleReserve.kind).toBe('lease_lost');

    // Verify converged task, result, attempt, events, principal spend attribution, and outcome_reference.
    const listDto = B1TaskListDtoSchema.parse(await taskReadRepo.listTasks(fixture.tenantId));
    expect(listDto.next_after).toBeNull();
    expect(listDto.has_more).toBe(false);
    expect(listDto.tasks).toHaveLength(1);
    expect(listDto.tasks[0]).toMatchObject({
      task_id: taskId,
      kind: 'notes.action_items',
      title: '周会行动项',
      status: 'completed',
      current_run_id: lease.runId,
      cancel_requested: false,
    });

    const detailDto = B1TaskDetailDtoSchema.parse(
      await taskReadRepo.getTaskDetail(fixture.tenantId, taskId),
    );
    expect(detailDto).toEqual(listDto.tasks[0]);

    const resultDto = B1TaskResultDtoSchema.parse(
      await taskReadRepo.getTaskResult(fixture.tenantId, taskId),
    );
    expect(resultDto).toMatchObject({
      task_id: taskId,
      task_status: 'completed',
      result_state: 'available',
      result: {
        summary_text: '共整理出 3 条周会 Action Items。',
        model_label: MODEL_LABEL,
        simulated: false,
      },
    });
    expect(resultDto.result?.detail_text).toContain('Alice');

    const eventsPage = B1TaskEventPageDtoSchema.parse(
      await taskReadRepo.listTaskEvents(fixture.tenantId, taskId),
    );
    expect(eventsPage.task_id).toBe(taskId);
    expect(eventsPage.events.length).toBeGreaterThanOrEqual(2);
    const tailEvents = B1TaskEventPageDtoSchema.parse(
      await taskReadRepo.listTaskEvents(fixture.tenantId, taskId, eventsPage.events[0]!.sequence),
    );
    expect(tailEvents.events).toEqual(eventsPage.events.slice(1));

    // Verify Notes task spend was attributed to tenant AND principal daily buckets.
    const spendRows = await db.observerPool.query<{
      readonly scope_kind: string;
      readonly scope_id: string;
      readonly consumed_micro_usd: string;
    }>(
      `SELECT scope_kind, scope_id::text, consumed_micro_usd::text
         FROM model_spend_days
        WHERE tenant_id = $1`,
      [fixture.tenantId],
    );
    expect(spendRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope_kind: 'tenant',
          scope_id: fixture.tenantId,
          consumed_micro_usd: '19',
        }),
        expect.objectContaining({
          scope_kind: 'principal',
          scope_id: fixture.principalId,
          consumed_micro_usd: '19',
        }),
      ]),
    );

    const page = await reader.readMessages({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      after: 0,
      limit: 20,
    });
    expect(page.messages.map((m) => m.kind)).toEqual([
      'user',
      'ember',
      'task_reference',
      'outcome_reference',
    ]);
    expect(page.messages[3]).toMatchObject({
      kind: 'outcome_reference',
      outcome: {
        outcome_kind: 'meaningful_change',
        task_id: taskId,
        commitment_id: null,
      },
    });

    // Cross-tenant isolation: foreign tenant receives [] / null.
    const foreignTenantId = randomUUID();
    expect((await taskReadRepo.listTasks(foreignTenantId)).tasks).toEqual([]);
    expect(await taskReadRepo.getTaskDetail(foreignTenantId, taskId)).toBeNull();
    expect(await taskReadRepo.listTaskEvents(foreignTenantId, taskId)).toBeNull();
    expect(await taskReadRepo.cancelTask(foreignTenantId, taskId)).toBeNull();
    expect(await taskReadRepo.getTaskResult(foreignTenantId, taskId)).toBeNull();

    // Q-3: clearing transcript increments transcript_epoch and deletes messages/turns without touching tasks/results.
    await db.pool.query(
      'DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2',
      [fixture.tenantId, fixture.conversationId],
    );
    await db.pool.query(
      'DELETE FROM assistant_turns WHERE tenant_id = $1 AND conversation_id = $2',
      [fixture.tenantId, fixture.conversationId],
    );
    await db.pool.query(
      'UPDATE conversations SET transcript_epoch = transcript_epoch + 1 WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, fixture.conversationId],
    );
    const afterClear = await reader.readMessages({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      after: 0,
      limit: 20,
    });
    expect(afterClear.transcript_epoch).toBe(1);
    expect(afterClear.messages).toHaveLength(0);
    expect((await taskReadRepo.listTasks(fixture.tenantId)).tasks).toHaveLength(1);
    expect(await taskReadRepo.getTaskDetail(fixture.tenantId, taskId)).toMatchObject({
      task_id: taskId,
      status: 'completed',
    });
    expect(await taskReadRepo.getTaskResult(fixture.tenantId, taskId)).toMatchObject({
      task_id: taskId,
      result_state: 'available',
    });
  });

  it('recovers from retryable model failure, enforces per-task attempt/cost caps, and honors cooperative cancellation', async () => {
    await clearGlobalSpend();
    await db.pool.query(
      "UPDATE tasks SET status = 'cancelled' WHERE status IN ('queued', 'retryable_failed')",
    );
    const fixture = await createTurnFixture('整理笔记重试测试');
    const authCtx = {
      tenantId: fixture.tenantId,
      principalId: fixture.principalId,
      policyVersion: 1,
    };
    const created = await taskRepo.create(authCtx, {
      agentId: fixture.agentId,
      kind: 'notes.action_items',
      title: 'Retry Budget Test',
      input: { notes: SAMPLE_NOTES },
      idempotencyKey: `retry-it-${randomUUID()}`,
    });

    const lease1 = await leaseQueue.claimNext('worker-retry-1', new Date(Date.now() + 1_000));
    expect(lease1?.taskId).toBe(created.taskId);
    if (lease1 === null) return;

    // Simulate attempt 1 -> 503 retryable, attempt 2 -> 200 missing usage -> conservative_billed + committed.
    let callNo = 0;
    const retryGateway = makeOpenRouterGateway(() => {
      callNo += 1;
      if (callNo === 1) {
        return Promise.resolve(
          jsonResponse({ error: { message: 'upstream temporary outage' } }, 503),
        );
      }
      return Promise.resolve(
        jsonResponse({
          model: MODEL_LABEL,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  summary: '重试后成功提取 Action Items。',
                  action_items: [{ action: '跟进修复', owner: 'Alice' }],
                }),
              },
            },
          ],
          // Intentionally omit usage -> handler settles conservative_billed
        }),
      );
    });

    warnLogs.length = 0;
    const completion = await makeNotesHandler(retryGateway).handle(
      lease1,
      new AbortController().signal,
    );
    expect(completion.type, JSON.stringify(warnLogs)).toBe('committed');

    const attempts = await db.observerPool.query<{
      readonly attempt_no: number;
      readonly state: string;
      readonly outcome_code: string;
    }>(
      `SELECT attempt_no, state, outcome_code
         FROM task_model_attempts
        WHERE tenant_id = $1 AND task_id = $2
        ORDER BY attempt_no ASC`,
      [fixture.tenantId, created.taskId],
    );
    expect(attempts.rows).toEqual([
      { attempt_no: 1, state: 'unknown_billed', outcome_code: 'model_unavailable' },
      { attempt_no: 2, state: 'conservative_billed', outcome_code: 'usage_missing' },
    ]);

    // Reconcile the earlier usage_missing incident from retryGateway so we isolate cooperative cancellation & cost cap.
    await db.pool.query(
      "UPDATE model_budget_incidents SET resolved_at = clock_timestamp(), resolved_by = 'it-operator', resolution_note = 'reconciled' WHERE tenant_id = $1 AND resolved_at IS NULL",
      [fixture.tenantId],
    );

    // Cooperative cancel test on a second task using B1 session cancelTask (running -> 202 semantics).
    const cancelTask = await taskRepo.create(authCtx, {
      agentId: fixture.agentId,
      kind: 'notes.action_items',
      input: { notes: SAMPLE_NOTES },
      idempotencyKey: `cancel-it-${randomUUID()}`,
    });
    const cancelLease = await leaseQueue.claimNext('worker-cancel-1', new Date(Date.now() + 1_000));
    expect(cancelLease?.taskId).toBe(cancelTask.taskId);
    if (cancelLease === null) return;

    const cancelAccepted = B1TaskCancelDtoSchema.parse(
      await taskReadRepo.cancelTask(fixture.tenantId, cancelTask.taskId),
    );
    expect(cancelAccepted).toMatchObject({
      task_id: cancelTask.taskId,
      status: 'running',
      cancel_requested: true,
      terminal: false,
    });
    const neverCalledGateway = makeOpenRouterGateway(() =>
      Promise.reject(new Error('should not call provider when cancelled')),
    );
    const cancelCompletion = await makeNotesHandler(neverCalledGateway).handle(
      cancelLease,
      new AbortController().signal,
    );
    expect(cancelCompletion).toEqual({ type: 'finish', outcome: 'cancelled' });
    expect(await leaseQueue.finish(cancelLease, 'cancelled')).toBe(true);

    const cancelledDetail = B1TaskDetailDtoSchema.parse(
      await taskReadRepo.getTaskDetail(fixture.tenantId, cancelTask.taskId),
    );
    expect(cancelledDetail).toMatchObject({
      task_id: cancelTask.taskId,
      status: 'cancelled',
      cancel_requested: true,
    });
    expect(await taskReadRepo.getTaskResult(fixture.tenantId, cancelTask.taskId)).toMatchObject({
      task_id: cancelTask.taskId,
      task_status: 'cancelled',
      result_state: 'unavailable',
      result: null,
    });

    // Also test maxTaskCostMicroUsd, principalDailyMicroUsd, and STALE_LEASE while a run is actively running.
    const costCappedTask = await taskRepo.create(authCtx, {
      agentId: fixture.agentId,
      kind: 'notes.action_items',
      input: { notes: SAMPLE_NOTES },
      idempotencyKey: `cost-cap-it-${randomUUID()}`,
    });
    const capLease = await leaseQueue.claimNext('worker-cap-1', new Date(Date.now() + 1_000));
    expect(capLease?.taskId).toBe(costCappedTask.taskId);
    if (capLease === null) return;

    let staleThrew = false;
    try {
      await makeNotesHandler(neverCalledGateway).handle(
        { ...capLease, leaseEpoch: 999 },
        new AbortController().signal,
      );
    } catch (error) {
      staleThrew = isDomainError(error) && error.code === 'STALE_LEASE';
    }
    expect(staleThrew).toBe(true);

    // Enforces shared principal daily budget ceiling before egress.
    const principalBlocked = await notesRepo.reserveAttempt({
      lease: capLease,
      ceilings: {
        perAttemptMicroUsd: CEILINGS.perAttemptMicroUsd,
        principalDailyMicroUsd: 1,
        tenantDailyMicroUsd: CEILINGS.tenantDailyMicroUsd,
        globalDailyMicroUsd: CEILINGS.globalDailyMicroUsd,
      },
      maxAttemptsPerTask: MODEL_LIMITS.maxModelAttemptsPerTask,
      maxTaskCostMicroUsd: MODEL_LIMITS.maxModelCostPerTaskMicroUsd,
      reservedMicroUsd: 100,
      rateVersion: OPENROUTER_RATE.rateVersion,
      providerId: 'openrouter',
      modelLabel: MODEL_LABEL,
    });
    expect(principalBlocked).toEqual({ kind: 'budget_exceeded', scope: 'principal' });

    const capOutcome = await makeNotesHandler(neverCalledGateway, 1).handle(
      capLease,
      new AbortController().signal,
    );
    expect(capOutcome).toEqual({ type: 'finish', outcome: 'failed_terminal' });
    expect(await leaseQueue.finish(capLease, 'failed_terminal')).toBe(true);

    // Verify B1 queued cancellation + keyset cursor pagination + invalid cursor rejection.
    const queuedTask = await taskRepo.create(authCtx, {
      agentId: fixture.agentId,
      kind: 'notes.action_items',
      title: 'Queued Cancel & Page 4',
      input: { notes: SAMPLE_NOTES },
      idempotencyKey: `queued-cancel-${randomUUID()}`,
    });
    const queuedCancel = B1TaskCancelDtoSchema.parse(
      await taskReadRepo.cancelTask(fixture.tenantId, queuedTask.taskId),
    );
    expect(queuedCancel).toMatchObject({
      task_id: queuedTask.taskId,
      status: 'cancelled',
      cancel_requested: true,
      terminal: true,
    });

    const page1 = B1TaskListDtoSchema.parse(
      await taskReadRepo.listTasks(fixture.tenantId, { limit: 2 }),
    );
    expect(page1.tasks).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_after).not.toBeNull();

    const page2 = B1TaskListDtoSchema.parse(
      await taskReadRepo.listTasks(fixture.tenantId, { limit: 2, after: page1.next_after! }),
    );
    expect(page2.tasks).toHaveLength(2);
    expect(page2.has_more).toBe(false);
    expect(page2.next_after).toBeNull();
    const allIds = [...page1.tasks, ...page2.tasks].map((t) => t.task_id);
    expect(new Set(allIds).size).toBe(4);

    let invalidCursorCode: string | null = null;
    try {
      await taskReadRepo.listTasks(fixture.tenantId, { after: 'not_valid_base64_cursor' });
    } catch (error) {
      if (isDomainError(error)) {
        invalidCursorCode = error.code;
      }
    }
    expect(invalidCursorCode).toBe('INVALID_ARGUMENT');

    // Check connection pool pid sanity helper imported cleanly.
    const client = await db.pool.connect();
    try {
      expect(await backendPid(client)).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });
});
