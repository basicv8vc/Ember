import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import type { ServerType } from '@hono/node-server';
import {
  B1AssistantTurnDtoSchema,
  B1ConversationPageSchema,
  B1MeResponseSchema,
  B1SendMessageReceiptSchema,
  B1SessionResponseSchema,
} from '@ember/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/index.js';
import { loadApiConfig } from '../../apps/api/src/env.js';
import { createLogger } from '../../apps/api/src/logger.js';
import { FAKE_TURN_REPLY_PREFIX } from '../../apps/worker/src/b1/fake-turn-responder.js';
import { loadDatabaseConfig } from '../../packages/postgres/src/index.js';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';
import {
  spawnWorkerSubprocess,
  type WorkerSubprocessHandle,
} from '../chaos/harness/worker-subprocess.js';

const APPLE_BUNDLE_ID = 'com.ember.mobile';
const SECRET_USER_TEXT = 'private cloud runtime test text 94b2f7';

interface RunningApi {
  readonly server: ServerType;
  readonly baseUrl: string;
}

interface Session {
  readonly access_token: string;
  readonly consumer_id: string;
  readonly session_id: string;
  readonly expires_at: string;
}

function addressOf(server: ServerType): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP listener');
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
    throw new Error('could not reserve an API port');
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function startApi(
  db: TestDatabase,
  databaseUrl: string,
  logLines: string[],
): Promise<RunningApi> {
  const port = await availablePort();
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    EMBER_ENV: 'test',
    EMBER_HOST: '127.0.0.1',
    EMBER_PORT: String(port),
    EMBER_ALLOW_NON_LOOPBACK_BIND: 'false',
    EMBER_DEV_PROVIDER_ENABLED: 'true',
    EMBER_DEV_PROVIDER_ISOLATED: 'true',
    EMBER_APPLE_BUNDLE_ID: APPLE_BUNDLE_ID,
    DATABASE_URL: databaseUrl,
  };
  const apiConfig = loadApiConfig(env);
  const logger = createLogger({ level: 'debug', sink: (_level, line) => logLines.push(line) });
  const server = startApiServer({
    pool: db.pool,
    apiConfig,
    databaseConfig: loadDatabaseConfig(env),
    env,
    logger,
  });
  if (!server.listening) {
    await once(server, 'listening');
  }
  const address = addressOf(server);
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeApi(server: ServerType | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  (server as HttpServer).closeAllConnections();
  await closed;
}

async function createSession(baseUrl: string, assertion: string): Promise<Session> {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'dev', identity_token: assertion, nonce: 'ignored' }),
  });
  expect(response.status).toBe(201);
  return B1SessionResponseSchema.parse(await response.json());
}

async function tenantForConsumer(db: TestDatabase, consumerId: string): Promise<string> {
  const result = await db.pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM consumers WHERE id = $1',
    [consumerId],
  );
  const tenantId = result.rows[0]?.tenant_id;
  if (tenantId === undefined) throw new Error('session provisioning did not create a tenant');
  return tenantId;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function waitForCompletedTurn(
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
    if (latest.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(latest?.status).toBe('completed');
  return latest!;
}

describe('B1 Cloud Chat runtime over real HTTP and PostgreSQL 17', () => {
  let db: TestDatabase;
  let api: RunningApi;
  let worker: WorkerSubprocessHandle | undefined;
  let blobRoot: string | undefined;
  let databaseUrl: string;
  const apiLogs: string[] = [];

  async function startWorker(): Promise<WorkerSubprocessHandle> {
    const currentBlobRoot = mkdtempSync(path.join(tmpdir(), 'ember-b1-cloud-worker-'));
    blobRoot = currentBlobRoot;
    return spawnWorkerSubprocess({
      schema: db.schema,
      blobRootDir: currentBlobRoot,
      workerId: `b1-cloud-${process.pid}`,
      databaseUrl,
      mode: 'reaper-only',
      logLevel: 'debug',
      extraEnv: {
        EMBER_ENV: 'test',
        EMBER_B1_FAKE_RESPONDER_ENABLED: 'true',
      },
    });
  }

  async function stopWorker(): Promise<void> {
    if (worker !== undefined) {
      const stopped = await worker.sigterm();
      expect(stopped.code).toBe(0);
      worker = undefined;
      if (blobRoot !== undefined) {
        rmSync(blobRoot, { recursive: true, force: true });
        blobRoot = undefined;
      }
    }
  }

  beforeAll(async () => {
    databaseUrl = process.env.TEST_DATABASE_URL ?? '';
    if (databaseUrl.length === 0) throw new Error('TEST_DATABASE_URL is required');
    db = await createTestDatabase();
    const version = await db.pool.query<{ version: string }>('SELECT version() AS version');
    expect(version.rows[0]?.version).toMatch(/^PostgreSQL 17\./);
    api = await startApi(db, databaseUrl, apiLogs);
    worker = await startWorker();
  }, 60_000);

  afterAll(async () => {
    await stopWorker();
    await closeApi(api?.server);
    if (blobRoot !== undefined) rmSync(blobRoot, { recursive: true, force: true });
    await db?.close();
  });

  it('commits, replies once, fences tenant access and recovers after both services restart', async () => {
    const firstSession = await createSession(api.baseUrl, `dev-${randomUUID()}`);
    const meResponse = await fetch(`${api.baseUrl}/v1/me`, {
      headers: auth(firstSession.access_token),
    });
    expect(meResponse.status).toBe(200);
    const me = B1MeResponseSchema.parse(await meResponse.json());
    const firstTenantId = await tenantForConsumer(db, me.consumer_id);

    const request = {
      client_submission_id: randomUUID(),
      text: SECRET_USER_TEXT,
      transcript_epoch: me.conversation.transcript_epoch,
    };
    const sendUrl = `${api.baseUrl}/v1/conversations/${me.conversation.conversation_id}/messages`;
    const send = await fetch(sendUrl, {
      method: 'POST',
      headers: { ...auth(firstSession.access_token), 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(send.status).toBe(201);
    const receipt = B1SendMessageReceiptSchema.parse(await send.json());
    expect(receipt.turn.status).toBe('running');

    const committed = await db.observerPool.query<{ status: string; message_count: string }>(
      `SELECT t.status,
              (SELECT count(*)::text FROM conversation_messages m
                WHERE m.tenant_id = t.tenant_id AND m.conversation_id = t.conversation_id) AS message_count
         FROM assistant_turns t WHERE t.tenant_id = $1 AND t.id = $2`,
      [firstTenantId, receipt.turn.turn_id],
    );
    expect(committed.rows).toHaveLength(1);
    expect(committed.rows[0]).toEqual({ status: 'running', message_count: '1' });

    const lookup = await fetch(
      `${api.baseUrl}/v1/message-submissions/${request.client_submission_id}`,
      { headers: auth(firstSession.access_token) },
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual(receipt);
    const unknownAck = await fetch(`${api.baseUrl}/v1/message-submissions/${randomUUID()}`, {
      headers: auth(firstSession.access_token),
    });
    expect(unknownAck.status).toBe(404);

    const replay = await fetch(sendUrl, {
      method: 'POST',
      headers: { ...auth(firstSession.access_token), 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);

    const completed = await waitForCompletedTurn(
      api.baseUrl,
      firstSession.access_token,
      me.conversation.conversation_id,
      receipt.turn.turn_id,
    );
    expect(completed.response_message_id).not.toBeNull();
    const transcriptResponse = await fetch(
      `${api.baseUrl}/v1/conversations/${me.conversation.conversation_id}/messages`,
      { headers: auth(firstSession.access_token) },
    );
    expect(transcriptResponse.status).toBe(200);
    const transcript = B1ConversationPageSchema.parse(await transcriptResponse.json());
    expect(transcript.messages.map((message) => message.kind)).toEqual(['user', 'ember']);
    const userMessage = transcript.messages[0];
    const assistantMessage = transcript.messages[1];
    if (userMessage?.kind !== 'user' || assistantMessage?.kind !== 'ember') {
      throw new Error('expected one user Message followed by one assistant Message');
    }
    expect(userMessage.text).toBe(SECRET_USER_TEXT);
    expect(assistantMessage.text.startsWith(FAKE_TURN_REPLY_PREFIX)).toBe(true);
    expect(assistantMessage.simulated).toBe(true);

    const secondSession = await createSession(api.baseUrl, `dev-${randomUUID()}`);
    const secondMeResponse = await fetch(`${api.baseUrl}/v1/me`, {
      headers: auth(secondSession.access_token),
    });
    expect(secondMeResponse.status).toBe(200);
    const secondMe = B1MeResponseSchema.parse(await secondMeResponse.json());
    const secondTenantId = await tenantForConsumer(db, secondMe.consumer_id);
    const foreignMessages = await fetch(
      `${api.baseUrl}/v1/conversations/${me.conversation.conversation_id}/messages`,
      { headers: auth(secondSession.access_token) },
    );
    expect(foreignMessages.status).toBe(404);
    const foreignReceipt = await fetch(
      `${api.baseUrl}/v1/message-submissions/${request.client_submission_id}`,
      { headers: auth(secondSession.access_token) },
    );
    expect(foreignReceipt.status).toBe(404);
    const foreignTurn = await fetch(
      `${api.baseUrl}/v1/conversations/${me.conversation.conversation_id}/turns/${receipt.turn.turn_id}`,
      { headers: auth(secondSession.access_token) },
    );
    expect(foreignTurn.status).toBe(404);
    const legacyTaskAuth = await fetch(`${api.baseUrl}/v1/tasks/${randomUUID()}`, {
      headers: auth(firstSession.access_token),
    });
    expect(legacyTaskAuth.status).toBe(401);

    await stopWorker();
    const cancelRequest = {
      client_submission_id: randomUUID(),
      text: 'cancel this simulated turn',
      transcript_epoch: secondMe.conversation.transcript_epoch,
    };
    const cancelSend = await fetch(
      `${api.baseUrl}/v1/conversations/${secondMe.conversation.conversation_id}/messages`,
      {
        method: 'POST',
        headers: { ...auth(secondSession.access_token), 'content-type': 'application/json' },
        body: JSON.stringify(cancelRequest),
      },
    );
    expect(cancelSend.status).toBe(201);
    const cancelReceipt = B1SendMessageReceiptSchema.parse(await cancelSend.json());
    const cancelUrl = `${api.baseUrl}/v1/conversations/${secondMe.conversation.conversation_id}/turns/${cancelReceipt.turn.turn_id}/cancel`;
    const cancel = await fetch(cancelUrl, {
      method: 'POST',
      headers: auth(secondSession.access_token),
    });
    expect(cancel.status).toBe(200);
    expect(B1AssistantTurnDtoSchema.parse(await cancel.json()).status).toBe('cancelled');
    const cancelReplay = await fetch(cancelUrl, {
      method: 'POST',
      headers: auth(secondSession.access_token),
    });
    expect(cancelReplay.status).toBe(200);
    expect(B1AssistantTurnDtoSchema.parse(await cancelReplay.json()).status).toBe('cancelled');

    const timeoutRequest = {
      client_submission_id: randomUUID(),
      text: 'expire this simulated turn',
      transcript_epoch: secondMe.conversation.transcript_epoch,
    };
    const timeoutSend = await fetch(
      `${api.baseUrl}/v1/conversations/${secondMe.conversation.conversation_id}/messages`,
      {
        method: 'POST',
        headers: { ...auth(secondSession.access_token), 'content-type': 'application/json' },
        body: JSON.stringify(timeoutRequest),
      },
    );
    expect(timeoutSend.status).toBe(201);
    const timeoutReceipt = B1SendMessageReceiptSchema.parse(await timeoutSend.json());
    await db.pool.query(
      `UPDATE assistant_turns
          SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2`,
      [secondTenantId, timeoutReceipt.turn.turn_id],
    );
    const timeoutUrl = `${api.baseUrl}/v1/conversations/${secondMe.conversation.conversation_id}/turns/${timeoutReceipt.turn.turn_id}`;
    const timeout = await fetch(timeoutUrl, { headers: auth(secondSession.access_token) });
    expect(timeout.status).toBe(200);
    expect(B1AssistantTurnDtoSchema.parse(await timeout.json())).toMatchObject({
      status: 'failed',
      failure_reason: 'timeout',
    });
    const timeoutReplay = await fetch(timeoutUrl, { headers: auth(secondSession.access_token) });
    expect(timeoutReplay.status).toBe(200);
    const timedAssistantMessages = await db.observerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM conversation_messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'`,
      [secondTenantId, secondMe.conversation.conversation_id],
    );
    expect(timedAssistantMessages.rows[0]?.count).toBe('1');

    // Stop and restart the real worker, then restart the real API listener over the same PG schema.
    worker = await startWorker();
    await closeApi(api.server);
    api = await startApi(db, databaseUrl, apiLogs);

    const recoveredMeResponse = await fetch(`${api.baseUrl}/v1/me`, {
      headers: auth(firstSession.access_token),
    });
    expect(recoveredMeResponse.status).toBe(200);
    const recoveredMe = B1MeResponseSchema.parse(await recoveredMeResponse.json());
    expect(recoveredMe.conversation.conversation_id).toBe(me.conversation.conversation_id);
    const recovered = await fetch(
      `${api.baseUrl}/v1/conversations/${recoveredMe.conversation.conversation_id}/messages`,
      { headers: auth(firstSession.access_token) },
    );
    expect(recovered.status).toBe(200);
    const recoveredTranscript = B1ConversationPageSchema.parse(await recovered.json());
    expect(recoveredTranscript.messages.map((message) => message.kind)).toEqual(['user', 'ember']);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const assistantCount = await db.observerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM conversation_messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'`,
      [firstTenantId, me.conversation.conversation_id],
    );
    expect(assistantCount.rows[0]?.count).toBe('1');
    expect(worker.getLogs()).toContain('"b1FakeResponderEnabled":true');
    expect(apiLogs.join('\n')).not.toContain(SECRET_USER_TEXT);
    expect(apiLogs.join('\n')).not.toContain(firstSession.access_token);
    expect(worker.getLogs()).not.toContain(SECRET_USER_TEXT);
  }, 30_000);
});
