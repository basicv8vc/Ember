import { randomUUID } from 'node:crypto';
import { DomainError } from '@ember/domain';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { buildTaskView, createFakeTaskApi, type FakeTaskApi } from './support/task-api-fakes.js';

/**
 * `GET /v1/tasks/:taskId` (P0B-07a).
 *
 * The isolation rule under test: a task id belonging to another tenant must be
 * indistinguishable from one that does not exist — same status, same body, and no further
 * query that could leak timing or row counts.
 */

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const TOKEN = `token-${randomUUID()}`;
const REQUEST_ID = 'req-read-01';
const TASK_ID = randomUUID();

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

async function get(app: App, path: string): Promise<Response> {
  return await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
}

describe('GET /v1/tasks/:taskId', () => {
  it('returns the snake_case detail DTO with no internal columns', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID, status: 'running', attemptCount: 2 }));

    const response = await get(app, `/v1/tasks/${TASK_ID}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      task_id: TASK_ID,
      agent_id: '00000000-0000-4000-8000-000000000002',
      kind: 'mock.chat',
      status: 'running',
      current_run_id: null,
      attempt_count: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deadline_at: null,
    });
    // Nothing that would leak the tenant, the raw request or the idempotency key.
    expect(Object.keys(body)).not.toContain('tenant_id');
    expect(Object.keys(body)).not.toContain('idempotency_key');
    expect(Object.keys(body)).not.toContain('input');
  });

  it('scopes the read to the authenticated tenant', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID }));

    await get(app, `/v1/tasks/${TASK_ID}`);

    expect(api.gets).toEqual([
      {
        context: { tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 1 },
        taskId: TASK_ID,
      },
    ]);
  });

  it('answers a missing task and a foreign task with the same 404 body', async () => {
    const { api, app } = harness();
    const foreignId = randomUUID();
    api.addTask(OTHER_TENANT_ID, buildTaskView({ taskId: foreignId }));

    const missing = await get(app, `/v1/tasks/${randomUUID()}`);
    const foreign = await get(app, `/v1/tasks/${foreignId}`);

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    const missingBody: unknown = await missing.json();
    expect(await foreign.json()).toEqual(missingBody);
    expect(missingBody).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found', request_id: REQUEST_ID },
    });
  });

  it('rejects a task id that is not a UUID', async () => {
    const { api, app } = harness();

    const response = await get(app, '/v1/tasks/not-a-uuid');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', request_id: REQUEST_ID },
    });
    expect(api.gets).toEqual([]);
  });

  it('reports a store failure as 503 without leaking the driver message', async () => {
    const { api, app } = harness();
    api.setFailure(new DomainError('DB_UNAVAILABLE', 'timeout after 30000ms on 10.0.0.5:5432'));

    const response = await get(app, `/v1/tasks/${TASK_ID}`);

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('10.0.0.5');
  });

  it('does not serve the collection path or an unsupported method', async () => {
    const { app } = harness();

    expect((await get(app, '/v1/tasks')).status).toBe(404);
    const post = await app.request(`/v1/tasks/${TASK_ID}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(404);
  });
});
