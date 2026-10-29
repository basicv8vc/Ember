import { randomUUID } from 'node:crypto';
import { TASK_INPUT_LIMITS } from '@ember/contracts';
import {
  PostgresAgentRepository,
  PostgresTaskRepository,
  prepareTaskCommand,
  TASK_COMMAND_MAX_BYTES,
} from '@ember/postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
 *
 * ## Registration guard (Review Round 1, P1)
 *
 * This file used to nest all three `describe` blocks inside the `afterAll` callback. Vitest had
 * already collected the file by the time that callback ran, so the suites were never registered
 * and the run silently executed 4 of the 10 tests while CI stayed green. The layout is now the
 * normal one (hooks at file level, suites as siblings), and it is enforced at runtime: every
 * collected test increments `executedTests`, and the final `afterAll` fails the file unless the
 * count matches `EXPECTED_TEST_COUNT`. A regression cannot shrink this file unnoticed again.
 */

/** Tests this file must actually execute. Update deliberately when adding or removing one. */
const EXPECTED_TEST_COUNT = 12;

let executedTests = 0;

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

function computeBody(text: string): Record<string, unknown> {
  return { agent_id: agentA, kind: 'mock.compute', input: { operation: 'sha256', text } };
}

/** UTF-8 size of the serialised body — the quantity `MAX_TASK_BODY_BYTES` actually bounds. */
function bodyByteLength(body: unknown): number {
  return utf8Bytes(JSON.stringify(body));
}

/** UTF-8 size of text that is already serialised (never re-encode a JSON string). */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * A `mock.compute` text whose serialised form is exactly `targetBytes` UTF-8 bytes.
 *
 * 3-byte characters fill the bulk of the text and single-byte padding covers the remainder, so a
 * byte boundary is hit exactly instead of approximately. `JSON.stringify` leaves non-ASCII
 * characters unescaped, so `Buffer.byteLength` is the same count the request stream sees.
 */
function computeTextOfBytes(targetBytes: number): string {
  const remaining = targetBytes - bodyByteLength(computeBody(''));
  const multibyte = Math.floor(remaining / 3);
  const padding = remaining - multibyte * 3;

  return `${'漢'.repeat(multibyte)}${'a'.repeat(padding)}`;
}

/**
 * UTF-8 size of the *persisted* canonical command for the same text.
 *
 * `TASK_COMMAND_MAX_BYTES` is a second, independent 64 KiB gate applied by
 * `prepareTaskCommand` before the row is written. It measures the canonical JSON, which is
 * slightly larger than the wire body (`agent_id` → `agentId`, plus `deadlineAt: null`), so for a
 * `mock.compute` command the effective end-to-end limit is a few bytes below the body cap.
 *
 * The gate throws instead of returning an oversized canonical form, so a rejected command is
 * reported as `TASK_COMMAND_MAX_BYTES + 1`: enough for the assertions below, and never mistaken
 * for a size the persistence layer would accept.
 */
function commandCanonicalBytes(text: string): number {
  try {
    const prepared = prepareTaskCommand({
      agentId: agentA,
      idempotencyKey: 'idem-key-000001',
      kind: 'mock.compute',
      input: { operation: 'sha256', text },
    });

    return Buffer.byteLength(prepared.canonical, 'utf8');
  } catch {
    return TASK_COMMAND_MAX_BYTES + 1;
  }
}

/**
 * Largest `mock.compute` text for which the wire body *and* the canonical command both fit their
 * 64 KiB caps.
 *
 * The canonical form is the wire body with a different envelope, so the two differ by a constant
 * that is measured here on a short text the gate accepts; the loop then corrects against the real
 * gate rather than trusting that arithmetic.
 */
function largestComputeTextFittingBothCaps(): string {
  const sample = 'sha256 sample';
  const envelopeDelta = commandCanonicalBytes(sample) - bodyByteLength(computeBody(sample));
  let bytes = Math.min(MAX_TASK_BODY_BYTES, TASK_COMMAND_MAX_BYTES - envelopeDelta);

  for (;;) {
    const text = computeTextOfBytes(bytes);
    const actual = commandCanonicalBytes(text);

    if (actual <= TASK_COMMAND_MAX_BYTES) {
      return text;
    }

    bytes -= actual - TASK_COMMAND_MAX_BYTES;
  }
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
});

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

  /**
   * Byte-vs-character boundary (Review Round 1, P2).
   *
   * Two independent 64 KiB gates apply to a `mock.compute` body: `MAX_TASK_BODY_BYTES` on the
   * request stream, and `TASK_COMMAND_MAX_BYTES` on the canonical command at persistence. The
   * canonical form is slightly larger than the wire body (`agentId`, `deadlineAt: null`), so the
   * binding end-to-end limit sits a few bytes below the body cap. This asserts both sides of that
   * real boundary with multibyte text, one byte apart, and that the rejected byte writes nothing.
   */
  it('accepts the largest multibyte body both 64 KiB gates allow and rejects one byte more', async () => {
    const before = await countRows(tenantA.tenantId);
    const text = largestComputeTextFittingBothCaps();
    const acceptedBody = JSON.stringify(computeBody(text));

    expect(utf8Bytes(acceptedBody)).toBeLessThanOrEqual(MAX_TASK_BODY_BYTES);
    expect(commandCanonicalBytes(text)).toBe(TASK_COMMAND_MAX_BYTES);
    // The text really is multibyte: the boundary is measured in UTF-8 bytes, not characters.
    expect(text).toContain('漢');
    expect(text.length).toBeLessThan(TASK_INPUT_LIMITS.computeTextMaxChars);

    const accepted = await createTask({ raw: acceptedBody });
    const acceptedPayload = await accepted.text();

    expect(accepted.status, acceptedPayload).toBe(202);
    expect(await countRows(tenantA.tenantId)).toBe(before + 1);

    // One more byte of text: still under the body cap, but over the canonical-command cap.
    const oneByteMore = JSON.stringify(computeBody(`${text}a`));

    expect(utf8Bytes(oneByteMore)).toBe(utf8Bytes(acceptedBody) + 1);
    expect(commandCanonicalBytes(`${text}a`)).toBe(TASK_COMMAND_MAX_BYTES + 1);

    const rejected = await createTask({ raw: oneByteMore });

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    expect(await countRows(tenantA.tenantId)).toBe(before + 1);
  });

  it('measures the cap in bytes, so multibyte text cannot exhaust a character budget', async () => {
    const before = await countRows(tenantA.tenantId);
    // The schema maximum is 64 000 characters, but each character is 3 bytes in UTF-8.
    const multibyte = '漢'.repeat(TASK_INPUT_LIMITS.computeTextMaxChars);

    expect(multibyte.length).toBe(TASK_INPUT_LIMITS.computeTextMaxChars);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(MAX_TASK_BODY_BYTES);

    const rejected = await createTask({ raw: JSON.stringify(computeBody(multibyte)) });

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    expect(await countRows(tenantA.tenantId)).toBe(before);

    // The same character count in ASCII fits under the cap and is accepted: that is the
    // documented compatibility statement between the byte cap and the character limits.
    const asciiBody = JSON.stringify(
      computeBody('x'.repeat(TASK_INPUT_LIMITS.computeTextMaxChars)),
    );

    expect(Buffer.byteLength(asciiBody, 'utf8')).toBeLessThan(MAX_TASK_BODY_BYTES);

    const accepted = await createTask({ raw: asciiBody });
    const acceptedPayload = await accepted.text();

    expect(accepted.status, acceptedPayload).toBe(202);
    expect(await countRows(tenantA.tenantId)).toBe(before + 1);
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

/**
 * Registration guard (Review Round 1, P1).
 *
 * `beforeEach` is registered at file level, so it runs for every collected test in every suite
 * above; the last hook then compares the count with `EXPECTED_TEST_COUNT`. `toBe` (not
 * `toBeGreaterThanOrEqual`) is deliberate: a test that stops being registered must fail the file
 * instead of quietly reducing coverage, which is exactly what CI failed to notice before.
 *
 * The check assumes the whole file runs, which is how `pnpm test:integration` and CI invoke it.
 * A focused run (`vitest -t …`) executes a subset by design; run the file without a name filter
 * to satisfy the guard.
 */
beforeEach(() => {
  executedTests += 1;
});

afterAll(() => {
  expect(
    executedTests,
    `expected ${EXPECTED_TEST_COUNT} tests in this file; if you filtered with -t, re-run without it`,
  ).toBe(EXPECTED_TEST_COUNT);
});
