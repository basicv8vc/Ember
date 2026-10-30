import { randomUUID } from 'node:crypto';
import { DomainError, type AuthContext, type TaskEvent, type TaskStatus } from '@ember/domain';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import type { AppBindings } from '../../apps/api/src/http/app-context.js';
import { createTaskRoutes, parseStreamCursor } from '../../apps/api/src/tasks/routes.js';
import {
  TaskEventStreamRegistry,
  type TaskEventStreamOptions,
} from '../../apps/api/src/tasks/event-stream.js';
import type { TaskStore } from '../../apps/api/src/tasks/task-store.js';
import {
  buildEvent,
  buildTaskView,
  createFakeTaskApi,
  type FakeTaskApi,
} from './support/task-api-fakes.js';

const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const TOKEN = `token-${randomUUID()}`;
const TASK_ID = randomUUID();
const AUTH: AuthContext = { tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 1 };

interface ControlledWait {
  readonly milliseconds: number;
  readonly signal: AbortSignal;
  advance(): void;
}

class ControlledClock {
  private time = 0;
  private readonly waiters: ControlledWait[] = [];
  private readonly readyCallbacks: (() => void)[] = [];

  readonly now = (): number => this.time;

  readonly wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (advance: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (advance) {
          this.time += milliseconds;
        }
        resolve();
      };
      const onAbort = (): void => finish(false);
      const waiter: ControlledWait = {
        milliseconds,
        signal,
        advance: () => finish(true),
      };

      if (signal.aborted) {
        finish(false);
        return;
      }

      this.waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
      this.readyCallbacks.splice(0).forEach((callback) => callback());
    });

  async waitForNextWait(): Promise<ControlledWait> {
    if (this.waiters.length === 0) {
      await new Promise<void>((resolve) => this.readyCallbacks.push(resolve));
    }

    const next = this.waiters.shift();
    if (next === undefined) {
      throw new Error('controlled clock was notified without a pending wait');
    }
    return next;
  }
}

function createRouteApp(
  store: TaskStore,
  options: TaskEventStreamOptions = {},
  registry = new TaskEventStreamRegistry(),
): { readonly app: Hono<AppBindings>; readonly registry: TaskEventStreamRegistry } {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('auth', AUTH);
    c.set('requestId', 'unit-stream');
    await next();
  });
  app.route(
    '/v1/tasks',
    createTaskRoutes({ store, streamOptions: options, streamRegistry: registry }),
  );
  return { app, registry };
}

function setTask(api: FakeTaskApi, status: TaskStatus = 'queued'): void {
  api.addTask(TENANT_ID, buildTaskView({ taskId: TASK_ID, status }));
}

function safeEvent(sequence: number, phase: TaskEvent['phase'] = 'progress'): TaskEvent {
  return buildEvent(sequence, { taskId: TASK_ID, phase });
}

async function open(
  app: Hono<AppBindings>,
  options: {
    readonly query?: string;
    readonly lastEventId?: string;
    readonly token?: string | null;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== null) {
    headers.set('Authorization', `Bearer ${options.token ?? TOKEN}`);
  }
  if (options.lastEventId !== undefined) {
    headers.set('Last-Event-ID', options.lastEventId);
  }
  const query = options.query === undefined ? '' : `?${options.query}`;
  return app.request(`/v1/tasks/${TASK_ID}/stream${query}`, { headers });
}

function parseFrames(text: string): readonly string[] {
  return text.split('\n\n').filter((frame) => frame.length > 0);
}

function frameSequence(frame: string): number {
  const match = /^id: (\d+)$/m.exec(frame);
  if (match === null) {
    throw new Error(`SSE frame did not contain an id: ${frame}`);
  }
  return Number(match[1]);
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const next = await reader.read();
  if (next.done) {
    throw new Error('SSE stream closed before an expected frame');
  }
  return new TextDecoder().decode(next.value).replace(/\n\n$/, '');
}

describe('SSE cursor rules', () => {
  it('defaults to sequence zero, accepts either cursor, and accepts matching dual cursors', () => {
    expect(parseStreamCursor([], undefined)).toEqual({ ok: true, after: 0 });
    expect(parseStreamCursor(['7'], undefined)).toEqual({ ok: true, after: 7 });
    expect(parseStreamCursor([], '7')).toEqual({ ok: true, after: 7 });
    expect(parseStreamCursor(['7'], '7')).toEqual({ ok: true, after: 7 });
  });

  it('rejects malformed, repeated, oversized, negative, and conflicting cursors', () => {
    for (const result of [
      parseStreamCursor([''], undefined),
      parseStreamCursor(['-1'], undefined),
      parseStreamCursor(['1.5'], undefined),
      parseStreamCursor(['9999999999999999'], undefined),
      parseStreamCursor([], '9999999999999999'),
      parseStreamCursor(['2', '2'], undefined),
      parseStreamCursor(['2'], '3'),
    ]) {
      expect(result).toEqual({ ok: false });
    }
  });
});

describe('SSE durable history and reconnect', () => {
  it('replays every page from sequence zero in increasing persistent order', async () => {
    const api = createFakeTaskApi();
    setTask(api, 'completed');
    api.addEvents(
      TENANT_ID,
      TASK_ID,
      Array.from({ length: 205 }, (_, index) =>
        safeEvent(index + 1, index === 204 ? 'completed' : 'progress'),
      ),
    );
    const { app } = createRouteApp(api.store);

    const response = await open(app);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = parseFrames(await response.text());

    expect(frames.map(frameSequence)).toEqual(Array.from({ length: 205 }, (_, i) => i + 1));
    expect(frames.every((frame) => frame.startsWith('id: ') && frame.includes('event: task'))).toBe(
      true,
    );
    expect(api.eventReads.map((read) => read.options?.after)).toEqual([0, 100, 200]);
  });

  it('uses Last-Event-ID to reconnect without repeating already delivered events', async () => {
    const api = createFakeTaskApi();
    setTask(api, 'completed');
    api.addEvents(TENANT_ID, TASK_ID, [
      safeEvent(1, 'accepted'),
      safeEvent(2),
      safeEvent(3, 'completed'),
    ]);
    const { app } = createRouteApp(api.store);

    const first = await open(app);
    const firstReader = first.body?.getReader();
    if (firstReader === undefined) {
      throw new Error('SSE response did not have a body');
    }
    const firstSequence = frameSequence(await readFrame(firstReader));
    await firstReader.cancel();

    const resumed = await open(app, { lastEventId: String(firstSequence) });
    const remaining = parseFrames(await resumed.text()).map(frameSequence);

    expect([firstSequence, ...remaining]).toEqual([1, 2, 3]);
    expect(api.eventReads[1]?.options).toEqual({ after: 1, limit: 100 });
  });

  it('rejects conflicting query and Last-Event-ID cursors before reading task data', async () => {
    const api = createFakeTaskApi();
    setTask(api);
    const { app } = createRouteApp(api.store);

    const conflict = await open(app, { query: 'after=2', lastEventId: '3' });
    const repeated = await open(app, { query: 'after=2&after=2' });
    const oversized = await open(app, { query: 'after=9999999999999999' });

    expect(conflict.status).toBe(400);
    expect(repeated.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(api.gets).toEqual([]);
    expect(api.eventReads).toEqual([]);
  });

  it('includes an event committed while the initial history page is being restored', async () => {
    const api = createFakeTaskApi();
    setTask(api, 'completed');
    api.addEvents(
      TENANT_ID,
      TASK_ID,
      Array.from({ length: 100 }, (_, index) => safeEvent(index + 1)),
    );
    let appended = false;
    const store: TaskStore = {
      ...api.store,
      listEvents: async (context, taskId, options) => {
        const page = await api.store.listEvents(context, taskId, options);
        if (!appended) {
          appended = true;
          api.addEvents(TENANT_ID, TASK_ID, [
            ...Array.from({ length: 100 }, (_, i) => safeEvent(i + 1)),
            safeEvent(101, 'completed'),
          ]);
        }
        return page;
      },
    };
    const { app } = createRouteApp(store);

    const response = await open(app);
    expect(parseFrames(await response.text()).map(frameSequence)).toEqual(
      Array.from({ length: 101 }, (_, i) => i + 1),
    );
  });

  it('returns a terminal task history and closes after replay', async () => {
    const api = createFakeTaskApi();
    setTask(api, 'cancelled');
    api.addEvents(TENANT_ID, TASK_ID, [safeEvent(1, 'accepted'), safeEvent(2, 'cancelled')]);
    const { app } = createRouteApp(api.store);

    const response = await open(app, { query: 'after=0' });

    expect(parseFrames(await response.text()).map(frameSequence)).toEqual([1, 2]);
    expect(api.eventReads).toHaveLength(1);
  });
});

describe('SSE heartbeat, authorization, and lifecycle', () => {
  it('sends a comment heartbeat without an id or event-store cursor advance', async () => {
    const api = createFakeTaskApi();
    setTask(api, 'running');
    api.addEvents(TENANT_ID, TASK_ID, [safeEvent(1, 'accepted')]);
    const clock = new ControlledClock();
    const { app } = createRouteApp(api.store, {
      now: clock.now,
      wait: clock.wait,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 5,
    });

    const response = await open(app);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error('SSE response did not have a body');
    }
    expect(frameSequence(await readFrame(reader))).toBe(1);
    const heartbeatRead = reader.read();
    (await clock.waitForNextWait()).advance();
    const heartbeat = await heartbeatRead;

    if (heartbeat.done || !(heartbeat.value instanceof Uint8Array)) {
      throw new Error('SSE stream closed before its heartbeat');
    }
    const frame = new TextDecoder().decode(heartbeat.value);
    expect(frame).toContain(': keep-alive');
    expect(frame).not.toContain('id:');
    expect(api.eventReads).toHaveLength(1);
    await reader.cancel();
  });

  it('stops polling and releases its registry entry when the client disconnects', async () => {
    const api = createFakeTaskApi();
    setTask(api, 'running');
    api.addEvents(TENANT_ID, TASK_ID, [safeEvent(1, 'accepted')]);
    const clock = new ControlledClock();
    const registry = new TaskEventStreamRegistry();
    const { app } = createRouteApp(
      api.store,
      { now: clock.now, wait: clock.wait, pollIntervalMs: 10, heartbeatIntervalMs: 100 },
      registry,
    );
    const response = await open(app);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error('SSE response did not have a body');
    }
    await readFrame(reader);
    const pending = reader.read();
    const wait = await clock.waitForNextWait();

    await reader.cancel();

    expect(wait.signal.aborted).toBe(true);
    expect(registry.activeCount).toBe(0);
    expect(api.eventReads).toHaveLength(1);
    void pending;
  });

  it('aborts live streams on server shutdown', async () => {
    const api = createFakeTaskApi();
    setTask(api, 'running');
    api.addEvents(TENANT_ID, TASK_ID, [safeEvent(1, 'accepted')]);
    const clock = new ControlledClock();
    const registry = new TaskEventStreamRegistry();
    const { app } = createRouteApp(
      api.store,
      { now: clock.now, wait: clock.wait, pollIntervalMs: 10, heartbeatIntervalMs: 100 },
      registry,
    );
    const response = await open(app);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error('SSE response did not have a body');
    }
    await readFrame(reader);
    const pending = reader.read();
    const wait = await clock.waitForNextWait();

    registry.closeAll();
    const end = await pending;

    expect(wait.signal.aborted).toBe(true);
    expect(end.done).toBe(true);
    expect(registry.activeCount).toBe(0);
    expect(api.eventReads).toHaveLength(1);
  });

  it('rejects missing and invalid tokens before opening a stream', async () => {
    const api = createFakeTaskApi();
    setTask(api);
    const app = createApp({
      requestIdGenerator: () => 'unit-sse-auth',
      authenticator: createDevTokenAuthenticator([
        { token: TOKEN, tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 1 },
      ]),
      taskStore: api.store,
    });

    const anonymous = await app.request(`/v1/tasks/${TASK_ID}/stream`);
    const invalid = await app.request(`/v1/tasks/${TASK_ID}/stream`, {
      headers: { Authorization: 'Bearer invalid-token' },
    });

    expect(anonymous.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(api.gets).toEqual([]);
    expect(api.eventReads).toEqual([]);
  });

  it('returns the same 404 for a missing or foreign task before reading events', async () => {
    const api = createFakeTaskApi();
    api.addTask(OTHER_TENANT_ID, buildTaskView({ taskId: TASK_ID }));
    api.addEvents(OTHER_TENANT_ID, TASK_ID, [safeEvent(1)]);
    const app = createApp({
      requestIdGenerator: () => 'unit-sse-404',
      authenticator: createDevTokenAuthenticator([
        { token: TOKEN, tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 1 },
      ]),
      taskStore: api.store,
    });

    const response = await app.request(`/v1/tasks/${TASK_ID}/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const missing = await app.request(`/v1/tasks/${randomUUID()}/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await response.json());
    expect(api.eventReads).toEqual([]);
  });

  it('maps an initial EventStore failure to 503 before streaming headers are sent', async () => {
    const api = createFakeTaskApi();
    setTask(api);
    const store: TaskStore = {
      ...api.store,
      listEvents: () =>
        Promise.reject(new DomainError('DB_UNAVAILABLE', 'private database diagnostic')),
    };
    const app = createApp({
      authenticator: createDevTokenAuthenticator([
        { token: TOKEN, tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 1 },
      ]),
      taskStore: store,
    });

    const response = await app.request(`/v1/tasks/${TASK_ID}/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('private database diagnostic');
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
  });

  it('closes a live stream on a later EventStore failure without exposing diagnostics', async () => {
    const api = createFakeTaskApi();
    setTask(api, 'running');
    let eventReads = 0;
    const store: TaskStore = {
      ...api.store,
      listEvents: () => {
        eventReads += 1;
        return eventReads === 1
          ? Promise.resolve([safeEvent(1, 'accepted')])
          : Promise.reject(new DomainError('DB_UNAVAILABLE', 'private database diagnostic'));
      },
    };
    const clock = new ControlledClock();
    const { app } = createRouteApp(store, {
      now: clock.now,
      wait: clock.wait,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
    });
    const response = await open(app);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error('SSE response did not have a body');
    }
    expect(frameSequence(await readFrame(reader))).toBe(1);
    const next = reader.read();
    (await clock.waitForNextWait()).advance();

    const closed = await next;

    expect(response.status).toBe(200);
    expect(closed.done).toBe(true);
    expect(eventReads).toBe(2);
    expect(api.creates).toEqual([]);
  });

  it('rejects an event payload that violates the shared redaction schema', async () => {
    const api = createFakeTaskApi();
    setTask(api);
    api.addEvents(TENANT_ID, TASK_ID, [
      buildEvent(1, {
        taskId: TASK_ID,
        payload: { prompt: 'must-not-leak' } as unknown as TaskEvent['payload'],
      }),
    ]);
    const app = createApp({
      authenticator: createDevTokenAuthenticator([
        { token: TOKEN, tenantId: TENANT_ID, principalId: PRINCIPAL_ID, policyVersion: 1 },
      ]),
      taskStore: api.store,
    });

    const response = await app.request(`/v1/tasks/${TASK_ID}/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('must-not-leak');
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
  });
});
