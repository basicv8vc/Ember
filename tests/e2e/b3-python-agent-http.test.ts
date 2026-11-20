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
  B3StagedUploadReceiptDtoSchema,
  B3TaskArtifactsListDtoSchema,
} from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { FakeModelGateway, MODEL_LIMITS } from '@ember/model-gateway';
import {
  PostgresByteaBlobStore,
  PostgresLeaseQueue,
  PostgresModelTurnExecutionRepository,
  PostgresPythonAgentExecutionRepository,
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
import { createFakePythonAgentSandboxFactory } from '../../apps/worker/src/b3/fake-python-sandbox.js';
import { createPythonAgentTaskHandler } from '../../apps/worker/src/b3/python-agent-handler.js';
import { createCommitmentRouteAwareRunHandler } from '../../apps/worker/src/commitment-run-router.js';
import type { WorkerLogger } from '../../apps/worker/src/logger.js';
import { runPollLoop } from '../../apps/worker/src/poll-loop.js';
import type { RunHandler } from '../../apps/worker/src/run-handler.js';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';

const CEILINGS = {
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
};

const SALES_CSV = [
  'region,revenue,units',
  'north,120.50,10',
  'south,79.50,5',
  'west,200,15',
].join('\n');

interface SessionDto {
  readonly access_token: string;
  readonly session_id: string;
  readonly consumer_id: string;
  readonly expires_at: string;
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

const SILENT_WORKER_LOGGER: WorkerLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const UNEXPECTED_DEFAULT_HANDLER: RunHandler = {
  handle() {
    return Promise.reject(new Error('unexpected default handler invocation'));
  },
};

describe('Product Alpha F1: bounded data-processing task with downloadable artifact (HTTP E2E)', () => {
  let db: TestDatabase;
  let apiServer: ServerType | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
    if (databaseUrl.length === 0) {
      throw new Error('TEST_DATABASE_URL is required for E2E tests');
    }
    db = await createTestDatabase({ maxConnections: 16 });
    const logger = createLogger({ level: 'error', sink: () => {} });
    const started = await startLoopbackApi(db, databaseUrl, logger);
    apiServer = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    await closeServer(apiServer);
    await db.close();
  });

  it('delegates a CSV analysis task, processes it in a fake sandbox, streams progress events, serves an authorized downloadable artifact, and enforces tenant isolation', async () => {
    const tenantASession = await signInDev(baseUrl, `alpha-f-user-a-${randomUUID()}`);
    const tenantBSession = await signInDev(baseUrl, `alpha-f-user-b-${randomUUID()}`);

    const meRes = await fetch(`${baseUrl}/v1/me`, { headers: auth(tenantASession.access_token) });
    expect(meRes.status).toBe(200);
    const me = B1MeResponseSchema.parse(await meRes.json());

    // 1. Upload bounded CSV dataset.
    const uploadRes = await fetch(`${baseUrl}/v1/me/uploads`, {
      method: 'POST',
      headers: { ...auth(tenantASession.access_token), 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'sales.csv',
        media_type: 'text/csv',
        content: SALES_CSV,
      }),
    });
    expect(uploadRes.status).toBe(201);
    const stagedUpload = B3StagedUploadReceiptDtoSchema.parse(await uploadRes.json());
    expect(stagedUpload.filename).toBe('sales.csv');

    // 2. Send conversation message referencing the uploaded dataset.
    const sendRes = await fetch(`${baseUrl}/v1/conversations/${me.conversation.conversation_id}/messages`, {
      method: 'POST',
      headers: { ...auth(tenantASession.access_token), 'content-type': 'application/json' },
      body: JSON.stringify({
        client_submission_id: randomUUID(),
        text: 'Analyze sales.csv and generate a summary CSV report.',
        transcript_epoch: me.conversation.transcript_epoch,
        attachment_ids: [stagedUpload.upload_id],
      }),
    });
    expect(sendRes.status).toBe(201);
    const receipt = B1SendMessageReceiptSchema.parse(await sendRes.json());

    // 3. Configure FakeModelGateway to delegate `python.agent` and run one bounded script step.
    const gateway = new FakeModelGateway({
      onConversationTurn: () => ({
        kind: 'delegate',
        toolName: 'delegate_python_agent',
        text: 'On it — analyzing sales.csv and generating your downloadable summary report.',
        finishReason: 'stop',
        delegation: {
          toolName: 'delegate_python_agent',
          arguments: {
            title: 'Analyze sales.csv',
            prompt:
              'Compute numeric column summary statistics for sales.csv and save outputs/sales-report.csv.',
            attachmentIds: [stagedUpload.upload_id],
          },
        },
      }),
      onStepPythonAgent: (input) => {
        const hasToolOutput = input.messages.some((m) => m.role === 'tool');
        if (!hasToolOutput) {
          return {
            kind: 'tool_call',
            toolCallId: 'call_analyze_csv_1',
            code: '# output: sales-report.csv\nprint("analyzing sales.csv")\n',
            purpose: 'Aggregate sales.csv numeric columns into sales-report.csv',
            rawArgumentsJson: JSON.stringify({
              code: '# output: sales-report.csv\nprint("analyzing sales.csv")\n',
            }),
          };
        }
        return {
          kind: 'final',
          summaryText: 'Sales summary ready (3 rows, total revenue 400). Download sales-report.csv.',
          detailText:
            'Processed sales.csv (3 rows). Revenue sum=400, mean=133.33; units sum=30, mean=10. Output written to sales-report.csv.',
          truncated: false,
          finishReason: 'stop',
        };
      },
    });

    const stopController = new AbortController();
    const leaseConfig = resolveLeaseQueueConfig({
      leaseDurationMs: 15_000,
      heartbeatIntervalMs: 5_000,
      baseDelayMs: 100,
      capDelayMs: 500,
      reaperBatchSize: 20,
    });
    const queue = new PostgresLeaseQueue(db.pool, {
      ...leaseConfig,
      clock: systemClock,
      claimableKinds: ['python.agent'],
    });

    const pythonAgentHandler = createPythonAgentTaskHandler({
      mode: 'fake',
      leaseQueue: queue,
      repository: new PostgresPythonAgentExecutionRepository(db.pool),
      blobStore: new PostgresByteaBlobStore(db.pool),
      gateway,
      createSandbox: createFakePythonAgentSandboxFactory(),
      sandboxOwner: 'e2e-alpha-f-worker',
      policy: leaseConfig,
      ceilings: CEILINGS,
      rate: null,
      leaseDurationMs: leaseConfig.leaseDurationMs,
      attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
      logger: SILENT_WORKER_LOGGER,
    });

    const routerHandler = createCommitmentRouteAwareRunHandler({
      contextReader: new PostgresRunExecutionContextReader(db.pool, systemClock),
      clock: systemClock,
      commitmentHandler: UNEXPECTED_DEFAULT_HANDLER,
      pythonAgentHandler,
      defaultHandler: UNEXPECTED_DEFAULT_HANDLER,
      logger: SILENT_WORKER_LOGGER,
    });

    const turnResponder = createModelTurnResponder({
      mode: 'fake',
      repository: new PostgresModelTurnExecutionRepository(db.pool),
      gateway,
      workerId: 'e2e-alpha-f-turn',
      leaseMs: 15_000,
      ceilings: CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
      rate: null,
      logger: SILENT_WORKER_LOGGER,
    }).start(stopController.signal);

    const pollPromise = runPollLoop({
      queue,
      handler: routerHandler,
      clock: systemClock,
      workerId: 'e2e-alpha-f-worker',
      concurrency: 1,
      heartbeatIntervalMs: 5_000,
      idleIntervalMs: 50,
      errorBackoffMs: 100,
      logger: SILENT_WORKER_LOGGER,
      signal: stopController.signal,
    });

    try {
      const completedTurn = await waitForTurnTerminal(
        baseUrl,
        tenantASession.access_token,
        me.conversation.conversation_id,
        receipt.turn.turn_id,
      );
      expect(completedTurn.status).toBe('completed');

      // Verify transcript contains the delegated task_reference message.
      const pageRes = await fetch(
        `${baseUrl}/v1/conversations/${me.conversation.conversation_id}/messages`,
        { headers: auth(tenantASession.access_token) },
      );
      expect(pageRes.status).toBe(200);
      const page = B1ConversationPageSchema.parse(await pageRes.json());
      const taskRef = page.messages.find((m) => m.kind === 'task_reference');
      expect(taskRef).toBeDefined();
      const taskId = taskRef!.kind === 'task_reference' ? taskRef!.task_id : '';
      expect(taskId).toBeTruthy();

      // 4. Wait for bounded task completion and verify detail + result + list + events.
      const { detail, result } = await waitForCompletedTask(
        baseUrl,
        tenantASession.access_token,
        taskId,
      );
      expect(detail.kind).toBe('python.agent');
      expect(detail.title).toBe('Analyze sales.csv');
      expect(result.result_state).toBe('available');
      if (result.result_state === 'available') {
        expect(result.result.summary_text).toContain('Sales summary ready');
        expect(result.result.simulated).toBe(true);
      }

      const listRes = await fetch(`${baseUrl}/v1/me/tasks?status=completed`, {
        headers: auth(tenantASession.access_token),
      });
      expect(listRes.status).toBe(200);
      const list = B1TaskListDtoSchema.parse(await listRes.json());
      expect(list.tasks.some((t) => t.task_id === taskId)).toBe(true);

      const eventsRes = await fetch(`${baseUrl}/v1/me/tasks/${taskId}/events`, {
        headers: auth(tenantASession.access_token),
      });
      expect(eventsRes.status).toBe(200);
      const eventsPage = B1TaskEventPageDtoSchema.parse(await eventsRes.json());
      const phases = eventsPage.events.map((e) => e.phase);
      expect(phases).toContain('accepted');
      expect(phases).toContain('leased');
      expect(phases).toContain('completed');

      // 5. List task artifacts and download the generated CSV report.
      const artifactsRes = await fetch(`${baseUrl}/v1/me/tasks/${taskId}/artifacts`, {
        headers: auth(tenantASession.access_token),
      });
      expect(artifactsRes.status).toBe(200);
      const artifactsList = B3TaskArtifactsListDtoSchema.parse(await artifactsRes.json());
      const outputArtifact = artifactsList.artifacts.find(
        (a) => a.created_by === 'run' && a.filename === 'sales-report.csv',
      );
      expect(outputArtifact).toBeDefined();
      expect(outputArtifact!.media_type).toBe('text/csv');

      const downloadRes = await fetch(
        `${baseUrl}/v1/me/artifacts/${outputArtifact!.artifact_id}`,
        { headers: auth(tenantASession.access_token) },
      );
      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers.get('content-type')).toBe('text/csv');
      expect(downloadRes.headers.get('content-disposition')).toBe(
        'attachment; filename="sales-report.csv"',
      );
      expect(downloadRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(downloadRes.headers.get('cache-control')).toBe('private, no-store');
      const downloadedCsv = await downloadRes.text();
      expect(downloadedCsv).toContain('source_file,column,count,sum,min,max,mean');
      expect(downloadedCsv).toContain('sales.csv,revenue,3,400,79.50,200,133.33');
      expect(downloadedCsv).toContain('sales.csv,units,3,30,5,15,10');

      // 6. Cross-tenant isolation: Tenant B receives 404 on every Task & Artifact endpoint.
      for (const path of [
        `/v1/me/tasks/${taskId}`,
        `/v1/me/tasks/${taskId}/events`,
        `/v1/me/tasks/${taskId}/result`,
        `/v1/me/tasks/${taskId}/artifacts`,
        `/v1/me/artifacts/${outputArtifact!.artifact_id}`,
      ]) {
        const forbiddenRes = await fetch(`${baseUrl}${path}`, {
          headers: auth(tenantBSession.access_token),
        });
        expect(forbiddenRes.status).toBe(404);
      }
    } finally {
      stopController.abort();
      turnResponder.stop();
      await Promise.allSettled([turnResponder.done, pollPromise]);
    }
  });

  it('recovers from a transient sandbox failure without duplicating output artifacts and supports clean cancellation', async () => {
    const session = await signInDev(baseUrl, `alpha-f-recovery-${randomUUID()}`);
    const meRes = await fetch(`${baseUrl}/v1/me`, { headers: auth(session.access_token) });
    const me = B1MeResponseSchema.parse(await meRes.json());

    const uploadRes = await fetch(`${baseUrl}/v1/me/uploads`, {
      method: 'POST',
      headers: { ...auth(session.access_token), 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'retry-data.csv',
        media_type: 'text/csv',
        content: 'item,amount\na,10\nb,20\n',
      }),
    });
    expect(uploadRes.status).toBe(201);
    const stagedUpload = B3StagedUploadReceiptDtoSchema.parse(await uploadRes.json());

    const sendRes = await fetch(
      `${baseUrl}/v1/conversations/${me.conversation.conversation_id}/messages`,
      {
        method: 'POST',
        headers: { ...auth(session.access_token), 'content-type': 'application/json' },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'Analyze retry-data.csv',
          transcript_epoch: me.conversation.transcript_epoch,
          attachment_ids: [stagedUpload.upload_id],
        }),
      },
    );
    expect(sendRes.status).toBe(201);
    const receipt = B1SendMessageReceiptSchema.parse(await sendRes.json());

    let execAttempts = 0;
    const gateway = new FakeModelGateway({
      onConversationTurn: () => ({
        kind: 'delegate',
        toolName: 'delegate_python_agent',
        text: 'Starting retry-data.csv analysis.',
        finishReason: 'stop',
        delegation: {
          toolName: 'delegate_python_agent',
          arguments: {
            title: 'Retryable CSV analysis',
            prompt: 'Summarize retry-data.csv',
            attachmentIds: [stagedUpload.upload_id],
          },
        },
      }),
      onStepPythonAgent: (input) => {
        if (!input.messages.some((m) => m.role === 'tool')) {
          return {
            kind: 'tool_call',
            toolCallId: `call_retry_${input.messages.length}`,
            code: 'print("process retry-data.csv")',
            purpose: 'Process retry-data.csv',
            rawArgumentsJson: JSON.stringify({ code: 'print("process retry-data.csv")' }),
          };
        }
        return {
          kind: 'final',
          summaryText: 'Retry analysis complete.',
          detailText: 'Total amount is 30 across 2 rows.',
          truncated: false,
          finishReason: 'stop',
        };
      },
    });

    const stopController = new AbortController();
    const leaseConfig = resolveLeaseQueueConfig({
      leaseDurationMs: 15_000,
      heartbeatIntervalMs: 5_000,
      baseDelayMs: 100,
      capDelayMs: 250,
      reaperBatchSize: 20,
    });
    const queue = new PostgresLeaseQueue(db.pool, {
      ...leaseConfig,
      clock: systemClock,
      claimableKinds: ['python.agent'],
    });

    const sandboxFactory = createFakePythonAgentSandboxFactory({
      onExec: (ctx) => {
        execAttempts += 1;
        if (execAttempts === 1) {
          throw new DomainError('SANDBOX_NOT_READY', 'simulated transient sandbox crash');
        }
        ctx.outputs.set(
          'analysis-summary.csv',
          new TextEncoder().encode('source_file,column,count,sum\nretry-data.csv,amount,2,30\n'),
        );
        return { exitCode: 0, stdout: 'recovered on attempt 2', stderr: '' };
      },
    });

    const pythonAgentHandler = createPythonAgentTaskHandler({
      mode: 'fake',
      leaseQueue: queue,
      repository: new PostgresPythonAgentExecutionRepository(db.pool),
      blobStore: new PostgresByteaBlobStore(db.pool),
      gateway,
      createSandbox: sandboxFactory,
      sandboxOwner: 'e2e-alpha-f-retry-worker',
      policy: leaseConfig,
      ceilings: CEILINGS,
      rate: null,
      leaseDurationMs: leaseConfig.leaseDurationMs,
      attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
      logger: SILENT_WORKER_LOGGER,
    });

    const routerHandler = createCommitmentRouteAwareRunHandler({
      contextReader: new PostgresRunExecutionContextReader(db.pool, systemClock),
      clock: systemClock,
      commitmentHandler: UNEXPECTED_DEFAULT_HANDLER,
      pythonAgentHandler,
      defaultHandler: UNEXPECTED_DEFAULT_HANDLER,
      logger: SILENT_WORKER_LOGGER,
    });

    const turnResponder = createModelTurnResponder({
      mode: 'fake',
      repository: new PostgresModelTurnExecutionRepository(db.pool),
      gateway,
      workerId: 'e2e-alpha-f-retry-turn',
      leaseMs: 15_000,
      ceilings: CEILINGS,
      maxAttempts: 2,
      attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
      rate: null,
      logger: SILENT_WORKER_LOGGER,
    }).start(stopController.signal);

    const pollPromise = runPollLoop({
      queue,
      handler: routerHandler,
      clock: systemClock,
      workerId: 'e2e-alpha-f-retry-worker',
      concurrency: 1,
      heartbeatIntervalMs: 5_000,
      idleIntervalMs: 50,
      errorBackoffMs: 100,
      logger: SILENT_WORKER_LOGGER,
      signal: stopController.signal,
    });

    try {
      const completedTurn = await waitForTurnTerminal(
        baseUrl,
        session.access_token,
        me.conversation.conversation_id,
        receipt.turn.turn_id,
      );
      expect(completedTurn.status).toBe('completed');

      const pageRes = await fetch(
        `${baseUrl}/v1/conversations/${me.conversation.conversation_id}/messages`,
        { headers: auth(session.access_token) },
      );
      const page = B1ConversationPageSchema.parse(await pageRes.json());
      const taskRef = page.messages.find((m) => m.kind === 'task_reference');
      const taskId = taskRef?.kind === 'task_reference' ? taskRef.task_id : '';

      const { detail } = await waitForCompletedTask(baseUrl, session.access_token, taskId);
      expect(detail.attempt_count).toBeGreaterThanOrEqual(2);
      expect(execAttempts).toBe(2);

      const artifactsRes = await fetch(`${baseUrl}/v1/me/tasks/${taskId}/artifacts`, {
        headers: auth(session.access_token),
      });
      const artifactsList = B3TaskArtifactsListDtoSchema.parse(await artifactsRes.json());
      const runArtifacts = artifactsList.artifacts.filter((a) => a.created_by === 'run');
      expect(runArtifacts).toHaveLength(1);
      expect(runArtifacts[0]?.filename).toBe('analysis-summary.csv');

      // Stop poll loop before delegating a second task so we can deterministically cancel it while queued.
      stopController.abort();
      turnResponder.stop();
      await Promise.allSettled([turnResponder.done, pollPromise]);

      const cancelTurnController = new AbortController();
      const cancelSendRes = await fetch(
        `${baseUrl}/v1/conversations/${me.conversation.conversation_id}/messages`,
        {
          method: 'POST',
          headers: { ...auth(session.access_token), 'content-type': 'application/json' },
          body: JSON.stringify({
            client_submission_id: randomUUID(),
            text: 'Start a task I will cancel immediately.',
            transcript_epoch: me.conversation.transcript_epoch,
          }),
        },
      );
      expect(cancelSendRes.status).toBe(201);
      const cancelReceipt = B1SendMessageReceiptSchema.parse(await cancelSendRes.json());

      const cancelTurnResponder = createModelTurnResponder({
        mode: 'fake',
        repository: new PostgresModelTurnExecutionRepository(db.pool),
        gateway: new FakeModelGateway({
          onConversationTurn: () => ({
            kind: 'delegate',
            toolName: 'delegate_python_agent',
            text: 'Starting cancellable task.',
            finishReason: 'stop',
            delegation: {
              toolName: 'delegate_python_agent',
              arguments: {
                title: 'Cancellable task',
                prompt: 'Compute something cancellable',
              },
            },
          }),
        }),
        workerId: 'e2e-alpha-f-cancel-turn',
        leaseMs: 15_000,
        ceilings: CEILINGS,
        maxAttempts: 2,
        attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
        rate: null,
        logger: SILENT_WORKER_LOGGER,
      }).start(cancelTurnController.signal);

      try {
        const cancelTurn = await waitForTurnTerminal(
          baseUrl,
          session.access_token,
          me.conversation.conversation_id,
          cancelReceipt.turn.turn_id,
        );
        expect(cancelTurn.status).toBe('completed');
      } finally {
        cancelTurnController.abort();
        cancelTurnResponder.stop();
        await cancelTurnResponder.done;
      }

      const cancelTasksRes = await fetch(`${baseUrl}/v1/me/tasks`, {
        headers: auth(session.access_token),
      });
      const cancelTasks = B1TaskListDtoSchema.parse(await cancelTasksRes.json());
      const cancellable = cancelTasks.tasks.find((t) => t.title === 'Cancellable task');
      expect(cancellable).toBeDefined();

      const cancelRes = await fetch(`${baseUrl}/v1/me/tasks/${cancellable!.task_id}/cancel`, {
        method: 'POST',
        headers: auth(session.access_token),
      });
      expect(cancelRes.status).toBe(200);
      const cancelled = B1TaskCancelDtoSchema.parse(await cancelRes.json());
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.terminal).toBe(true);

      const cancelledArtifactsRes = await fetch(
        `${baseUrl}/v1/me/tasks/${cancellable!.task_id}/artifacts`,
        { headers: auth(session.access_token) },
      );
      expect(cancelledArtifactsRes.status).toBe(200);
      const cancelledArtifacts = B3TaskArtifactsListDtoSchema.parse(
        await cancelledArtifactsRes.json(),
      );
      expect(cancelledArtifacts.artifacts).toHaveLength(0);
    } finally {
      stopController.abort();
      turnResponder.stop();
      await Promise.allSettled([turnResponder.done, pollPromise]);
    }
  });
});
