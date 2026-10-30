import { randomUUID } from 'node:crypto';
import { DomainError } from '@ember/domain';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { TaskCancelDtoSchema } from '../../apps/api/src/tasks/dto.js';
import {
  buildTaskView,
  createFakeTaskApi,
  FIXED_TIME,
  type FakeTaskApi,
} from './support/task-api-fakes.js';

/**
 * `POST /v1/tasks/:taskId/cancel` (P0B-08c).
 *
 * Covers the HTTP edge contract:
 * - Dev Token authentication and verified `AuthContext` propagation;
 * - tenant isolation: missing and cross-tenant tasks return identical 404 bodies;
 * - `queued`, `retryable_failed`, and `waiting_approval` transition immediately to `cancelled`
 *   and return 200 OK with `terminal: true`;
 * - `running` records `cancel_requested` durably and returns 202 Accepted with `terminal: false`;
 * - repeated cancellation and already-terminal tasks (`completed`, `failed`, `cancelled`) are
 *   idempotent and return 200 OK (or 202 while still `running`);
 * - strict wire schema with no leaked SQL, worker IDs, or tokens.
 */

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const TOKEN = `token-${randomUUID()}`;
const REQUEST_ID = 'req-cancel-01';
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
      { token: TOKEN, tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 2 },
    ]),
    requestIdGenerator: () => REQUEST_ID,
    taskStore: api.store,
  });

  return { api, app };
}

async function cancel(app: App, taskId: string, token: string | null = TOKEN): Promise<Response> {
  return await app.request(`/v1/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('POST /v1/tasks/:taskId/cancel', () => {
  it.each(['queued', 'retryable_failed', 'waiting_approval'] as const)(
    'cancels a %s task immediately with 200 OK and terminal=true',
    async (initialStatus) => {
      const { api, app } = harness();
      const id = randomUUID();
      api.addTask(TENANT_ID, buildTaskView({ taskId: id, status: initialStatus }));

      const response = await cancel(app, id);

      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(TaskCancelDtoSchema.parse(body)).toEqual({
        task_id: id,
        status: 'cancelled',
        cancel_requested: true,
        cancel_requested_at: FIXED_TIME,
        terminal: true,
        updated_at: FIXED_TIME,
      });
      expect(api.cancels).toEqual([
        {
          context: { tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 2 },
          taskId: id,
        },
      ]);
    },
  );

  it('records cancellation intent on a running task with 202 Accepted and terminal=false', async () => {
    const { api, app } = harness();
    api.addTask(
      TENANT_ID,
      buildTaskView({ taskId: TASK_ID, status: 'running', currentRunId: randomUUID() }),
    );

    const first = await cancel(app, TASK_ID);
    const second = await cancel(app, TASK_ID);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody: unknown = await first.json();
    const secondBody: unknown = await second.json();
    expect(TaskCancelDtoSchema.parse(firstBody)).toEqual({
      task_id: TASK_ID,
      status: 'running',
      cancel_requested: true,
      cancel_requested_at: FIXED_TIME,
      terminal: false,
      updated_at: FIXED_TIME,
    });
    expect(secondBody).toEqual(firstBody);
    // Never leaks current_run_id, tenant_id, worker_id or tokens.
    expect(JSON.stringify(firstBody)).not.toContain('current_run_id');
    expect(JSON.stringify(firstBody)).not.toContain('worker_id');
    expect(JSON.stringify(firstBody)).not.toContain(TENANT_ID);
    expect(JSON.stringify(firstBody)).not.toContain(TOKEN);
  });

  it('is idempotent on already-terminal tasks (completed, failed, cancelled)', async () => {
    const { api, app } = harness();
    const completedId = randomUUID();
    const failedId = randomUUID();
    const cancelledId = randomUUID();

    api.addTask(TENANT_ID, buildTaskView({ taskId: completedId, status: 'completed' }));
    api.addTask(TENANT_ID, buildTaskView({ taskId: failedId, status: 'failed' }));
    api.addTask(TENANT_ID, buildTaskView({ taskId: cancelledId, status: 'cancelled' }));

    const completedRes = await cancel(app, completedId);
    const failedRes = await cancel(app, failedId);
    const cancelledRes = await cancel(app, cancelledId);

    expect(completedRes.status).toBe(200);
    expect(await completedRes.json()).toEqual({
      task_id: completedId,
      status: 'completed',
      cancel_requested: false,
      cancel_requested_at: null,
      terminal: true,
      updated_at: FIXED_TIME,
    });

    expect(failedRes.status).toBe(200);
    expect(await failedRes.json()).toEqual({
      task_id: failedId,
      status: 'failed',
      cancel_requested: false,
      cancel_requested_at: null,
      terminal: true,
      updated_at: FIXED_TIME,
    });

    expect(cancelledRes.status).toBe(200);
    expect(await cancelledRes.json()).toEqual({
      task_id: cancelledId,
      status: 'cancelled',
      cancel_requested: true,
      cancel_requested_at: FIXED_TIME,
      terminal: true,
      updated_at: FIXED_TIME,
    });
  });

  it('answers a missing task and a foreign-tenant task with the exact same 404 body', async () => {
    const { api, app } = harness();
    const foreignId = randomUUID();
    api.addTask(OTHER_TENANT_ID, buildTaskView({ taskId: foreignId, status: 'queued' }));

    const missing = await cancel(app, randomUUID());
    const foreign = await cancel(app, foreignId);

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    const missingBody: unknown = await missing.json();
    expect(await foreign.json()).toEqual(missingBody);
    expect(missingBody).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found', request_id: REQUEST_ID },
    });
    // Foreign task remains untouched in its own tenant.
    const untouched = await api.store.get(
      { tenantId: OTHER_TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 2 },
      foreignId,
    );
    expect(untouched?.status).toBe('queued');
  });

  it('rejects missing or invalid bearer tokens with 401 before touching persistence', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID }));

    const noToken = await cancel(app, TASK_ID, null);
    const badToken = await cancel(app, TASK_ID, 'invalid-token-value');

    expect(noToken.status).toBe(401);
    expect(badToken.status).toBe(401);
    expect(api.cancels).toEqual([]);
  });

  it('rejects a malformed taskId with 400 before touching persistence', async () => {
    const { api, app } = harness();

    const response = await cancel(app, 'not-a-uuid');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', request_id: REQUEST_ID },
    });
    expect(api.cancels).toEqual([]);
  });

  it('redacts internal SQL, worker details and credentials on store failure (503)', async () => {
    const { api, app } = harness();
    api.setFailure(
      new DomainError(
        'DB_UNAVAILABLE',
        `UPDATE tasks SET cancel_requested_at = now() -- worker-secret-01 ${TOKEN}`,
      ),
    );

    const response = await cancel(app, TASK_ID);
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).not.toContain('UPDATE tasks');
    expect(raw).not.toContain('worker-secret-01');
    expect(raw).not.toContain(TOKEN);
  });
});
