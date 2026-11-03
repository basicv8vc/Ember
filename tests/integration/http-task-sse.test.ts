import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server as HttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { TaskEventDtoSchema } from '@ember/contracts';
import { PostgresAgentRepository, PostgresTaskRepository } from '@ember/postgres';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { requireTenantAuth } from '../../apps/api/src/auth/auth-middleware.js';
import type { AppBindings } from '../../apps/api/src/http/app-context.js';
import {
  TaskEventStreamRegistry,
  type TaskEventStreamOptions,
} from '../../apps/api/src/tasks/event-stream.js';
import { TASKS_PATH } from '../../apps/api/src/tasks/constants.js';
import { createTaskRoutes } from '../../apps/api/src/tasks/routes.js';
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

function socketAppFor(
  store: TaskStore,
  streamOptions: TaskEventStreamOptions,
  streamRegistry: TaskEventStreamRegistry,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const authenticator = createDevTokenAuthenticator([
    {
      token: tokenA,
      tenantId: tenantA.tenantId,
      principalId: tenantA.principalId,
      policyVersion: 1,
    },
  ]);
  const tenantAuth = requireTenantAuth({ authenticator });
  app.use(TASKS_PATH, tenantAuth);
  app.use(`${TASKS_PATH}/*`, tenantAuth);
  app.route(TASKS_PATH, createTaskRoutes({ store, streamOptions, streamRegistry }));
  return app;
}

class AbortableBlockingWait {
  private resolveEntered: (() => void) | undefined;
  private readonly entered = new Promise<void>((resolve) => {
    this.resolveEntered = resolve;
  });
  pendingCount = 0;

  readonly wait: NonNullable<TaskEventStreamOptions['wait']> = (_milliseconds, signal) => {
    if (signal.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.pendingCount += 1;
      this.resolveEntered?.();
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.pendingCount -= 1;
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  waitUntilEntered(): Promise<void> {
    return this.entered;
  }
}

async function listen(app: Hono<AppBindings>): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      resolve({ server, url: `http://127.0.0.1:${info.port}` });
    });
    server.once('error', reject);
  });
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function freeTcpPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not determine a temporary TCP port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Revokes everything this fixture granted to the throwaway login.
 *
 * `DROP OWNED BY` is not usable here: it requires membership in the target role (or superuser),
 * which the least-privilege test admin deliberately does not have. The grantor owns the objects,
 * so revoking as the owner is both sufficient and narrower. Best-effort, because this runs on the
 * failure path too - the subsequent `DROP ROLE` reports anything that still depends on the role.
 */
async function revokeRolePrivileges(quotedRole: string, quotedSchema: string): Promise<void> {
  await db.adminPool
    .query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quotedSchema} FROM ${quotedRole}`)
    .catch(() => undefined);
  await db.adminPool
    .query(`REVOKE ALL PRIVILEGES ON SCHEMA ${quotedSchema} FROM ${quotedRole}`)
    .catch(() => undefined);
}

async function createApiDatabaseLogin(): Promise<{
  readonly connectionString: string;
  cleanup(): Promise<void>;
}> {
  const sourceUrl = process.env.TEST_DATABASE_URL;
  if (sourceUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required for the API shutdown integration test');
  }

  const role = `ember_sse_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID().replaceAll('-', '');
  const databaseName = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
  const quotedRole = quotePgIdentifier(role);
  const quotedDatabase = quotePgIdentifier(databaseName);
  const quotedSchema = quotePgIdentifier(db.schema);

  await db.roleAdminPool.query(`CREATE ROLE ${quotedRole} LOGIN PASSWORD '${password}'`);
  try {
    await db.roleAdminPool.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole}`);
    await db.roleAdminPool.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${quotedSchema} TO ${quotedRole}`,
    );
    await db.roleAdminPool.query(
      `ALTER ROLE ${quotedRole} IN DATABASE ${quotedDatabase} SET search_path TO ${quotedSchema}`,
    );
  } catch (error) {
    await db.roleAdminPool
      .query(`ALTER ROLE ${quotedRole} IN DATABASE ${quotedDatabase} RESET ALL`)
      .catch(() => undefined);
    await revokeRolePrivileges(quotedRole, quotedSchema);
    await db.roleAdminPool.query(`DROP ROLE ${quotedRole}`).catch(() => undefined);
    throw error;
  }

  const connectionUrl = new URL(sourceUrl);
  connectionUrl.username = role;
  connectionUrl.password = password;

  return {
    connectionString: connectionUrl.toString(),
    cleanup: async () => {
      await db.roleAdminPool.query(
        `ALTER ROLE ${quotedRole} IN DATABASE ${quotedDatabase} RESET ALL`,
      );
      await revokeRolePrivileges(quotedRole, quotedSchema);
      await db.roleAdminPool.query(`DROP ROLE ${quotedRole}`);
    },
  };
}

function waitForChildOutput(
  child: ChildProcess,
  stdout: () => string,
  stderr: () => string,
  expected: string,
  milliseconds: number,
): Promise<void> {
  if (stdout().includes(expected)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.stdout?.removeListener('data', inspect);
      child.removeListener('exit', exited);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const inspect = (): void => {
      if (stdout().includes(expected)) {
        finish();
      }
    };
    const exited = (): void =>
      finish(new Error(`API process exited before ${expected}; stderr: ${stderr()}`));
    const timer = setTimeout(
      () => finish(new Error(`API process did not log ${expected}; stderr: ${stderr()}`)),
      milliseconds,
    );
    child.stdout?.on('data', inspect);
    child.once('exit', exited);
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

  it('stops PostgreSQL polling when a real Node HTTP client socket disconnects', async () => {
    const taskId = await createTaskWithEvents(0);
    const registry = new TaskEventStreamRegistry();
    const blockingWait = new AbortableBlockingWait();
    const counts = { get: 0, listEvents: 0 };
    const store: TaskStore = {
      get: async (context, id) => {
        counts.get += 1;
        return repo.get(context, id);
      },
      listEvents: async (context, id, options) => {
        counts.listEvents += 1;
        return repo.listEvents(context, id, options);
      },
      create: (context, command) => repo.create(context, command),
    };
    const app = socketAppFor(
      store,
      {
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 120_000,
        now: () => 0,
        wait: blockingWait.wait,
      },
      registry,
    );
    const { server, url } = await listen(app);
    const disconnect = new AbortController();
    let stream: SseReader | undefined;

    try {
      const response = await fetch(`${url}/v1/tasks/${taskId}/stream`, {
        headers: { Authorization: `Bearer ${tokenA}` },
        signal: disconnect.signal,
      });
      expect(response.status).toBe(200);
      stream = readerFor(response);
      const persistedEvents = await repo.listEvents(authA(), taskId, { after: 0, limit: 100 });
      expect(await readSequences(stream, persistedEvents.length)).toEqual(
        persistedEvents.map((event) => event.sequence),
      );

      await blockingWait.waitUntilEntered();
      expect(blockingWait.pendingCount).toBe(1);
      const pendingRead = stream.reader.read().then(
        (result) => (result.done ? 'closed' : 'unexpected-frame'),
        () => 'aborted',
      );
      disconnect.abort();

      const [idle, readResult] = await withTimeout(
        Promise.all([registry.whenIdle(), pendingRead]),
        4_000,
        'socket disconnect cleanup',
      );
      void idle;
      expect(readResult).not.toBe('unexpected-frame');
      expect(blockingWait.pendingCount).toBe(0);
      expect(counts).toEqual({ get: 1, listEvents: 1 });

      const stillServing = await fetch(`${url}/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(stillServing.status).toBe(200);
    } finally {
      disconnect.abort();
      registry.closeAll();
      await stream?.reader.cancel().catch(() => undefined);
      (server as HttpServer).closeAllConnections();
      await closeServer(server);
    }
  });

  it('closes an active SSE socket and PostgreSQL pool on production SIGTERM', async () => {
    const taskId = await createTaskWithEvents(0);
    const login = await createApiDatabaseLogin();
    const port = await freeTcpPort();
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: login.connectionString,
        NODE_ENV: 'test',
        EMBER_ENV: 'test',
        EMBER_HOST: '127.0.0.1',
        EMBER_PORT: String(port),
        EMBER_LOG_LEVEL: 'info',
        EMBER_DB_POOL_MAX: '2',
        EMBER_DEV_AUTH_TENANT_A_TOKEN: tokenA,
        EMBER_DEV_AUTH_TENANT_A_TENANT_ID: tenantA.tenantId,
        EMBER_DEV_AUTH_TENANT_A_PRINCIPAL_ID: tenantA.principalId,
        EMBER_DEV_AUTH_TENANT_A_POLICY_VERSION: '1',
        EMBER_DEV_AUTH_TENANT_B_TOKEN: '',
        EMBER_DEV_AUTH_TENANT_B_TENANT_ID: '',
        EMBER_DEV_AUTH_TENANT_B_PRINCIPAL_ID: '',
        EMBER_DEV_AUTH_TENANT_B_POLICY_VERSION: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stream: SseReader | undefined;

    try {
      await waitForChildOutput(
        child,
        () => stdout,
        () => stderr,
        '"message":"api listening"',
        4_000,
      );
      const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/${taskId}/stream`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(response.status).toBe(200);
      stream = readerFor(response);
      const persistedEvents = await repo.listEvents(authA(), taskId, { after: 0, limit: 100 });
      expect(await readSequences(stream, persistedEvents.length)).toEqual(
        persistedEvents.map((event) => event.sequence),
      );

      const pendingRead = stream.reader.read().then(
        (result) => (result.done ? 'closed' : 'unexpected-frame'),
        () => 'socket-closed',
      );
      child.kill('SIGTERM');
      const readResult = await withTimeout(pendingRead, 4_000, 'SSE socket close on SIGTERM');

      expect(readResult).not.toBe('unexpected-frame');
      const exit = await withTimeout(exited, 4_000, 'API process exit on SIGTERM');
      expect(exit).toEqual({ code: 0, signal: null });
      expect(stdout).toContain('"message":"HTTP server closed"');
      expect(stdout).toContain('"message":"database pool closed"');
      expect(stdout).toContain('"message":"shutdown complete"');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown SIGTERM test failure';
      throw new Error(`${reason}; API stdout: ${stdout}; API stderr: ${stderr}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await withTimeout(exited, 2_000, 'API child process cleanup').catch(() => undefined);
      }
      await stream?.reader.cancel().catch(() => undefined);
      await login.cleanup();
    }
  }, 15_000);
});
