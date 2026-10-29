import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';
import { ManualClock, databaseNow } from './support/leases.js';
import { createP06Infra, grantOfContext, type P06Infra } from './support/p0b06.js';

/**
 * P1-1 regression — the same tenant may upload the same bytes repeatedly.
 *
 * The physical staging file is content-addressed and shared; every upload attempt keeps its
 * own `staged_blobs` identity. Before the fix, a second upload of identical bytes for the same
 * tenant hit a unique constraint on `(tenant_id, storage_key)`.
 */

const WORKER_ID = 'worker-p0b06-duplicate';
const CONTENT = Buffer.from('the very same bytes', 'utf8');
const CONTENT_SHA = createHash('sha256').update(CONTENT).digest('hex');

let db: TestDatabase;
let infra: P06Infra;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenant: TenantFixture;
let otherTenant: TenantFixture;
let ctx: AuthContext;
let agentId: string;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let reader: PostgresRunExecutionContextReader;

async function blobFiles(tenantId: string): Promise<readonly string[]> {
  return readdir(path.join(infra.root.dir, 'blobs', tenantId)).catch(() => [] as string[]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  infra = await createP06Infra(db);
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool);
  otherTenant = await createTenantFixture(db.pool, 'duplicate upload other tenant');
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 3 };
  agentId = (await agents.create(ctx, { name: 'duplicate upload agent' })).agentId;
  clock = new ManualClock(new Date('2026-10-29T00:00:00.000Z'));
  queue = new PostgresLeaseQueue(db.pool, {
    leaseDurationMs: 5_000,
    heartbeatIntervalMs: 500,
    baseDelayMs: 100,
    capDelayMs: 100,
    reaperBatchSize: 10,
    clock,
  });
  reader = new PostgresRunExecutionContextReader(db.pool, clock);
}, 30_000);

afterAll(async () => {
  await infra?.dispose();
  await db?.close();
});

describe('P0B06 P1-1 duplicate upload of identical bytes', () => {
  it('accepts three sequential uploads of the same bytes with distinct artifact ids', async () => {
    const first = await infra.artifacts.put(ctx, CONTENT, 'text/plain');
    const second = await infra.artifacts.put(ctx, CONTENT, 'text/plain');
    const third = await infra.artifacts.put(ctx, CONTENT, 'text/plain');

    expect(new Set([first.artifactId, second.artifactId, third.artifactId]).size).toBe(3);
    expect(second.sha256).toBe(first.sha256);

    for (const ref of [first, second, third]) {
      await expect(infra.artifacts.get(ctx, ref.artifactId)).resolves.toEqual(CONTENT);
    }

    // One physical copy, one blob row, three artifact rows.
    expect(await blobFiles(tenant.tenantId)).toEqual([CONTENT_SHA]);

    const artifacts = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND sha256 = $2',
      [tenant.tenantId, CONTENT_SHA],
    );
    const blobs = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM blobs WHERE tenant_id = $1 AND sha256 = $2',
      [tenant.tenantId, CONTENT_SHA],
    );

    expect(artifacts.rows[0]?.count).toBe('3');
    expect(blobs.rows[0]?.count).toBe('1');
  });

  it('accepts eight concurrent uploads of the same bytes', async () => {
    const refs = await Promise.all(
      Array.from({ length: 8 }, () => infra.artifacts.put(ctx, CONTENT, 'text/plain')),
    );

    expect(new Set(refs.map((ref) => ref.artifactId)).size).toBe(8);
    expect(await blobFiles(tenant.tenantId)).toEqual([CONTENT_SHA]);
    await expect(infra.artifacts.get(ctx, refs[7]!.artifactId)).resolves.toEqual(CONTENT);
  });

  it('keeps one staging identity per attempt for the same content key', async () => {
    const first = await infra.blobs.stage(tenant.tenantId, CONTENT, 'text/plain');
    const second = await infra.blobs.stage(tenant.tenantId, CONTENT, 'text/plain');

    expect(first.stagedId).not.toBe(second.stagedId);
    expect(first.storageKey).toBe(second.storageKey);

    // Other tests in this file share the same content key, so the assertion is scoped to the
    // two attempts created here.
    const ids = [first.stagedId, second.stagedId];
    const rows = await db.pool.query<{ id: string; state: string }>(
      `SELECT id, state FROM staged_blobs
        WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY created_at, id`,
      [tenant.tenantId, ids],
    );

    expect(rows.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(rows.rows.every((row) => row.state === 'pending')).toBe(true);

    // Installing one attempt settles only that attempt.
    await infra.blobs.install(tenant.tenantId, first);

    const after = await db.pool.query<{ id: string; state: string }>(
      `SELECT id, state FROM staged_blobs
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenant.tenantId, ids],
    );

    expect(new Map(after.rows.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [first.stagedId, 'published'],
        [second.stagedId, 'pending'],
      ]),
    );
  });
});

describe('P0B06 P1-1 duplicate upload across Tasks', () => {
  async function claim(): Promise<ReturnType<typeof grantOfContext>> {
    clock.set(new Date((await databaseNow(db.pool)).getTime() + 1));
    const lease = await queue.claimNext(WORKER_ID, clock.now());

    if (lease === null) {
      throw new Error('expected a claimable task');
    }

    return grantOfContext(await reader.read(lease, clock.now()));
  }

  it('publishes identical bytes from two different Tasks of the same tenant', async () => {
    await tasks.create(ctx, {
      agentId,
      idempotencyKey: `dup-a-${randomUUID()}`,
      kind: 'mock.chat',
      input: { prompt: 'duplicate across tasks' },
    });
    const firstGrant = await claim();
    const firstStaged = await infra.blobs.stage(tenant.tenantId, CONTENT, 'text/plain');
    const first = await infra.committer.commitStep(firstGrant, {
      operationId: 'step:result:dup-a',
      mode: 'result',
      artifacts: [{ artifactId: firstStaged.stagedId, staged: firstStaged }],
    });

    await tasks.create(ctx, {
      agentId,
      idempotencyKey: `dup-b-${randomUUID()}`,
      kind: 'mock.chat',
      input: { prompt: 'duplicate across tasks' },
    });
    const secondGrant = await claim();
    const secondStaged = await infra.blobs.stage(tenant.tenantId, CONTENT, 'text/plain');
    const second = await infra.committer.commitStep(secondGrant, {
      operationId: 'step:result:dup-b',
      mode: 'result',
      artifacts: [{ artifactId: secondStaged.stagedId, staged: secondStaged }],
    });

    expect(firstGrant.taskId).not.toBe(secondGrant.taskId);
    expect(first.artifactIds[0]).not.toBe(second.artifactIds[0]);

    // Both Tasks published successfully against a single physical copy.
    expect(await blobFiles(tenant.tenantId)).toEqual([CONTENT_SHA]);

    const perTask = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts
        WHERE tenant_id = $1 AND sha256 = $2`,
      [tenant.tenantId, CONTENT_SHA],
    );

    expect(Number(perTask.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(2);
  });

  it('keeps tenants isolated even for identical content', async () => {
    const foreignCtx: AuthContext = {
      tenantId: otherTenant.tenantId,
      principalId: otherTenant.principalId,
      policyVersion: 1,
    };
    const mine = await infra.artifacts.put(ctx, CONTENT, 'text/plain');
    const theirs = await infra.artifacts.put(foreignCtx, CONTENT, 'text/plain');

    expect(theirs.sha256).toBe(mine.sha256);
    await expect(infra.artifacts.get(ctx, theirs.artifactId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await blobFiles(tenant.tenantId)).toEqual([CONTENT_SHA]);
    expect(await blobFiles(otherTenant.tenantId)).toEqual([CONTENT_SHA]);
  });
});
