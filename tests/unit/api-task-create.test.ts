import { randomUUID } from 'node:crypto';
import { DomainError } from '@ember/domain';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { MAX_TASK_BODY_BYTES } from '../../apps/api/src/tasks/constants.js';
import {
  buildReceipt,
  buildTaskView,
  createFakeTaskApi,
  type FakeTaskApi,
} from './support/task-api-fakes.js';

/**
 * `POST /v1/tasks` (P0B-07a) against an in-memory store.
 *
 * The assertions cover the four properties this endpoint must never lose: the tenant comes
 * from the credential, the idempotency key comes from the header, a rejected request never
 * reaches persistence, and a replay is distinguishable from a first acceptance.
 */

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const TOKEN = `token-${randomUUID()}`;
const REQUEST_ID = 'req-post-01';
const KEY = 'idem-key-000001';
const AGENT_ID = randomUUID();

type App = ReturnType<typeof createApp>;

interface Harness {
  readonly api: FakeTaskApi;
  readonly app: App;
}

function harness(): Harness {
  const api = createFakeTaskApi();
  const app = createApp({
    authenticator: createDevTokenAuthenticator([
      { token: TOKEN, tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 1 },
    ]),
    requestIdGenerator: () => REQUEST_ID,
    taskStore: api.store,
  });

  return { api, app };
}

const CHAT_BODY = {
  agent_id: AGENT_ID,
  kind: 'mock.chat',
  input: { prompt: 'summarise the incident' },
};

async function post(
  app: App,
  options: { body?: unknown; raw?: string; key?: string | null; contentType?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;

  if (contentType !== null) {
    headers['content-type'] = contentType;
  }
  if (options.key !== null) {
    headers['Idempotency-Key'] = options.key ?? KEY;
  }

  const body = options.raw ?? JSON.stringify(options.body ?? CHAT_BODY);

  return await app.request('/v1/tasks', { method: 'POST', headers, body });
}

describe('POST /v1/tasks', () => {
  it('accepts a task with 202, a Location header and the canonical receipt', async () => {
    const { api, app } = harness();
    const taskId = randomUUID();
    api.setReceipt(buildReceipt({ taskId }));

    const response = await post(app);

    expect(response.status).toBe(202);
    expect(response.headers.get('location')).toBe(`/v1/tasks/${taskId}`);
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    await expect(response.json()).resolves.toEqual({
      task_id: taskId,
      status: 'queued',
      accepted_at: '2026-01-01T00:00:00.000Z',
      replayed: false,
    });
  });

  it('derives the tenant from the credential and the key from the header', async () => {
    const { api, app } = harness();

    await post(app, { body: { ...CHAT_BODY, deadline_at: '2026-01-01T01:00:00.000Z' } });

    expect(api.createContexts).toEqual([
      { tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 1 },
    ]);
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]).toMatchObject({
      agentId: AGENT_ID,
      kind: 'mock.chat',
      idempotencyKey: KEY,
      input: { prompt: 'summarise the incident' },
      deadlineAt: '2026-01-01T01:00:00.000Z',
    });
  });

  it('answers a replay with 200 and replayed=true', async () => {
    const { api, app } = harness();
    const taskId = randomUUID();
    api.setReceipt(buildReceipt({ taskId, replayed: true }));

    const response = await post(app);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ task_id: taskId, replayed: true });
  });

  it('refuses a body that tries to choose its own tenant', async () => {
    const { api, app } = harness();

    const response = await post(app, { body: { ...CHAT_BODY, tenant_id: OTHER_TENANT_ID } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', request_id: REQUEST_ID },
    });
    expect(api.creates).toEqual([]);
  });

  it('refuses a body that smuggles the idempotency key', async () => {
    const { api, app } = harness();

    const response = await post(app, { body: { ...CHAT_BODY, idempotency_key: KEY } });

    expect(response.status).toBe(400);
    expect(api.creates).toEqual([]);
  });

  it('accepts a second tenant creating the same kind of task independently', async () => {
    const { api, app } = harness();
    api.addTask(OTHER_TENANT_ID, buildTaskView());

    const response = await post(app);

    expect(response.status).toBe(202);
    expect(api.createContexts.map((context) => context.tenantId)).toEqual([TENANT_ID]);
  });
});

describe('POST /v1/tasks rejection paths', () => {
  it('requires an Idempotency-Key header without echoing a rejected value', async () => {
    const { api, app } = harness();

    const missing = await post(app, { key: null });
    expect(missing.status).toBe(400);
    // The handler's diagnostic ("Idempotency-Key header is required") is internal: clients
    // only ever see the fixed message chosen by the stable code.
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'Invalid request input',
        request_id: REQUEST_ID,
      },
    });

    for (const key of ['short', 'has space', 'k'.repeat(129), '=leading']) {
      const response = await post(app, { key });
      expect(response.status, key).toBe(400);
      const text = await response.text();
      expect(text, key).not.toContain(key);
    }

    expect(api.creates).toEqual([]);
  });

  it('rejects a body above the 64 KiB cap before any store call', async () => {
    const { api, app } = harness();
    const oversized = JSON.stringify({
      ...CHAT_BODY,
      input: { prompt: 'x'.repeat(MAX_TASK_BODY_BYTES) },
    });

    const response = await post(app, { raw: oversized });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('INVALID_ARGUMENT');
    expect(text).not.toContain(String(MAX_TASK_BODY_BYTES));
    expect(api.creates).toEqual([]);
  });

  it('rejects a non-JSON content type, malformed JSON and an unknown kind', async () => {
    const { api, app } = harness();

    expect((await post(app, { contentType: 'text/plain' })).status).toBe(400);
    expect((await post(app, { contentType: null })).status).toBe(400);
    expect((await post(app, { raw: '{"agent_id":' })).status).toBe(400);
    expect((await post(app, { body: { ...CHAT_BODY, kind: 'mock.unknown' } })).status).toBe(400);
    expect(api.creates).toEqual([]);
  });

  it('surfaces an idempotency conflict from the store as 409', async () => {
    const { api, app } = harness();
    api.setFailure(
      new DomainError('IDEMPOTENCY_CONFLICT', 'same key, different payload for tenant x'),
    );

    const response = await post(app);

    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain('IDEMPOTENCY_CONFLICT');
    expect(text).not.toContain('different payload');
  });

  it('reports an unavailable database as 503 rather than a client error', async () => {
    const { api, app } = harness();
    api.setFailure(new DomainError('DB_UNAVAILABLE', 'connect ECONNREFUSED 127.0.0.1:5432'));

    const response = await post(app);

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('DB_UNAVAILABLE');
    expect(text).not.toContain('ECONNREFUSED');
  });
});
