import { randomUUID } from 'node:crypto';
import { PostgresAgentRepository, PostgresTaskRepository } from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { MAX_TASK_BODY_BYTES } from '../../apps/api/src/tasks/constants.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';

/**
 * `POST /v1/tasks`, `GET /v1/tasks/:taskId`, `GET /v1/tasks/:taskId/events` (P0B-07a)
 * against a real PostgreSQL schema.
 *
 * The unit tests prove the handler logic; this file proves the parts only a real database can
 * settle: that the tenant filter is applied in SQL, that an idempotent replay is served from
 * the persisted row (200, `replayed: true`, one row), that a conflicting reuse of a key is a
 * 409, and that event paging reads real persisted `sequence` values.
 */

const PROMPT = 'integration prompt for the http task api';

let db: TestDatabase;
let app: ReturnType<typeof createApp>;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let agentA: string;
let tokenA: string;
let tokenB: string;

function idempotencyKey(): string {
  return `idem-${randomUUID()}`;
}

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { agent_id: agentA, kind: 'mock.chat', input: { prompt: PROMPT }, ...overrides };
}

interface SendOptions {
  readonly token?: string | null;
  readonly key?: string | null;
  readonly body?: unknown;
  readonly raw?: string;
}

async function send(path: string, method: string, options: SendOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = options.token === undefined ? tokenA : options.token;

  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  if (options.key !== null) {
    headers['Idempotency-Key'] = options.key ?? idempotencyKey();
  }

  return app.request(path, {
    method,
    headers,
    body:
      method === 'POST' ? (options.raw ?? JSON.stringify(options.body ?? chatBody())) : undefined,
  });
}

function createTask(options: SendOptions = {}): Promise<Response> {
  return send('/v1/tasks', 'POST', options);
}

async function countRows(tenantId: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM tasks WHERE tenant_id = $1',
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  db = await createTestDatabase();
  const agents = new PostgresAgentRepository(db.pool);
  tenantA = await createTenantFixture(db.pool, 'http tenant A');
  tenantB = await createTenantFixture(db.pool, 'http tenant B');

  const created = await agents.create(
    { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 },
    { name: 'http agent A' },
  );
  agentA = created.agentId;

  tokenA = `token-${randomUUID()}`;
  tokenB = `token-${randomUUID()}`;
  let requests = 0;

  app = createApp({
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
    requestIdGenerator: () => `it-request-${++requests}`,
    taskStore: new PostgresTaskRepository(db.pool),
  });
});

afterAll(async () => {
  await db?.close();

  describe('POST /v1/tasks', () => {
    it('persists a task for the authenticated tenant and returns 202 with a Location', async () => {
      const key = idempotencyKey();
      const before = await countRows(tenantA.tenantId);

      const response = await createTask({ key });

      expect(response.status).toBe(202);
      const receipt = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(receipt).sort()).toEqual(['accepted_at', 'replayed', 'status', 'task_id']);
      expect(receipt.replayed).toBe(false);
      expect(receipt.status).toBe('queued');
      expect(response.headers.get('Location')).toBe(`/v1/tasks/${String(receipt.task_id)}`);
      expect(await countRows(tenantA.tenantId)).toBe(before + 1);

      // The caller can immediately read back its own task.
      const detail = await send(`/v1/tasks/${String(receipt.task_id)}`, 'GET');
      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        task_id: receipt.task_id,
        agent_id: agentA,
        kind: 'mock.chat',
        status: 'queued',
        attempt_count: 0,
        current_run_id: null,
      });
    });

    it('replays the same key as 200 without creating a second row', async () => {
      const key = idempotencyKey();

      const first = await createTask({ key });
      const second = await createTask({ key });

      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as Record<string, unknown>;
      const secondBody = (await second.json()) as Record<string, unknown>;
      expect(secondBody.task_id).toBe(firstBody.task_id);
      expect(secondBody.replayed).toBe(true);
      // Same facts, same acceptance time: the replay is served from the persisted row.
      expect(secondBody.accepted_at).toBe(firstBody.accepted_at);
      // Request ids still differ, so the replay is traceable as its own request.
      expect(second.headers.get('x-request-id')).not.toBe(first.headers.get('x-request-id'));

      const rows = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2',
        [tenantA.tenantId, key],
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('answers a conflicting reuse of a key with 409 and no driver detail', async () => {
      const key = idempotencyKey();
      await createTask({ key });

      const conflict = await createTask({
        key,
        body: chatBody({ input: { prompt: 'a different prompt with the same key' } }),
      });

      expect(conflict.status).toBe(409);
      const text = await conflict.text();
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(text).not.toContain('digest');
    });

    it('rejects an unauthenticated or unknown credential before touching the database', async () => {
      const before = await countRows(tenantA.tenantId);

      const anonymous = await createTask({ token: null });
      const unknown = await createTask({ token: `token-${randomUUID()}` });

      expect(anonymous.status).toBe(401);
      expect(unknown.status).toBe(401);
      const text = await anonymous.text();
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(await countRows(tenantA.tenantId)).toBe(before);
    });

    it('rejects a missing or malformed Idempotency-Key', async () => {
      const missing = await createTask({ key: null });
      const malformed = await createTask({ key: 'has space' });

      expect(missing.status).toBe(400);
      expect(malformed.status).toBe(400);
      await expect(missing.json()).resolves.toMatchObject({
        error: { code: 'INVALID_ARGUMENT' },
      });
    });

    it('rejects a body above the 64 KiB cap without creating a task', async () => {
      const before = await countRows(tenantA.tenantId);
      const oversized = JSON.stringify(
        chatBody({ input: { prompt: 'x'.repeat(MAX_TASK_BODY_BYTES) } }),
      );

      const response = await createTask({ raw: oversized });

      expect(response.status).toBe(400);
      expect(await countRows(tenantA.tenantId)).toBe(before);
    });
  });
});

describe('tenant isolation on reads', () => {
  it('hides another tenant task behind the same 404 as a missing one', async () => {
    const created = await createTask();
    const body = (await created.json()) as { task_id: string };
    const missingId = randomUUID();

    const foreignDetail = await send(`/v1/tasks/${body.task_id}`, 'GET', { token: tokenB });
    const missingDetail = await send(`/v1/tasks/${missingId}`, 'GET', { token: tokenB });

    expect(foreignDetail.status).toBe(404);
    expect(missingDetail.status).toBe(404);
    const foreignBody = (await foreignDetail.json()) as {
      error: { code: string; message: string; request_id: string };
    };
    const missingBody = (await missingDetail.json()) as typeof foreignBody;
    // Everything but the per-request id is identical: no hint that the id exists elsewhere.
    expect({ code: foreignBody.error.code, message: foreignBody.error.message }).toEqual({
      code: missingBody.error.code,
      message: missingBody.error.message,
    });
    expect(foreignBody.error.request_id).not.toBe(missingBody.error.request_id);

    const foreignEvents = await send(`/v1/tasks/${body.task_id}/events`, 'GET', {
      token: tokenB,
    });
    expect(foreignEvents.status).toBe(404);
    const foreignEventBody = (await foreignEvents.json()) as typeof foreignBody;
    expect({ code: foreignEventBody.error.code, message: foreignEventBody.error.message }).toEqual({
      code: foreignBody.error.code,
      message: foreignBody.error.message,
    });

    // The owner still sees the task, so the 404 above is isolation and not a broken id.
    expect((await send(`/v1/tasks/${body.task_id}`, 'GET')).status).toBe(200);
  });

  it('rejects an unauthenticated read of both endpoints', async () => {
    const created = await createTask();
    const body = (await created.json()) as { task_id: string };

    for (const path of [`/v1/tasks/${body.task_id}`, `/v1/tasks/${body.task_id}/events`]) {
      const response = await send(path, 'GET', { token: null });
      expect(response.status, path).toBe(401);
    }
  });
});

describe('GET /v1/tasks/:taskId/events', () => {
  it('returns persisted events ascending and honours the exclusive cursor', async () => {
    const created = await createTask();
    const body = (await created.json()) as { task_id: string };

    const all = await send(`/v1/tasks/${body.task_id}/events`, 'GET');
    expect(all.status).toBe(200);
    const page = (await all.json()) as {
      task_id: string;
      events: { sequence: number; phase: string; payload: unknown }[];
    };
    expect(page.task_id).toBe(body.task_id);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events[0]?.phase).toBe('accepted');
    const sequences = page.events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    // The redaction contract survives persistence: only allowlisted payload fields.
    expect(Object.keys(page.events[0]?.payload as Record<string, unknown>).sort()).toEqual([
      'policyVersion',
      'replayed',
      'taskKind',
    ]);
    expect(JSON.stringify(page)).not.toContain(PROMPT);

    const lastSequence = sequences[sequences.length - 1] ?? 0;
    const empty = await send(`/v1/tasks/${body.task_id}/events?after=${lastSequence}`, 'GET');
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ task_id: body.task_id, events: [] });

    const firstSequence = sequences[0] ?? 0;
    const afterFirst = await send(
      `/v1/tasks/${body.task_id}/events?after=${String(firstSequence)}`,
      'GET',
    );
    expect(afterFirst.status).toBe(200);
    const nextPage = (await afterFirst.json()) as { events: { sequence: number }[] };
    expect(nextPage.events.map((event) => event.sequence)).toEqual(sequences.slice(1));
  });

  it('rejects a malformed cursor', async () => {
    const created = await createTask();
    const body = (await created.json()) as { task_id: string };

    for (const cursor of ['-1', 'abc', '1.5']) {
      const response = await send(`/v1/tasks/${body.task_id}/events?after=${cursor}`, 'GET');
      expect(response.status, cursor).toBe(400);
    }
  });
});
