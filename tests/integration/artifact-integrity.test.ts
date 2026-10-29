import { createHash, randomUUID } from 'node:crypto';
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlobStore } from '@ember/contracts';
import {
  PostgresAgentRepository,
  PostgresArtifactStore,
  WorkspaceConflictSignal,
  blobKeyFor,
  blobLockKey,
  commitWorkspaceInTransaction,
  parseStorageKey,
  recordWorkspaceConflictIn,
  stagingKeyFor,
} from '@ember/postgres';
import { createTestDatabase, backendPid, type TestDatabase } from './support/database.js';
import {
  observeAdvisoryLock,
  resolveAdvisoryLockIdentity,
  waitForAdvisoryLockQueueEntry,
} from './support/advisory-locks.js';
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

/** Wait until `blocker` is the session that keeps another statement waiting. */
async function waitForRowLockWaiter(blocker: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [blocker],
    );

    if (Number(result.rows[0]?.count ?? '0') > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('timed out waiting for a row lock waiter');
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

/**
 * Round 3 review, P1-A.
 *
 * `put()` installs bytes *before* it opens its publishing transaction, so the collector can
 * legitimately win the digest lock in that window and delete the (still unreferenced) file.
 * The publish must then write nothing instead of committing rows that point at missing bytes.
 */
describe('P0B06 P1-A an upload that loses to the collector', () => {
  it('writes nothing when a real sweep deletes the bytes before the upload publishes', async () => {
    const local = await createP06Infra(db);
    const blocker = await db.pool.connect();
    const bytes = Buffer.from('upload racing a sweep', 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const key = blobKeyFor(seed.tenant.tenantId, digest);
    const absolute = path.join(local.root.dir, ...key.split('/'));

    try {
      // The digest file is installed (as `install` leaves it) but nothing references it yet.
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      await ageFile(absolute, 240_000);

      // Holding the tenant-digest lock stalls the collector and the upload alike. The barrier
      // below waits on that exact lock identity in `pg_locks`, so an unrelated advisory lock
      // waiter elsewhere in this shared test database can never satisfy it.
      const lockKey = blobLockKey(seed.tenant.tenantId, digest);
      const blockerPid = await backendPid(blocker);

      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

      // Precondition: that exact lock is held by this session and nothing is queued on it yet,
      // so the collector observed below is necessarily the first arrival.
      const held = await observeAdvisoryLock(
        db.pool,
        await resolveAdvisoryLockIdentity(db.pool, lockKey),
      );

      expect(held).toEqual([{ pid: blockerPid, granted: true, blockedBy: [] }]);

      const sweep = local.blobs.sweepOrphans(new Date(), { retentionMs: 60_000 });
      const collector = await waitForAdvisoryLockQueueEntry(db.pool, { lockKey, blockerPid });

      // `put` stages, "installs" (the digest file already exists, so install verifies and
      // returns) and then queues for the same lock, behind the collector.
      const upload = local.artifacts.put(seed.ctx, bytes, 'text/plain');
      const publisher = await waitForAdvisoryLockQueueEntry(db.pool, {
        lockKey,
        blockerPid,
        aheadOf: [collector.pid],
      });

      // The collector reached the lock first, so the upload is queued behind it and loses.
      expect(publisher.pid).not.toBe(collector.pid);
      expect(publisher.blockedBy).toEqual(expect.arrayContaining([blockerPid, collector.pid]));

      await blocker.query('COMMIT');

      const report = await sweep;

      expect(report.removedBlobs).toBe(1);
      await expect(upload).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });

      // Zero writes: no metadata may describe bytes the collector has already removed.
      const rows = await db.pool.query<{ artifacts: string; blobs: string }>(
        `SELECT (SELECT count(*)::text FROM artifacts WHERE tenant_id = $1 AND sha256 = $2)
                  AS artifacts,
                (SELECT count(*)::text FROM blobs WHERE tenant_id = $1 AND sha256 = $2)
                  AS blobs`,
        [seed.tenant.tenantId, digest],
      );

      expect(rows.rows[0]?.artifacts).toBe('0');
      expect(rows.rows[0]?.blobs).toBe('0');
      await expect(local.files.read(seed.tenant.tenantId, key)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await local.dispose();
    }
  });
  it('publishes and keeps the bytes when the upload reaches the lock before the collector', async () => {
    const local = await createP06Infra(db);
    const blocker = await db.pool.connect();
    const bytes = Buffer.from('upload beating the sweep', 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const key = blobKeyFor(seed.tenant.tenantId, digest);
    const absolute = path.join(local.root.dir, ...key.split('/'));

    try {
      // The same install-then-publish window, with the arrival order reversed: this is the
      // legitimate schedule and must not be reported as the P1-A race.
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      await ageFile(absolute, 240_000);

      const lockKey = blobLockKey(seed.tenant.tenantId, digest);
      const blockerPid = await backendPid(blocker);

      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

      const upload = local.artifacts.put(seed.ctx, bytes, 'text/plain');
      const publisher = await waitForAdvisoryLockQueueEntry(db.pool, { lockKey, blockerPid });

      const sweep = local.blobs.sweepOrphans(new Date(), { retentionMs: 60_000 });
      const collector = await waitForAdvisoryLockQueueEntry(db.pool, {
        lockKey,
        blockerPid,
        aheadOf: [publisher.pid],
      });

      expect(collector.pid).not.toBe(publisher.pid);
      expect(collector.blockedBy).toEqual(expect.arrayContaining([blockerPid, publisher.pid]));

      await blocker.query('COMMIT');

      // The publisher committed first, so the collector must see the metadata and keep the file.
      const ref = await upload;
      const report = await sweep;

      expect(report.removedBlobs).toBe(0);
      await expect(local.files.read(seed.tenant.tenantId, key)).resolves.toBeDefined();
      await expect(local.artifacts.get(seed.ctx, ref.artifactId)).resolves.toEqual(bytes);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await local.dispose();
    }
  });

  it('writes nothing when the installed file is already gone at publication time', async () => {
    const local = await createP06Infra(db);
    const bytes = Buffer.from('swept between install and publish', 'utf8');

    try {
      // Deterministic form of the same race: the collector removed the file while `put` was
      // between `install` and its publishing transaction.
      const blobs: BlobStore = {
        stage: (tenantId, source, mediaType, options) =>
          local.blobs.stage(tenantId, source, mediaType, options),
        install: async (tenantId, staged) => {
          const installed = await local.blobs.install(tenantId, staged);

          await local.files.removeKey(installed.storageKey, 'blobs');

          return installed;
        },
        read: (tenantId, storageKey) => local.blobs.read(tenantId, storageKey),
        verifyContent: (tenantId, sha256, size) =>
          local.blobs.verifyContent(tenantId, sha256, size),
        assertInstalled: (tenantId, sha256, size) =>
          local.blobs.assertInstalled(tenantId, sha256, size),
        verify: (tenantId, storageKey, expectedSha256, expectedSize) =>
          local.blobs.verify(tenantId, storageKey, expectedSha256, expectedSize),
        discard: (tenantId, staged) => local.blobs.discard(tenantId, staged),
        sweepOrphans: (now, options) => local.blobs.sweepOrphans(now, options),
      };

      const store = new PostgresArtifactStore(db.pool, blobs);

      await expect(store.put(seed.ctx, bytes, 'text/plain')).rejects.toMatchObject({
        code: 'DB_UNAVAILABLE',
      });

      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM artifacts
          WHERE tenant_id = $1 AND sha256 = $2`,
        [seed.tenant.tenantId, createHash('sha256').update(bytes).digest('hex')],
      );

      expect(rows.rows[0]?.count).toBe('0');
    } finally {
      await local.dispose();
    }
  });
});

/**
 * Round 3 review, P1-B.
 *
 * `delete()` used to evaluate its JSONB reference predicates with a plain `SELECT`, so a
 * concurrent writer could commit a *new* reference in the window between that check and the
 * `DELETE`, leaving a dangling Artifact id behind. The fix is a shared row-lock protocol:
 * writers hold `FOR SHARE` on every referenced Artifact row, `delete()` takes `FOR UPDATE`
 * before it looks at references.
 */
describe('P0B06 P1-B artifact deletion versus a concurrent reference writer', () => {
  it('waits for an uncommitted Workspace version and then refuses', async () => {
    const bytes = Buffer.from('version pinned bytes', 'utf8');
    const ref = await infra.artifacts.put(seed.ctx, bytes, 'text/plain');
    const base = await infra.workspaces.load(seed.ctx, seed.agentId);
    const writer = await db.pool.connect();

    try {
      await writer.query('BEGIN');
      const committed = await commitWorkspaceInTransaction(writer, {
        tenantId: seed.tenant.tenantId,
        agentId: seed.agentId,
        expectedVersion: base.version,
        manifest: {
          files: [
            ...base.manifest.files,
            {
              path: 'pinned-version.bin',
              artifactId: ref.artifactId,
              sha256: ref.sha256,
              size: ref.size,
            },
          ],
        },
        allowMerge: true,
      });

      // The version row exists but is uncommitted: the writer holds `FOR SHARE` on the row.
      const deletion = infra.artifacts.delete(seed.ctx, ref.artifactId);
      await waitForRowLockWaiter(await backendPid(writer));

      await writer.query('COMMIT');
      await expect(deletion).rejects.toMatchObject({ code: 'POLICY_DENIED' });

      // The version is durable and its Artifact reference still resolves.
      await expect(infra.artifacts.get(seed.ctx, ref.artifactId)).resolves.toEqual(bytes);
      expect(committed.version).toBe(base.version + 1);

      const versions = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM workspace_versions
          WHERE tenant_id = $1 AND workspace_id = $2 AND version = $3`,
        [seed.tenant.tenantId, base.workspaceId, committed.version],
      );

      expect(versions.rows[0]?.count).toBe('1');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });

  it('waits for an uncommitted conflict candidate and then refuses', async () => {
    const bytes = Buffer.from('conflict pinned bytes', 'utf8');
    const ref = await infra.artifacts.put(seed.ctx, bytes, 'text/plain');
    const base = await infra.workspaces.load(seed.ctx, seed.agentId);
    const workspaceId = base.workspaceId;

    if (workspaceId === undefined) {
      throw new Error('expected a materialised workspace');
    }

    const writer = await db.pool.connect();

    try {
      await writer.query('BEGIN');
      await recordWorkspaceConflictIn(
        writer,
        seed.tenant.tenantId,
        new WorkspaceConflictSignal({
          workspaceId,
          baseVersion: base.version,
          currentVersion: Math.max(1, base.version + 1),
          candidate: {
            files: [
              {
                path: 'pinned-conflict.bin',
                artifactId: ref.artifactId,
                sha256: ref.sha256,
                size: ref.size,
              },
            ],
          },
          conflictPaths: ['pinned-conflict.bin'],
        }),
      );

      const deletion = infra.artifacts.delete(seed.ctx, ref.artifactId);
      await waitForRowLockWaiter(await backendPid(writer));

      await writer.query('COMMIT');
      await expect(deletion).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(infra.artifacts.get(seed.ctx, ref.artifactId)).resolves.toEqual(bytes);

      // The pending candidate is durable and keeps protecting the Artifact afterwards.
      const conflicts = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM workspace_conflicts
          WHERE tenant_id = $1 AND workspace_id = $2`,
        [seed.tenant.tenantId, workspaceId],
      );

      expect(Number(conflicts.rows[0]?.count ?? '0')).toBeGreaterThan(0);
      await expect(infra.artifacts.delete(seed.ctx, ref.artifactId)).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });
});
