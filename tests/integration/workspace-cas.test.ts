import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceManifest } from '@ember/contracts';
import type { AuthContext } from '@ember/domain';
import {
  PostgresAgentRepository,
  workspaceManifestDigest,
  type PostgresWorkspaceStore,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createP06Infra, seedTenantAgent, type P06Infra, type Seed } from './support/p0b06.js';

/**
 * B-T12 — Workspace manifest CAS, history, limited merge and conflict preservation.
 *
 * Every assertion runs against a real PostgreSQL schema and a real (empty) workspace row
 * created by `PostgresAgentRepository`.
 */

let db: TestDatabase;
let infra: P06Infra;
let workspaces: PostgresWorkspaceStore;
let seed: Seed;
let other: Seed;

beforeAll(async () => {
  db = await createTestDatabase();
  infra = await createP06Infra(db);
  workspaces = infra.workspaces;
  const agents = new PostgresAgentRepository(db.pool);

  seed = await seedTenantAgent(db, (ctx, name) => agents.create(ctx, { name }));
  other = await seedTenantAgent(db, (ctx, name) => agents.create(ctx, { name }));
}, 30_000);

afterAll(async () => {
  await infra?.dispose();
  await db?.close();
});

describe('P0B06 B-T12 workspace CAS', () => {
  it('starts at version 0 with an empty manifest', async () => {
    const snapshot = await workspaces.load(seed.ctx, seed.agentId);

    expect(snapshot.version).toBe(0);
    expect(snapshot.manifest.files).toEqual([]);
  });

  it('never loses an update when two writers race on the same expected version', async () => {
    const artifact = await infra.artifacts.put(seed.ctx, Buffer.from('shared'), 'text/plain');

    const candidateA: WorkspaceManifest = {
      files: [
        {
          path: 'a.txt',
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          size: artifact.size,
        },
      ],
    };
    const candidateB: WorkspaceManifest = {
      files: [
        {
          path: 'b.txt',
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          size: artifact.size,
        },
      ],
    };

    const results = await Promise.allSettled([
      workspaces.commit(seed.ctx, seed.agentId, 0, candidateA),
      workspaces.commit(seed.ctx, seed.agentId, 0, candidateB),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    // Both candidates are additive and disjoint from the empty base, so the deterministic
    // merge rule may legitimately accept both — but never as a lost update.
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const snapshot = await workspaces.load(seed.ctx, seed.agentId);

    expect(snapshot.version).toBe(fulfilled.length);

    if (fulfilled.length === 2) {
      expect(snapshot.manifest.files.map((file) => file.path).sort()).toEqual(['a.txt', 'b.txt']);
    } else {
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'WORKSPACE_VERSION_CONFLICT',
      });
    }
  });

  it('keeps immutable history with an explicit parent version', async () => {
    const artifact = await infra.artifacts.put(seed.ctx, Buffer.from('history'), 'text/plain');
    const before = await workspaces.load(seed.ctx, seed.agentId);
    const file = {
      path: 'history.txt',
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      size: artifact.size,
    };
    const next = { files: [...before.manifest.files, file] };

    const committed = await workspaces.commit(seed.ctx, seed.agentId, before.version, next);

    expect(committed.version).toBe(before.version + 1);

    const history = await workspaces.history(seed.ctx, seed.agentId);

    expect(history[0]?.version).toBe(committed.version);
    expect(history[0]?.parentVersion).toBe(before.version);
    expect(history[0]?.digest).toBe(workspaceManifestDigest(next));

    const previous = await workspaces.loadVersion(seed.ctx, seed.agentId, before.version);

    expect(previous.manifest.files.map((entry) => entry.path)).toEqual(
      before.manifest.files.map((entry) => entry.path),
    );
  });

  it('merges a stale candidate deterministically when the changes do not overlap', async () => {
    const artifact = await infra.artifacts.put(seed.ctx, Buffer.from('merge'), 'text/plain');
    const base = await workspaces.load(seed.ctx, seed.agentId);
    const fileA = {
      path: 'merge-a.txt',
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      size: artifact.size,
    };
    const fileB = {
      path: 'merge-b.txt',
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      size: artifact.size,
    };

    // Writer 1 commits from the shared base.
    await workspaces.commit(seed.ctx, seed.agentId, base.version, {
      files: [...base.manifest.files, fileA],
    });

    // Writer 2 still believes it is at the base version but only touches another path.
    const merged = await workspaces.commit(seed.ctx, seed.agentId, base.version, {
      files: [...base.manifest.files, fileB],
    });

    expect(merged.version).toBe(base.version + 2);

    const snapshot = await workspaces.load(seed.ctx, seed.agentId);
    const paths = snapshot.manifest.files.map((entry) => entry.path);

    expect(paths).toContain('merge-a.txt');
    expect(paths).toContain('merge-b.txt');
  });

  it('preserves both candidates and fails on an overlapping same-path change', async () => {
    const first = await infra.artifacts.put(seed.ctx, Buffer.from('first'), 'text/plain');
    const second = await infra.artifacts.put(seed.ctx, Buffer.from('second'), 'text/plain');
    const base = await workspaces.load(seed.ctx, seed.agentId);
    const candidateFor = (artifact: {
      artifactId: string;
      sha256: string;
      size: number;
    }): WorkspaceManifest => ({
      files: [
        ...base.manifest.files,
        {
          path: 'conflict.txt',
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          size: artifact.size,
        },
      ],
    });

    const winner = await workspaces.commit(
      seed.ctx,
      seed.agentId,
      base.version,
      candidateFor(first),
    );

    expect(winner.version).toBe(base.version + 1);

    await expect(
      workspaces.commit(seed.ctx, seed.agentId, base.version, candidateFor(second)),
    ).rejects.toMatchObject({ code: 'WORKSPACE_VERSION_CONFLICT' });

    // No last-write-wins: the winner's entry is still what the workspace says.
    const snapshot = await workspaces.load(seed.ctx, seed.agentId);

    expect(snapshot.version).toBe(winner.version);
    expect(snapshot.manifest.files.find((entry) => entry.path === 'conflict.txt')?.artifactId).toBe(
      first.artifactId,
    );

    // The losing candidate is preserved with its provenance.
    const conflicts = await workspaces.conflicts(seed.ctx, seed.agentId);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.conflictPaths).toEqual(['conflict.txt']);
    expect(
      conflicts[0]?.candidate.files.find((entry) => entry.path === 'conflict.txt')?.artifactId,
    ).toBe(second.artifactId);

    // Retrying the same losing candidate records no duplicate conflict.
    await expect(
      workspaces.commit(seed.ctx, seed.agentId, base.version, candidateFor(second)),
    ).rejects.toMatchObject({ code: 'WORKSPACE_VERSION_CONFLICT' });

    await expect(workspaces.conflicts(seed.ctx, seed.agentId)).resolves.toHaveLength(1);
  });

  it('rejects a stale destructive change instead of merging it', async () => {
    const base = await workspaces.load(seed.ctx, seed.agentId);
    const target = base.manifest.files[0];

    expect(target).toBeDefined();

    const artifact = await infra.artifacts.put(seed.ctx, Buffer.from('unrelated'), 'text/plain');
    await workspaces.commit(seed.ctx, seed.agentId, base.version, {
      files: [
        ...base.manifest.files,
        {
          path: 'unrelated.txt',
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          size: artifact.size,
        },
      ],
    });

    await expect(
      workspaces.commit(seed.ctx, seed.agentId, base.version, {
        files: base.manifest.files.filter((entry) => entry.path !== target?.path),
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_VERSION_CONFLICT' });
  });

  it('refuses another tenant\u2019s artifact reference and never leaks its existence', async () => {
    const foreign = await infra.artifacts.put(other.ctx, Buffer.from('foreign'), 'text/plain');
    const base = await workspaces.load(seed.ctx, seed.agentId);

    await expect(
      workspaces.commit(seed.ctx, seed.agentId, base.version, {
        files: [
          ...base.manifest.files,
          {
            path: 'foreign.txt',
            artifactId: foreign.artifactId,
            sha256: foreign.sha256,
            size: foreign.size,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    await expect(infra.artifacts.get(seed.ctx, foreign.artifactId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses an unsafe logical path before any write', async () => {
    const base = await workspaces.load(seed.ctx, seed.agentId);
    const artifact = await infra.artifacts.put(seed.ctx, Buffer.from('path'), 'text/plain');

    for (const unsafe of ['../escape.txt', '/etc/passwd', 'a\\b.txt', 'C:/x.txt', 'a//b.txt', '']) {
      await expect(
        workspaces.commit(seed.ctx, seed.agentId, base.version, {
          files: [
            {
              path: unsafe,
              artifactId: artifact.artifactId,
              sha256: artifact.sha256,
              size: artifact.size,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }

    await expect(workspaces.load(seed.ctx, seed.agentId)).resolves.toMatchObject({
      version: base.version,
    });
  });

  it('treats a foreign and a missing agent identically', async () => {
    const stranger: AuthContext = other.ctx;

    await expect(workspaces.load(stranger, seed.agentId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await expect(workspaces.load(seed.ctx, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await expect(workspaces.load(seed.ctx, 'not-a-uuid')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    // The foreign tenant's own agent/workspace is visible only inside that tenant.
    await expect(workspaces.load(stranger, other.agentId)).resolves.toMatchObject({ version: 0 });
  });
});
