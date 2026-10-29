import { randomUUID } from 'node:crypto';
import { DomainError, type TaskEvent } from '@ember/domain';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { MAX_EVENTS_PER_PAGE } from '../../apps/api/src/tasks/constants.js';
import {
  buildEvent,
  buildTaskView,
  createFakeTaskApi,
  type FakeTaskApi,
  FIXED_TIME,
} from './support/task-api-fakes.js';

/**
 * `GET /v1/tasks/:taskId/events` (P0B-07a).
 *
 * Two rules are load-bearing here: the cursor is exclusive so polling never repeats an
 * event, and a foreign task id returns 404 *without* an event query, because an empty page
 * for somebody else's task would be indistinguishable from a real one.
 */

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const TOKEN = `token-${randomUUID()}`;
const REQUEST_ID = 'req-events-01';
const TASK_ID = randomUUID();
const TRACE_ID = '00000000-0000-4000-8000-000000000009';

type App = ReturnType<typeof createApp>;

interface Harness {
  readonly api: FakeTaskApi;
  readonly app: App;
}

function harness(): Harness {
  const api = createFakeTaskApi();
  const app = createApp({
    authenticator: createDevTokenAuthenticator([
      { token: TOKEN, tenantId: TENANT_ID, principalId: randomUUID(), policyVersion: 1 },
    ]),
    requestIdGenerator: () => REQUEST_ID,
    taskStore: api.store,
  });

  return { api, app };
}

async function get(app: App, path: string): Promise<Response> {
  return await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
}

function event(sequence: number, phase: TaskEvent['phase']): TaskEvent {
  return buildEvent(sequence, { taskId: TASK_ID, phase, traceId: TRACE_ID });
}

describe('event page', () => {
  it('returns the log ascending with the default cursor and page size', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID }));
    api.addEvents(TENANT_ID, TASK_ID, [event(1, 'accepted'), event(2, 'started')]);

    const response = await get(app, `/v1/tasks/${TASK_ID}/events`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      task_id: TASK_ID,
      events: [
        {
          task_id: TASK_ID,
          sequence: 1,
          phase: 'accepted',
          occurred_at: FIXED_TIME,
          trace_id: TRACE_ID,
          payload: { taskKind: 'mock.chat', policyVersion: 1 },
        },
        {
          task_id: TASK_ID,
          sequence: 2,
          phase: 'started',
          occurred_at: FIXED_TIME,
          trace_id: TRACE_ID,
          payload: { taskKind: 'mock.chat', policyVersion: 1 },
        },
      ],
    });
    expect(api.eventReads[0]?.options).toEqual({ after: 0, limit: MAX_EVENTS_PER_PAGE });
    expect(api.eventReads[0]?.context.tenantId).toBe(TENANT_ID);
  });

  it('treats after as exclusive so polling does not repeat an event', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID }));
    api.addEvents(TENANT_ID, TASK_ID, [
      event(1, 'accepted'),
      event(2, 'started'),
      event(3, 'completed'),
    ]);

    const response = await get(app, `/v1/tasks/${TASK_ID}/events?after=1`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: { sequence: number }[] };
    expect(body.events.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(api.eventReads[0]?.options).toEqual({ after: 1, limit: MAX_EVENTS_PER_PAGE });
  });

  it('returns an empty page when nothing is newer than the cursor', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID }));
    api.addEvents(TENANT_ID, TASK_ID, [event(1, 'accepted')]);

    const response = await get(app, `/v1/tasks/${TASK_ID}/events?after=1`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task_id: TASK_ID, events: [] });
  });

  it('rejects a malformed cursor without touching the store', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID }));

    for (const cursor of ['', '-1', '1.5', '1e3', 'abc', '9999999999999999']) {
      const response = await get(app, `/v1/tasks/${TASK_ID}/events?after=${cursor}`);
      expect(response.status, cursor).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_ARGUMENT', request_id: REQUEST_ID },
      });
    }

    expect(api.gets).toEqual([]);
    expect(api.eventReads).toEqual([]);
  });
});

describe('event page isolation and faults', () => {
  it('answers a foreign task exactly like a missing one and skips the event read', async () => {
    const { api, app } = harness();
    const foreignId = randomUUID();
    api.addTask(OTHER_TENANT_ID, buildTaskView({ taskId: foreignId }));
    api.addEvents(OTHER_TENANT_ID, foreignId, [buildEvent(1, { taskId: foreignId })]);

    const foreign = await get(app, `/v1/tasks/${foreignId}/events`);
    const missing = await get(app, `/v1/tasks/${randomUUID()}/events`);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const foreignBody: unknown = await foreign.json();
    expect(await missing.json()).toEqual(foreignBody);
    // No event query ran for either request, so neither response can reveal an event count.
    expect(api.eventReads).toEqual([]);
  });

  it('returns a persisted event that breaks the payload allowlist as a storage fault', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID }));
    api.addEvents(TENANT_ID, TASK_ID, [
      buildEvent(1, {
        taskId: TASK_ID,
        payload: { prompt: 'leaked-prompt-text' } as unknown as TaskEvent['payload'],
      }),
    ]);

    const response = await get(app, `/v1/tasks/${TASK_ID}/events`);

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('leaked-prompt-text');
    expect(JSON.parse(text)).toMatchObject({
      error: { code: 'DB_UNAVAILABLE', request_id: REQUEST_ID },
    });
  });

  it('reports an event-store failure as 503', async () => {
    const { api, app } = harness();
    api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID }));
    api.setFailure(new DomainError('DB_UNAVAILABLE', 'connection terminated unexpectedly'));

    const response = await get(app, `/v1/tasks/${TASK_ID}/events`);

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('connection terminated');
  });
});
