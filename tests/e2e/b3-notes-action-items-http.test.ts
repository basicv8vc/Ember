import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { ServerType } from '@hono/node-server';
import {
  B1AssistantTurnDtoSchema,
  B1ConversationPageSchema,
  B1MeResponseSchema,
  B1SendMessageReceiptSchema,
  B1SessionResponseSchema,
  B1TaskCancelDtoSchema,
  B1TaskDetailDtoSchema,
  B1TaskEventPageDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
} from '@ember/contracts';
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
  type FetchRequestInitLike,
  type FetchResponseLike,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
} from '@ember/model-gateway';
import {
  PostgresLeaseQueue,
  PostgresModelTurnExecutionRepository,
  PostgresNotesTaskExecutionRepository,
  PostgresRunExecutionContextReader,
  loadDatabaseConfig,
  resolveLeaseQueueConfig,
  systemClock,
} from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiConfig } from '../../apps/api/src/env.js';
import { startApiServer } from '../../apps/api/src/index.js';
import { createLogger, type Logger } from '../../apps/api/src/logger.js';
import { createModelTurnResponder } from '../../apps/worker/src/b1/model-turn-responder.js';
import { createCommitmentRouteAwareRunHandler } from '../../apps/worker/src/commitment-run-router.js';
import type { WorkerLogger } from '../../apps/worker/src/logger.js';
import { createNotesTaskHandler } from '../../apps/worker/src/notes-task-handler.js';
import { runPollLoop } from '../../apps/worker/src/poll-loop.js';
import type { RunHandler } from '../../apps/worker/src/run-handler.js';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';

const MODEL_LABEL = 'nvidia/nemotron-3.5-lightning';
const OPENROUTER_RATE: ModelRateRow = {
  providerId: 'openrouter',
  modelId: MODEL_LABEL,
  inputMicroUsdPerMillion: 60_000,
  outputMicroUsdPerMillion: 160_000,
  rateVersion: 'openrouter-b3-e2e-rate',
  provenance: 'official_price_verified',
  source: 'b3 http e2e fixture',
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
const NOTES_PROMPT_TEXT = [
  '帮我把这些会议笔记整理成 Action Items:',
  '1. Alice 周五前完成 API 文档与字段评审',
  '2. Bob 下周一提交压测报告',
].join('\n');

interface SessionDto {
  readonly access_token: string;
  readonly session_id: string;
  readonly consumer_id: string;
  readonly expires_at: string;
}

interface RecordedProviderRequest {
  readonly url: string;
  readonly hasTools: boolean;
  readonly toolChoice: unknown;
}

function assertAddress(server: ServerType): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an internet socket listener');
  }
  return address;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not reserve a loopback port');
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function startLoopbackApi(
  db: TestDatabase,
  databaseUrl: string,
  logger: Logger,
): Promise<{ readonly server: ServerType; readonly baseUrl: string }> {
  const port = await availablePort();
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    EMBER_ENV: 'test',
    EMBER_HOST: '127.0.0.1',
    EMBER_PORT: String(port),
    EMBER_ALLOW_NON_LOOPBACK_BIND: 'false',
    EMBER_DEV_PROVIDER_ENABLED: 'true',
    EMBER_DEV_PROVIDER_ISOLATED: 'true',
    EMBER_APPLE_BUNDLE_ID: 'com.ember.mobile',
    DATABASE_URL: databaseUrl,
  };
  const server = startApiServer({
    pool: db.pool,
    apiConfig: loadApiConfig(env),
    databaseConfig: loadDatabaseConfig(env),
    env,
    logger,
  });
  if (!server.listening) {
    await once(server, 'listening');
  }
  const address = assertAddress(server);
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: ServerType | undefined): Promise<void> {
  if (server === undefined || !server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  (server as HttpServer).closeAllConnections();
  await closed;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function signInDev(baseUrl: string, assertion: string): Promise<SessionDto> {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'dev',
      identity_token: assertion,
      nonce: `nonce-${randomUUID()}`,
    }),
  });
  expect(response.status).toBe(201);
  return B1SessionResponseSchema.parse(await response.json());
}

async function waitForTurnTerminal(
  baseUrl: string,
  token: string,
  conversationId: string,
  turnId: string,
): Promise<ReturnType<typeof B1AssistantTurnDtoSchema.parse>> {
  const deadline = Date.now() + 10_000;
  let latest: ReturnType<typeof B1AssistantTurnDtoSchema.parse> | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/conversations/${conversationId}/turns/${turnId}`, {
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    latest = B1AssistantTurnDtoSchema.parse(await response.json());
    if (latest.status !== 'running') {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`turn ${turnId} did not finish within 10s (latest=${latest?.status})`);
}

async function waitForCompletedTask(
  baseUrl: string,
  token: string,
  taskId: string,
): Promise<{
  readonly detail: ReturnType<typeof B1TaskDetailDtoSchema.parse>;
  readonly result: ReturnType<typeof B1TaskResultDtoSchema.parse>;
}> {
  const deadline = Date.now() + 10_000;
  let latestDetail: ReturnType<typeof B1TaskDetailDtoSchema.parse> | undefined;
  let latestResult: ReturnType<typeof B1TaskResultDtoSchema.parse> | undefined;
  while (Date.now() < deadline) {
    const detailResponse = await fetch(`${baseUrl}/v1/me/tasks/${taskId}`, {
      headers: auth(token),
    });
    expect(detailResponse.status).toBe(200);
    latestDetail = B1TaskDetailDtoSchema.parse(await detailResponse.json());
    if (latestDetail.status === 'completed') {
      const resultResponse = await fetch(`${baseUrl}/v1/me/tasks/${taskId}/result`, {
        headers: auth(token),
      });
      expect(resultResponse.status).toBe(200);
      latestResult = B1TaskResultDtoSchema.parse(await resultResponse.json());
      if (latestResult.result_state === 'available') {
        return { detail: latestDetail, result: latestResult };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(
    `task ${taskId} did not complete within 10s (status=${latestDetail?.status}, result_state=${latestResult?.result_state})`,
  );
}

function jsonFetchResponse(body: unknown): FetchResponseLike {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve(body),
  };
}

const SILENT_WORKER_LOGGER: WorkerLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('B3-A1 E2E: Real HTTP API + PostgreSQL 17 + Worker LLM delegation & durable Notes extraction', () => {
  let db: TestDatabase;
  let databaseUrl: string;
  let apiServer: ServerType | undefined;
  let baseUrl: string;
  let workerStopController: AbortController | undefined;
  let workerLoopsDone: Promise<void> | undefined;
  const apiLogs: string[] = [];
  const providerRequests: RecordedProviderRequest[] = [];
  let logger: Logger;

  beforeAll(async () => {
    databaseUrl = process.env.TEST_DATABASE_URL ?? '';
    if (databaseUrl.length === 0) {
      throw new Error('TEST_DATABASE_URL is required for E2E tests');
    }

    db = await createTestDatabase({ maxConnections: 16 });
    await db.pool.query(
      "DELETE FROM model_global_spend_days WHERE utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date",
    );

    logger = createLogger({ level: 'debug', sink: (_level, line) => apiLogs.push(line) });
    const startedApi = await startLoopbackApi(db, databaseUrl, logger);
    apiServer = startedApi.server;
    baseUrl = startedApi.baseUrl;

    const gateway = new OpenRouterModelGateway({
      apiKey: 'sk-or-test-e2e-b3-key-0123456789abcdef',
      modelId: MODEL_LABEL,
      rate: OPENROUTER_RATE,
      routing: OPENROUTER_ROUTING,
      isAuthorized: () => true,
      fetchImpl: (url: string, init: FetchRequestInitLike) => {
        const parsedBody = JSON.parse(init.body) as {
          readonly tools?: unknown;
          readonly tool_choice?: unknown;
          readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
        };
        const hasTools = Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0;
        providerRequests.push({ url, hasTools, toolChoice: parsedBody.tool_choice ?? null });

        if (!hasTools) {
          // Notes extraction phase
          return Promise.resolve(
            jsonFetchResponse({
              model: MODEL_LABEL,
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      summary: '已从会议笔记中整理出 2 项 Action Items。',
                      action_items: [
                        { action: '完成 API 文档与字段评审', owner: 'Alice', due: '周五前' },
                        { action: '提交压测报告', owner: 'Bob', due: '下周一' },
                      ],
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 110, completion_tokens: 68, cost: 0.000018 },
            }),
          );
        }

        const lastUserMessage =
          [...parsedBody.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        if (lastUserMessage.includes('Action Items') && lastUserMessage.includes('Alice')) {
          return Promise.resolve(
            jsonFetchResponse({
              model: MODEL_LABEL,
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: '好的，我已经创建任务并开始帮你整理这些会议笔记的 Action Items。',
                    tool_calls: [
                      {
                        id: 'call_e2e_delegate_1',
                        type: 'function',
                        function: {
                          name: DELEGATE_NOTES_TOOL_NAME,
                          arguments: JSON.stringify({
                            title: '会议笔记 Action Items',
                            notes: lastUserMessage,
                            instructions: '提取行动项、负责人和截止时间',
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 95, completion_tokens: 52, cost: 0.000014 },
            }),
          );
        }

        return Promise.resolve(
          jsonFetchResponse({
            model: MODEL_LABEL,
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '你好！今天一切正常，随时告诉我需要我帮你做什么。',
                },
              },
            ],
            usage: { prompt_tokens: 28, completion_tokens: 18, cost: 0.000005 },
          }),
        );
      },
    });

    const controller = new AbortController();
    workerStopController = controller;

    const responder = createModelTurnResponder({
      mode: 'real',
      repository: new PostgresModelTurnExecutionRepository(db.pool),
      gateway,
      workerId: 'e2e-turn-worker-1',
      leaseMs: 30_000,
      ceilings: CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: 20_000,
      rate: OPENROUTER_RATE,
      batchSize: 5,
    });

    const leasePolicy = resolveLeaseQueueConfig({
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 5_000,
    });
    const leaseQueue = new PostgresLeaseQueue(db.pool, {
      claimableKinds: ['notes.action_items'],
      leaseDurationMs: leasePolicy.leaseDurationMs,
      heartbeatIntervalMs: leasePolicy.heartbeatIntervalMs,
    });
    const contextReader = new PostgresRunExecutionContextReader(db.pool, systemClock);
    const notesHandler = createNotesTaskHandler({
      mode: 'real',
      contextReader,
      router: new DeterministicExecutionRouter(),
      repository: new PostgresNotesTaskExecutionRepository(db.pool),
      gateway,
      policy: leasePolicy,
      ceilings: CEILINGS,
      maxAttemptsPerTask: MODEL_LIMITS.maxModelAttemptsPerTask,
      maxTaskCostMicroUsd: MODEL_LIMITS.maxModelCostPerTaskMicroUsd,
      attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
      rate: OPENROUTER_RATE,
      clock: systemClock,
      logger: SILENT_WORKER_LOGGER,
      sentinelPolicy: (context) =>
        createDefaultSentinelPolicy({
          policyId: 'b3-e2e-sentinel',
          policyVersion: SENTINEL_POLICY_VERSION,
          tenantId: context.tenantId,
          allowedActions: SAFE_MOCK_ACTION_CATEGORIES,
        }),
    });

    const unusedHandler: RunHandler = {
      handle: () => Promise.resolve({ type: 'finish', outcome: 'failed_terminal' }),
    };

    const routeAwareHandler = createCommitmentRouteAwareRunHandler({
      contextReader,
      clock: systemClock,
      commitmentHandler: unusedHandler,
      notesHandler,
      defaultHandler: unusedHandler,
      logger: SILENT_WORKER_LOGGER,
    });

    const turnLoopPromise = (async () => {
      while (!controller.signal.aborted) {
        await responder.processOnce();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();

    const pollLoopPromise = runPollLoop({
      queue: leaseQueue,
      handler: routeAwareHandler,
      clock: systemClock,
      workerId: 'e2e-task-worker-1',
      concurrency: 1,
      heartbeatIntervalMs: leasePolicy.heartbeatIntervalMs,
      idleIntervalMs: 40,
      errorBackoffMs: 100,
      logger: SILENT_WORKER_LOGGER,
      signal: controller.signal,
    });

    workerLoopsDone = Promise.all([turnLoopPromise, pollLoopPromise]).then(() => undefined);
  }, 30_000);

  afterAll(async () => {
    workerStopController?.abort();
    await workerLoopsDone;
    await closeServer(apiServer);
    await db?.close();
  });

  it('keeps normal chat task-free, delegates notes into durable execution, serves B1 reads after reopen & Q-3 clear, and isolates tenants', async () => {
    const userAIdentity = `dev-user-a-${randomUUID()}`;
    const sessionA = await signInDev(baseUrl, userAIdentity);
    const meAResponse = await fetch(`${baseUrl}/v1/me`, { headers: auth(sessionA.access_token) });
    expect(meAResponse.status).toBe(200);
    const meA = B1MeResponseSchema.parse(await meAResponse.json());
    const conversationId = meA.conversation.conversation_id;

    // 1. Normal chat -> replies normally, creates ZERO tasks.
    const normalSend = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { ...auth(sessionA.access_token), 'content-type': 'application/json' },
      body: JSON.stringify({
        client_submission_id: randomUUID(),
        text: '你好，今天天气怎么样？',
        transcript_epoch: meA.conversation.transcript_epoch,
      }),
    });
    expect(normalSend.status).toBe(201);
    const normalReceipt = B1SendMessageReceiptSchema.parse(await normalSend.json());
    const normalTurn = await waitForTurnTerminal(
      baseUrl,
      sessionA.access_token,
      conversationId,
      normalReceipt.turn.turn_id,
    );
    expect(normalTurn.status).toBe('completed');

    const tasksAfterNormal = await fetch(`${baseUrl}/v1/me/tasks`, {
      headers: auth(sessionA.access_token),
    });
    expect(tasksAfterNormal.status).toBe(200);
    expect(B1TaskListDtoSchema.parse(await tasksAfterNormal.json()).tasks).toEqual([]);

    // 2. Notes prompt -> idempotent submission replay + LLM controlled tool calling -> single Task created.
    const submissionId = randomUUID();
    const notesPayload = JSON.stringify({
      client_submission_id: submissionId,
      text: NOTES_PROMPT_TEXT,
      transcript_epoch: meA.conversation.transcript_epoch,
    });
    const firstSend = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { ...auth(sessionA.access_token), 'content-type': 'application/json' },
      body: notesPayload,
    });
    expect(firstSend.status).toBe(201);
    const firstReceipt = B1SendMessageReceiptSchema.parse(await firstSend.json());

    const replaySend = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { ...auth(sessionA.access_token), 'content-type': 'application/json' },
      body: notesPayload,
    });
    expect(replaySend.status).toBe(200);
    expect(B1SendMessageReceiptSchema.parse(await replaySend.json()).turn.turn_id).toBe(
      firstReceipt.turn.turn_id,
    );

    const delegationTurn = await waitForTurnTerminal(
      baseUrl,
      sessionA.access_token,
      conversationId,
      firstReceipt.turn.turn_id,
    );
    expect(delegationTurn.status).toBe('completed');

    // Read list + extract taskId cleanly via /v1/conversations/.../messages (user, ember, task_reference).
    const listedBeforeWait = B1TaskListDtoSchema.parse(
      await (
        await fetch(`${baseUrl}/v1/me/tasks`, { headers: auth(sessionA.access_token) })
      ).json(),
    );
    expect(listedBeforeWait.tasks).toHaveLength(1);
    const taskId = listedBeforeWait.tasks[0]!.task_id;
    expect(listedBeforeWait.tasks[0]).toMatchObject({
      kind: 'notes.action_items',
      title: '会议笔记 Action Items',
    });

    // 3. Wait for Worker lease queue execution -> task completes & writes Action Items + outcome_reference.
    const completed = await waitForCompletedTask(baseUrl, sessionA.access_token, taskId);
    expect(completed.detail).toMatchObject({
      task_id: taskId,
      kind: 'notes.action_items',
      status: 'completed',
      cancel_requested: false,
    });
    expect(completed.detail.current_run_id).not.toBeNull();
    expect(completed.result).toMatchObject({
      task_id: taskId,
      task_status: 'completed',
      result_state: 'available',
      result: {
        summary_text: '已从会议笔记中整理出 2 项 Action Items。',
        model_label: MODEL_LABEL,
        simulated: false,
      },
    });
    expect(completed.result.result?.detail_text).toContain('Alice');
    expect(completed.result.result?.detail_text).toContain('Bob');

    const resultResp = await fetch(`${baseUrl}/v1/tasks/${taskId}/result`, {
      headers: auth(sessionA.access_token),
    });
    expect(resultResp.status).toBe(200);
    expect(B1TaskResultDtoSchema.parse(await resultResp.json())).toEqual(completed.result);

    const eventsResp = await fetch(`${baseUrl}/v1/me/tasks/${taskId}/events`, {
      headers: auth(sessionA.access_token),
    });
    expect(eventsResp.status).toBe(200);
    const eventsPage = B1TaskEventPageDtoSchema.parse(await eventsResp.json());
    expect(eventsPage.task_id).toBe(taskId);
    expect(eventsPage.events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(['accepted', 'leased', 'started', 'completed']),
    );
    const incrementalEventsResp = await fetch(
      `${baseUrl}/v1/me/tasks/${taskId}/events?after=${eventsPage.events[0]!.sequence}`,
      { headers: auth(sessionA.access_token) },
    );
    expect(incrementalEventsResp.status).toBe(200);
    expect(B1TaskEventPageDtoSchema.parse(await incrementalEventsResp.json()).events).toEqual(
      eventsPage.events.slice(1),
    );

    const terminalCancelResp = await fetch(`${baseUrl}/v1/me/tasks/${taskId}/cancel`, {
      method: 'POST',
      headers: auth(sessionA.access_token),
    });
    expect(terminalCancelResp.status).toBe(200);
    expect(B1TaskCancelDtoSchema.parse(await terminalCancelResp.json())).toMatchObject({
      task_id: taskId,
      status: 'completed',
      terminal: true,
    });

    // Filtered list endpoints & M1 route boundary check
    const filteredCompleted = await fetch(`${baseUrl}/v1/me/tasks?status=completed&limit=10`, {
      headers: auth(sessionA.access_token),
    });
    const completedList = B1TaskListDtoSchema.parse(await filteredCompleted.json());
    expect(completedList.tasks).toHaveLength(1);
    expect(completedList.has_more).toBe(false);
    expect(completedList.next_after).toBeNull();

    const filteredQueued = await fetch(`${baseUrl}/v1/me/tasks?status=queued`, {
      headers: auth(sessionA.access_token),
    });
    expect(B1TaskListDtoSchema.parse(await filteredQueued.json()).tasks).toEqual([]);

    const badTaskResp = await fetch(`${baseUrl}/v1/me/tasks/not-a-uuid`, {
      headers: auth(sessionA.access_token),
    });
    expect(badTaskResp.status).toBe(400);

    // M1 tenant-scoped /v1/tasks* routes MUST continue rejecting ems_ consumer sessions with 401.
    expect(
      (await fetch(`${baseUrl}/v1/tasks`, { headers: auth(sessionA.access_token) })).status,
    ).toBe(401);
    const m1TaskResp = await fetch(`${baseUrl}/v1/tasks/${taskId}`, {
      headers: auth(sessionA.access_token),
    });
    expect(m1TaskResp.status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/v1/tasks/${taskId}/events`, {
          headers: auth(sessionA.access_token),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/v1/tasks/${taskId}/cancel`, {
          method: 'POST',
          headers: auth(sessionA.access_token),
        })
      ).status,
    ).toBe(401);

    // Verify full Conversation timeline includes user -> ember -> task_reference -> outcome_reference.
    const pageResp = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, {
      headers: auth(sessionA.access_token),
    });
    expect(pageResp.status).toBe(200);
    const page = B1ConversationPageSchema.parse(await pageResp.json());
    const kinds = page.messages.map((m) => m.kind);
    expect(kinds).toContain('task_reference');
    expect(kinds).toContain('outcome_reference');
    expect(page.messages.find((m) => m.kind === 'task_reference')).toMatchObject({
      kind: 'task_reference',
      task_id: taskId,
    });
    expect(page.messages.find((m) => m.kind === 'outcome_reference')).toMatchObject({
      kind: 'outcome_reference',
      outcome: {
        outcome_kind: 'meaningful_change',
        task_id: taskId,
        commitment_id: null,
      },
    });

    // Verify closed tool definition was sent on conversation turns and omitted during extraction.
    const turnRequests = providerRequests.filter((req) => req.hasTools);
    const extractRequests = providerRequests.filter((req) => !req.hasTools);
    expect(turnRequests.length).toBeGreaterThanOrEqual(2);
    expect(turnRequests.every((req) => req.toolChoice === 'auto')).toBe(true);
    expect(extractRequests).toHaveLength(1);

    // 4. Simulate App reopen (restart API server) + Q-3 transcript clear -> results remain intact!
    await closeServer(apiServer);
    const restarted = await startLoopbackApi(db, databaseUrl, logger);
    apiServer = restarted.server;
    baseUrl = restarted.baseUrl;

    const reopenedSession = await signInDev(baseUrl, userAIdentity);
    const tenantLookup = await db.pool.query<{ readonly tenant_id: string }>(
      'SELECT tenant_id FROM consumers WHERE id = $1',
      [reopenedSession.consumer_id],
    );
    const tenantAId = tenantLookup.rows[0]!.tenant_id;

    // Q-3: clear transcript on DB; task + action items must stay accessible.
    await db.pool.query(
      'DELETE FROM conversation_messages WHERE tenant_id = $1 AND conversation_id = $2',
      [tenantAId, conversationId],
    );
    await db.pool.query(
      'DELETE FROM assistant_turns WHERE tenant_id = $1 AND conversation_id = $2',
      [tenantAId, conversationId],
    );
    await db.pool.query(
      'UPDATE conversations SET transcript_epoch = transcript_epoch + 1 WHERE tenant_id = $1 AND id = $2',
      [tenantAId, conversationId],
    );

    const clearedMsgsResp = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, {
      headers: auth(reopenedSession.access_token),
    });
    const clearedMsgs = B1ConversationPageSchema.parse(await clearedMsgsResp.json());
    expect(clearedMsgs.transcript_epoch).toBe(1);
    expect(clearedMsgs.messages).toHaveLength(0);

    const reopenedDetail = await fetch(`${baseUrl}/v1/me/tasks/${taskId}`, {
      headers: auth(reopenedSession.access_token),
    });
    expect(reopenedDetail.status).toBe(200);
    expect(B1TaskDetailDtoSchema.parse(await reopenedDetail.json())).toMatchObject({
      task_id: taskId,
      status: 'completed',
    });

    const reopenedMeResult = await fetch(`${baseUrl}/v1/me/tasks/${taskId}/result`, {
      headers: auth(reopenedSession.access_token),
    });
    expect(reopenedMeResult.status).toBe(200);
    expect(
      B1TaskResultDtoSchema.parse(await reopenedMeResult.json()).result?.detail_text,
    ).toContain('Alice');

    const reopenedResult = await fetch(`${baseUrl}/v1/tasks/${taskId}/result`, {
      headers: auth(reopenedSession.access_token),
    });
    expect(reopenedResult.status).toBe(200);
    expect(B1TaskResultDtoSchema.parse(await reopenedResult.json())).toMatchObject({
      task_id: taskId,
      result_state: 'available',
    });

    // 5. Cross-tenant isolation: User B receives [] on list and 404 on User A's Task, Events, Cancel & Result.
    const sessionB = await signInDev(baseUrl, `dev-user-b-${randomUUID()}`);
    const listB = await fetch(`${baseUrl}/v1/me/tasks`, { headers: auth(sessionB.access_token) });
    expect(listB.status).toBe(200);
    expect(B1TaskListDtoSchema.parse(await listB.json())).toEqual({
      tasks: [],
      next_after: null,
      has_more: false,
    });

    const foreignDetail = await fetch(`${baseUrl}/v1/me/tasks/${taskId}`, {
      headers: auth(sessionB.access_token),
    });
    expect(foreignDetail.status).toBe(404);

    expect(
      (
        await fetch(`${baseUrl}/v1/me/tasks/${taskId}/events`, {
          headers: auth(sessionB.access_token),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/v1/me/tasks/${taskId}/result`, {
          headers: auth(sessionB.access_token),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/v1/me/tasks/${taskId}/cancel`, {
          method: 'POST',
          headers: auth(sessionB.access_token),
        })
      ).status,
    ).toBe(404);

    const foreignResult = await fetch(`${baseUrl}/v1/tasks/${taskId}/result`, {
      headers: auth(sessionB.access_token),
    });
    expect(foreignResult.status).toBe(404);
  }, 30_000);
});
