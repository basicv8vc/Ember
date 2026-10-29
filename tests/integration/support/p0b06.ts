import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunExecutionContext, RunGrant } from '@ember/contracts';
import type { AuthContext } from '@ember/domain';
import {
  LocalBlobStore,
  PostgresArtifactStore,
  PostgresBlobStore,
  PostgresCheckpointStore,
  PostgresRunResultCommitter,
  PostgresWorkspaceStore,
  resolveLeaseQueueConfig,
  type CommitFaultInjector,
  type LeaseQueueConfigOverrides,
} from '@ember/postgres';
import type { TestDatabase } from './database.js';
import { createTenantFixture, type TenantFixture } from './fixtures.js';

/**
 * P0B-06 integration helpers.
 *
 * Every blob root is a fresh temporary directory that this helper created, and only that
 * exact directory is ever removed. PostgreSQL state lives in the run's throwaway schema.
 */

export interface BlobRoot {
  readonly dir: string;
  dispose(): Promise<void>;
}

export async function createBlobRoot(): Promise<BlobRoot> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ember-blobs-'));

  return {
    dir,
    dispose: async () => {
      // Only the directory this helper created, and only if it is still a temp path.
      if (!dir.startsWith(tmpdir())) {
        throw new Error('refusing to remove a blob root outside the temp directory');
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface P06Infra {
  readonly root: BlobRoot;
  readonly files: LocalBlobStore;
  readonly blobs: PostgresBlobStore;
  readonly artifacts: PostgresArtifactStore;
  readonly workspaces: PostgresWorkspaceStore;
  readonly checkpoints: PostgresCheckpointStore;
  readonly committer: PostgresRunResultCommitter;
  dispose(): Promise<void>;
}

export interface P06InfraOptions {
  readonly lease?: LeaseQueueConfigOverrides;
  readonly gcQuarantineMs?: number;
  readonly faultInjector?: CommitFaultInjector;
}

export async function createP06Infra(
  db: TestDatabase,
  options: P06InfraOptions = {},
): Promise<P06Infra> {
  const root = await createBlobRoot();
  const files = new LocalBlobStore({ rootDir: root.dir });
  const blobs = new PostgresBlobStore(db.pool, files, {
    ...(options.gcQuarantineMs === undefined ? {} : { gcQuarantineMs: options.gcQuarantineMs }),
  });
  const policy = resolveLeaseQueueConfig(options.lease ?? {});
  const committer = new PostgresRunResultCommitter(db.pool, {
    policy,
    blobs,
    ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
  });

  return {
    root,
    files,
    blobs,
    artifacts: new PostgresArtifactStore(db.pool, blobs),
    workspaces: new PostgresWorkspaceStore(db.pool),
    checkpoints: new PostgresCheckpointStore(db.pool),
    committer,
    dispose: async () => {
      await root.dispose();
    },
  };
}

export interface Seed {
  readonly tenant: TenantFixture;
  readonly ctx: AuthContext;
  readonly agentId: string;
}

/** Create a tenant, a principal and one agent/workspace through the real repository path. */
export async function seedTenantAgent(
  db: TestDatabase,
  createAgent: (ctx: AuthContext, name: string) => Promise<{ agentId: string }>,
): Promise<Seed> {
  const tenant = await createTenantFixture(db.pool);
  const ctx: AuthContext = {
    tenantId: tenant.tenantId,
    principalId: tenant.principalId,
    policyVersion: 3,
  };
  const agent = await createAgent(ctx, `agent-${tenant.tenantId.slice(0, 8)}`);

  return { tenant, ctx, agentId: agent.agentId };
}

/** Derive the server-side Run authority the committer expects from a trusted context. */
export function grantOfContext(context: RunExecutionContext): RunGrant {
  return Object.freeze({
    tenantId: context.tenantId,
    taskId: context.taskId,
    runId: context.runId,
    agentId: context.agentId,
    attempt: context.attempt,
    leaseEpoch: context.leaseEpoch,
    workerId: context.workerId,
  });
}
