import { randomUUID } from 'node:crypto';
import { TaskEventDtoSchema } from '@ember/contracts';
import { PostgresAgentRepository, PostgresTaskRepository } from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import type { TaskStore } from '../../apps/api/src/tasks/task-store.js';
import { appendTaskEvent } from '../../packages/postgres/src/repositories/event-store.js';
import { chatCommand, createTenantFixture, type TenantFixture } from './support/fixtures.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

interface SseReader {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
  readonly decoder: { decode(input: Uint8Array, options?: { stream?: boolean }): string };
}

let db: TestDatabase;
let repo: PostgresTaskRepository;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let agentA: string;
let tokenA: string;
let tokenB: string;

const authA = (): {
  readonly tenantId: string;
  readonly principalId: string;
  readonly policyVersion: 1;
} => ({
  tenantId: tenantA.tenantId,
  principalId: tenantA.principalId,
  policyVersion: 1,
});

function appFor(store: TaskStore = repo): ReturnType<typeof createApp> {
  return createApp({
    authenticator: createDevTokenAuthenticator([
      {
        token: tokenA,
        tenantId: tenantA.tenantId,
        principalId: tenantA.principalId,
        policyVersion: 1,
      },
      {
        token: tokenB,
        tenantId: tenantB.tenantId,
        principalId: tenantB.principalId,
        policyVersion: 1,
      },
    ]),
    taskStore: store,
  });
}

async function createTaskWithEvents(extraEvents: number): Promise<string> {
  const receipt = await repo.create(
    authA(),
    chatCommand(agentA, `sse-${randomUUID()}`, 'persisted SSE integration event'),
  );
  await appendEvents(receipt.taskId, extraEvents);
  return receipt.taskId;
}

async function appendEvents(taskId: string, count: number): Promise<void> {
  if (count === 0) {
    return;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < count; index += 1) {
      await appendTaskEvent(client, {
        tenantId: tenantA.tenantId,
        taskId,
        phase: 'progress',
        payload: { attempt: index + 1 },
        occurredAt: new Date(Date.UTC(2026, 9, 30, 0, 0, index)),
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function openStream(
  app: ReturnType<typeof createApp>,
  taskId: string,
  options: { readonly lastEventId?: string; readonly token?: string | null } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== null) {
    headers.set('Authorization', `Bearer ${options.token ?? tokenA}`);
  }
  if (options.lastEventId !== undefined) {
    headers.set('Last-Event-ID', options.lastEventId);
  }
  return app.request(`/v1/tasks/${taskId}/stream`, { headers });
}

function readerFor(response: Response): SseReader {
  if (response.body === null) {
    throw new Error('SSE response did not have a body');
  }
  return { reader: response.body.getReader(), buffer: '', decoder: new TextDecoder() };
}

async function nextFrame(stream: SseReader): Promise<string> {
  for (;;) {
    const splitAt = stream.buffer.indexOf('\n\n');
    if (splitAt >= 0) {
      const frame = stream.buffer.slice(0, splitAt);
      stream.buffer = stream.buffer.slice(splitAt + 2);
      return frame;
    }

    const next = await stream.reader.read();
    if (next.done) {
      throw new Error('SSE stream closed before an expected frame');
    }
    stream.buffer += stream.decoder.decode(next.value, { stream: true });
  }
}

async function readSequences(stream: SseReader, count: number): Promise<number[]> {
  const sequences: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const frame = await nextFrame(stream);
    const id = /^id: (\d+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (id === undefined || data === undefined) {
      throw new Error(`invalid task event frame: ${frame}`);
    }
    const dto: unknown = JSON.parse(data);
    expect(TaskEventDtoSchema.safeParse(dto).success).toBe(true);
    expect(Number(id)).toBe((dto as { sequence: number }).sequence);
    sequences.push(Number(id));
  }
  return sequences;
}

async function cancel(stream: SseReader): Promise<void> {
  await stream.reader.cancel();
}

beforeAll(async () => {
  db = await createTestDatabase();
  const agents = new PostgresAgentRepository(db.pool);
  tenantA = await createTenantFixture(db.pool, 'SSE integration tenant A');
  tenantB = await createTenantFixture(db.pool, 'SSE integration tenant B');
  const agent = await agents.create(
    { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 },
    { name: 'SSE integration agent' },
  );
  agentA = agent.agentId;
  repo = new PostgresTaskRepository(db.pool);
  tokenA = `token-${randomUUID()}`;
  tokenB = `token-${randomUUID()}`;
});

afterAll(async () => {
  await db?.close();
});

describe('GET /v1/tasks/:taskId/stream with PostgreSQL', () => {
  it('recovers across multiple disconnects and pages from persisted sequence IDs', async () => {
    const taskId = await createTaskWithEvents(205);
    const app = appFor();
    const allSequences: number[] = [];

    const firstResponse = await openStream(app, taskId);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('content-type')).toContain('text/event-stream');
    const first = readerFor(firstResponse);
    allSequences.push(...(await readSequences(first, 37)));
    await cancel(first);

    const second = readerFor(await openStream(app, taskId, { lastEventId: '37' }));
    allSequences.push(...(await readSequences(second, 63)));
    await cancel(second);

    const third = readerFor(await openStream(app, taskId, { lastEventId: '100' }));
    allSequences.push(...(await readSequences(third, 106)));
    await cancel(third);

    expect(allSequences).toEqual(Array.from({ length: 206 }, (_, index) => index + 1));
  });

  it('includes a committed event written while the initial page is being restored', async () => {
    const taskId = await createTaskWithEvents(99);
    let appendedDuringFirstPage = false;
    const store: TaskStore = {
      get: (context, id) => repo.get(context, id),
      listEvents: async (context, id, options) => {
        const events = await repo.listEvents(context, id, options);
        if (!appendedDuringFirstPage && options?.after === 0) {
          appendedDuringFirstPage = true;
          await appendEvents(taskId, 1);
        }
        return events;
      },
      create: (context, command) => repo.create(context, command),
    };
    const stream = readerFor(await openStream(appFor(store), taskId));

    const sequences = await readSequences(stream, 101);
    await cancel(stream);

    expect(appendedDuringFirstPage).toBe(true);
    expect(sequences).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
  });

  it('replays terminal task events and closes the stream', async () => {
    const taskId = await createTaskWithEvents(0);
    await repo.requestCancel(authA(), taskId);
    const response = await openStream(appFor(), taskId);

    expect(response.status).toBe(200);
    const frames = (await response.text()).split('\n\n').filter(Boolean);
    expect(frames.map((frame) => Number(/^id: (\d+)$/m.exec(frame)?.[1]))).toEqual([1, 2]);
    expect(frames[1]).toContain('"phase":"cancelled"');
  });

  it('rejects missing credentials and cross-tenant subscriptions before the stream starts', async () => {
    const taskId = await createTaskWithEvents(0);
    const app = appFor();

    const anonymous = await openStream(app, taskId, { token: null });
    const foreign = await openStream(app, taskId, { token: tokenB });

    expect(anonymous.status).toBe(401);
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get('content-type')).not.toContain('text/event-stream');
  });
});
