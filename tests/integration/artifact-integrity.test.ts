import { randomUUID } from 'node:crypto';
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresAgentRepository,
  blobKeyFor,
  blobLockKey,
  parseStorageKey,
  stagingKeyFor,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createP06Infra, seedTenantAgent, type P06Infra, type Seed } from './support/p0b06.js';

/**
 * B-T13 (artifact integrity and authorization) and B-T14 (orphan staging).
 *
 * Real PostgreSQL + a real temporary blob root owned by this test run.
 */

let db: TestDatabase;
let infra: P06Infra;
let seed: Seed;
let other: Seed;

async function ageFile(absolutePath: string, msAgo: number): Promise<void> {
  const when = new Date(Date.now() - msAgo);

  await utimes(absolutePath, when, when);
}

beforeAll(async () => {
  db = await createTestDatabase();
  infra = await createP06Infra(db);
  const agents = new PostgresAgentRepository(db.pool);

  seed = await seedTenantAgent(db, (ctx, name) => agents.create(ctx, { name }));
  other = await seedTenantAgent(db, (ctx, name) => agents.create(ctx, { name }));
}, 30_000);

afterAll(async () => {
  await infra?.dispose();
  await db?.close();
});

describe('P0B06 B-T13 artifact integrity and authorization', () => {
  it('publishes verified bytes that a tenant can read back intact', async () => {
    const bytes = Buffer.from('durable artifact content', 'utf8');
    const ref = await infra.artifacts.put(seed.ctx, bytes, 'text/plain');

    expect(ref.size).toBe(bytes.byteLength);
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);

    await expect(infra.artifacts.get(seed.ctx, ref.artifactId)).resolves.toEqual(bytes);
    await expect(
      infra.artifacts.verify(seed.ctx, ref.artifactId, ref.sha256, ref.size),
    ).resolves.toBe(true);
    await expect(
      infra.artifacts.verify(seed.ctx, ref.artifactId, ref.sha256, ref.size + 1),
    ).resolves.toBe(false);
  });

  it('reports a missing artifact and another tenant\u2019s artifact identically', async () => {
    const ref = await infra.artifacts.put(other.ctx, Buffer.from('private'), 'text/plain');

    await expect(infra.artifacts.get(seed.ctx, ref.artifactId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      infra.artifacts.verify(seed.ctx, ref.artifactId, ref.sha256, ref.size),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(infra.artifacts.get(seed.ctx, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(infra.artifacts.get(seed.ctx, 'not-a-uuid')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('detects corrupted bytes instead of serving them', async () => {
    const ref = await infra.artifacts.put(seed.ctx, Buffer.from('original'), 'text/plain');
    const absolute = path.join(infra.root.dir, 'blobs', seed.tenant.tenantId, ref.sha256);

    await writeFile(absolute, 'tampered');

    await expect(infra.artifacts.get(seed.ctx, ref.artifactId)).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
    });
    await expect(
      infra.artifacts.verify(seed.ctx, ref.artifactId, ref.sha256, ref.size),
    ).resolves.toBe(false);
  });

  it('rejects path traversal and separator tricks in storage keys', async () => {
    for (const key of [
      `blobs/${seed.tenant.tenantId}/../../etc/passwd`,
      '/etc/passwd',
      `blobs/${seed.tenant.tenantId}/not-a-digest`,
    ]) {
      await expect(infra.files.read(seed.tenant.tenantId, key)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      expect(() => parseStorageKey(key, 'blobs')).toThrow();
    }

    // A staging key is never readable through the blob namespace, even inside the tenant.
    await expect(
      infra.files.read(seed.tenant.tenantId, stagingKeyFor(seed.tenant.tenantId, 'a'.repeat(64))),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('refuses a symlinked blob path that escapes the controlled root', async () => {
    const digest = 'b'.repeat(64);
    const target = blobKeyFor(seed.tenant.tenantId, digest);
    const absolute = path.join(infra.root.dir, ...target.split('/'));

    await symlink('/etc/hostname', absolute);

    await expect(infra.files.read(seed.tenant.tenantId, target)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('enforces the size limit while streaming', async () => {
    await expect(
      infra.blobs.stage(seed.ctx.tenantId, Buffer.alloc(8), 'text/plain', { maxBytes: 4 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const chunks = (async function* generate(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from('streamed-');
      yield Buffer.from('chunks');
    })();

    const staged = await infra.blobs.stage(seed.ctx.tenantId, chunks, 'text/plain');

    expect(staged.size).toBe(Buffer.byteLength('streamed-chunks'));
    // Staging bytes are private: the blob namespace refuses a staging key.
    await expect(
      infra.blobs.read(seed.ctx.tenantId, stagingKeyFor(seed.ctx.tenantId, staged.sha256)),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});

describe('P0B06 B-T14 orphan staging', () => {
  it('keeps bytes that were written but never recorded invisible, then collects them', async () => {
    // A tenant that does not exist makes the metadata insert fail after the bytes landed.
    const phantomTenant = randomUUID();
    const bytes = Buffer.from('orphan bytes', 'utf8');

    const local = await createP06Infra(db);

    try {
      await expect(local.blobs.stage(phantomTenant, bytes, 'text/plain')).rejects.toMatchObject({
        code: 'DB_UNAVAILABLE',
      });

      const stagingDir = path.join(local.root.dir, 'staging', phantomTenant);
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(stagingDir);

      expect(files).toHaveLength(1);

      // The bytes are not reachable as an artifact, and no metadata row exists.
      const rows = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM staged_blobs WHERE tenant_id = $1',
        [phantomTenant],
      );

      expect(rows.rows[0]?.count).toBe('0');

      // Quarantine must elapse before anything is removed.
      const tooEarly = await local.blobs.sweepOrphans(new Date(), { retentionMs: 60_000 });

      expect(tooEarly.removedStaged).toBe(0);
      await expect(readdir(stagingDir)).resolves.toHaveLength(1);

      await ageFile(path.join(stagingDir, files[0] ?? ''), 120_000);

      const swept = await local.blobs.sweepOrphans(new Date(), { retentionMs: 60_000 });

      expect(swept.removedStaged).toBe(1);
      await expect(readdir(stagingDir)).resolves.toHaveLength(0);
    } finally {
      await local.dispose();
    }
  });

  it('never collects bytes that a published artifact or checkpoint still references', async () => {
    const local = await createP06Infra(db);

    try {
      const ref = await local.artifacts.put(seed.ctx, Buffer.from('keep me'), 'text/plain');
      const installed = path.join(local.root.dir, 'blobs', seed.tenant.tenantId, ref.sha256);

      await ageFile(installed, 240_000);

      const dryRun = await local.blobs.sweepOrphans(new Date(), {
        retentionMs: 60_000,
        dryRun: true,
      });

      expect(dryRun.removedBlobs).toBe(0);
      expect(dryRun.removedStaged).toBe(0);

      const report = await local.blobs.sweepOrphans(new Date(), { retentionMs: 60_000 });

      expect(report.removedBlobs).toBe(0);
      await expect(local.artifacts.get(seed.ctx, ref.artifactId)).resolves.toBeDefined();
    } finally {
      await local.dispose();
    }
  });

  it('collects an installed file whose publishing transaction never committed', async () => {
    const local = await createP06Infra(db);

    try {
      const digest = 'c'.repeat(64);
      const key = blobKeyFor(seed.tenant.tenantId, digest);
      const absolute = path.join(local.root.dir, ...key.split('/'));

      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, 'never published');
      await ageFile(absolute, 240_000);

      const report = await local.blobs.sweepOrphans(new Date(), { retentionMs: 60_000 });

      expect(report.removedBlobs).toBe(1);
      await expect(local.files.read(seed.tenant.tenantId, key)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await local.dispose();
    }
  });

  it('refuses a non-positive quarantine window', async () => {
    await expect(infra.blobs.sweepOrphans(new Date(), { retentionMs: 0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('P0B06 P1-4 garbage collection versus a concurrent publish', () => {
  it('retains bytes published while the collector is deciding', async () => {
    const local = await createP06Infra(db);
    const publisher = await db.pool.connect();

    try {
      // An installed file that the collector would otherwise treat as an orphan.
      const digest = 'f'.repeat(64);
      const key = blobKeyFor(seed.tenant.tenantId, digest);
      const absolute = path.join(local.root.dir, ...key.split('/'));

      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, 'published during gc');
      await ageFile(absolute, 240_000);

      // A publisher holds the tenant-digest lock and records the metadata but has not
      // committed yet, so a naive scan already saw "no row".
      await publisher.query('BEGIN');
      await publisher.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        blobLockKey(seed.tenant.tenantId, digest),
      ]);
      await publisher.query(
        `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
         VALUES ($1, $2, $3, 'text/plain', $4)`,
        [seed.tenant.tenantId, digest, Buffer.byteLength('published during gc'), key],
      );

      const sweep = local.blobs.sweepOrphans(new Date(), { retentionMs: 60_000 });
      let settled = false;

      void sweep.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      // The collector must wait for the publisher instead of deleting under it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);

      await publisher.query('COMMIT');

      const report = await sweep;

      expect(report.removedBlobs).toBe(0);
      await expect(local.files.read(seed.tenant.tenantId, key)).resolves.toBeDefined();
    } finally {
      await publisher.query('ROLLBACK').catch(() => undefined);
      publisher.release();
      await local.dispose();
    }
  });

  it('still collects an unreferenced file once no publisher holds the lock', async () => {
    const local = await createP06Infra(db);

    try {
      const digest = 'e'.repeat(64);
      const key = blobKeyFor(seed.tenant.tenantId, digest);
      const absolute = path.join(local.root.dir, ...key.split('/'));

      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, 'nobody references this');
      await ageFile(absolute, 240_000);

      const report = await local.blobs.sweepOrphans(new Date(), { retentionMs: 60_000 });

      expect(report.removedBlobs).toBe(1);
    } finally {
      await local.dispose();
    }
  });
});

describe('P0B06 P2-2 deletion of a referenced artifact', () => {
  it('refuses to delete an artifact a workspace version still references', async () => {
    const ref = await infra.artifacts.put(
      seed.ctx,
      Buffer.from('workspace referenced'),
      'text/plain',
    );
    const base = await infra.workspaces.load(seed.ctx, seed.agentId);

    await infra.workspaces.commit(seed.ctx, seed.agentId, base.version, {
      files: [
        ...base.manifest.files,
        {
          path: 'keep.txt',
          artifactId: ref.artifactId,
          sha256: ref.sha256,
          size: ref.size,
        },
      ],
    });

    await expect(infra.artifacts.delete(seed.ctx, ref.artifactId)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await expect(infra.artifacts.get(seed.ctx, ref.artifactId)).resolves.toEqual(
      Buffer.from('workspace referenced'),
    );
  });

  it('deletes an artifact that nothing references', async () => {
    const ref = await infra.artifacts.put(seed.ctx, Buffer.from('unreferenced'), 'text/plain');

    await expect(infra.artifacts.delete(seed.ctx, ref.artifactId)).resolves.toBeUndefined();
    await expect(infra.artifacts.get(seed.ctx, ref.artifactId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
