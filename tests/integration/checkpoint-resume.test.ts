import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CommitStepRequest, RunExecutionContext, RunGrant } from '@ember/contracts';
import type { AuthContext, LeasedRun } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';
import {
  ManualClock,
  createQueuedTask,
  databaseNow,
  listEventSnapshots,
  readTask,
} from './support/leases.js';
import { createP06Infra, grantOfContext, type P06Infra } from './support/p0b06.js';

/**
 * B-T17 — a committed step survives a crash; an uncommitted step is redone; an old Run keeps
 * zero write authority; a new Run reads the checkpoint read-only and continues.
 */

const WORKER_ID = 'worker-p0b17';
const LEASE_MS = 5_000;
const EXECUTOR = 'deterministic-executor@1';

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenant: TenantFixture;
let ctx: AuthContext;
let agentId: string;
let otherAgentId: string;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let reader: PostgresRunExecutionContextReader;
let infra: P06Infra;

interface Attempt {
  readonly lease: LeasedRun;
  readonly context: RunExecutionContext;
  readonly grant: RunGrant;
}

async function syncClock(): Promise<void> {
  clock.set(await databaseNow(db.pool));
}

async function claim(label: string): Promise<Attempt> {
  await createQueuedTask(tasks, ctx, agentId, label);
  await syncClock();
  const lease = await queue.claimNext(WORKER_ID, clock.now());

  if (lease === null) {
    throw new Error('expected a claimable task');
  }

  const context = await reader.read(lease, clock.now());

  return { lease, context, grant: grantOfContext(context) };
}

/** Crash the worker: the persisted lease is in the past, then the Reaper converges the Task. */
async function crash(attempt: Attempt): Promise<void> {
  await db.pool.query(
    `UPDATE runs SET leased_until = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, attempt.lease.runId],
  );
  await db.pool.query(
    `UPDATE tasks
        SET created_at = clock_timestamp() - interval '1 hour',
            lease_expires_at = clock_timestamp() - interval '59 minutes'
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, attempt.lease.taskId],
  );

  clock.set(await databaseNow(db.pool));
  await queue.reapExpired(clock.now());
  clock.advance(1_000);
}

async function checkpointCount(taskId: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
    [tenant.tenantId, taskId],
  );

  return Number(result.rows[0]?.count ?? '0');
}

async function produceRequest(attempt: Attempt, label: string): Promise<CommitStepRequest> {
  const staged = await infra.blobs.stage(
    tenant.tenantId,
    Buffer.from(`produced:${label}`),
    'text/plain',
  );

  return {
    operationId: `step:produce:${label}`,
    mode: 'progress',
    artifacts: [{ artifactId: staged.stagedId, staged }],
    checkpoint: {
      stepId: 'produce',
      inputDigest: 'a'.repeat(64),
      executorVersion: EXECUTOR,
      cursor: { phase: 'produced' },
      artifacts: [
        {
          artifactId: staged.stagedId,
          sha256: staged.sha256,
          size: staged.size,
          mediaType: staged.mediaType,
          path: 'produced.txt',
        },
      ],
      externalEffects: [{ key: `noop:${attempt.lease.taskId}`, status: 'not_applicable' }],
    },
  };
}

beforeAll(async () => {
  db = await createTestDatabase();
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool);
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 3 };
  agentId = (await agents.create(ctx, { name: 'p0b17 agent' })).agentId;
  otherAgentId = (await agents.create(ctx, { name: 'p0b17 other agent' })).agentId;
  clock = new ManualClock(new Date('2026-10-29T00:00:00.000Z'));
  queue = new PostgresLeaseQueue(db.pool, {
    leaseDurationMs: LEASE_MS,
    heartbeatIntervalMs: 500,
    baseDelayMs: 100,
    capDelayMs: 100,
    reaperBatchSize: 10,
    clock,
  });
  reader = new PostgresRunExecutionContextReader(db.pool, clock);
  infra = await createP06Infra(db);
}, 30_000);

afterAll(async () => {
  await infra?.dispose();
  await db?.close();
});

beforeEach(async () => {
  await db.pool.query(
    `UPDATE tasks SET next_run_at = now() + interval '1 day'
      WHERE status IN ('queued', 'retryable_failed')`,
  );
});

describe('P0B06 B-T17 checkpoint crash and resume', () => {
  it('resumes from a committed step and never re-runs it', async () => {
    const first = await claim('resume');
    const produced = await produceRequest(first, 'resume');

    const receipt = await infra.committer.commitStep(first.grant, produced);

    expect(receipt.checkpointId).not.toBeNull();

    // A progress step is not terminal.
    expect((await readTask(db.pool, tenant.tenantId, first.lease.taskId)).status).toBe('running');

    const committed = await infra.checkpoints.loadLatest(first.grant, {
      schemaVersion: 1,
      executorVersion: EXECUTOR,
    });

    expect(committed?.stepId).toBe('produce');
    expect(committed?.runId).toBe(first.lease.runId);
    expect(committed?.artifacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(committed?.cursor).toEqual({ phase: 'produced' });

    // Crash: the lease expires and the Reaper converges the Task to a retry.
    await crash(first);

    const converged = await readTask(db.pool, tenant.tenantId, first.lease.taskId);

    expect(['retryable_failed', 'queued']).toContain(converged.status);

    // The next attempt gets a new Run and a strictly greater lease epoch. The manual clock
    // stays just past the scheduled retry, exactly as a real worker would find it.
    const second = await queue.claimNext(WORKER_ID, clock.now());

    expect(second).not.toBeNull();
    expect(second?.runId).not.toBe(first.lease.runId);
    expect(second?.leaseEpoch).toBeGreaterThan(first.lease.leaseEpoch);

    const secondContext = await reader.read(second!, clock.now());
    const secondGrant = grantOfContext(secondContext);

    // The old Run cannot write anything at the new epoch.
    await expect(
      infra.committer.commitStep(first.grant, {
        operationId: `step:publish:${randomUUID()}`,
        mode: 'result',
        artifacts: [],
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    // The new Run reads the committed checkpoint as input and finishes without redoing it.
    const resumed = await infra.checkpoints.loadLatest(secondGrant, { schemaVersion: 1 });

    expect(resumed?.checkpointId).toBe(receipt.checkpointId);
    expect(resumed?.runId).toBe(first.lease.runId);

    const publish = await infra.committer.commitStep(secondGrant, {
      operationId: 'step:publish:resume',
      mode: 'result',
      checkpoint: {
        stepId: 'publish',
        inputDigest: 'b'.repeat(64),
        executorVersion: EXECUTOR,
        cursor: { phase: 'published' },
        artifacts: [],
      },
    });

    expect(publish.replayed).toBe(false);
    expect((await readTask(db.pool, tenant.tenantId, first.lease.taskId)).status).toBe('completed');
    expect(await checkpointCount(first.lease.taskId)).toBe(2);

    const events = await listEventSnapshots(db.pool, tenant.tenantId, first.lease.taskId);

    expect(events.filter((event) => event.phase === 'completed')).toHaveLength(1);
    expect(events.filter((event) => event.phase === 'progress')).toHaveLength(1);
  });

  it('treats the same step and input digest as one immutable checkpoint', async () => {
    const attempt = await claim('idempotent-step');
    const produced = await produceRequest(attempt, 'idempotent-step');
    const first = await infra.committer.commitStep(attempt.grant, produced);

    // Same step identity under a different operation id: the checkpoint is reused.
    const second = await infra.committer.commitStep(attempt.grant, {
      ...produced,
      operationId: 'step:produce:retry',
    });

    expect(second.checkpointId).toBe(first.checkpointId);
    expect(await checkpointCount(attempt.lease.taskId)).toBe(1);
  });

  it('refuses an uncommitted step and an incompatible checkpoint version', async () => {
    const attempt = await claim('incompatible');

    // Nothing was committed for this Task yet.
    await expect(
      infra.checkpoints.loadLatest(attempt.grant, { schemaVersion: 1 }),
    ).resolves.toBeNull();

    await infra.committer.commitStep(attempt.grant, await produceRequest(attempt, 'incompatible'));

    // A newer schema or a different executor build must not be resumed blindly.
    await expect(
      infra.checkpoints.loadLatest(attempt.grant, { schemaVersion: 99 }),
    ).resolves.toBeNull();
    await expect(
      infra.checkpoints.loadLatest(attempt.grant, { executorVersion: 'other-executor@9' }),
    ).resolves.toBeNull();
  });

  it('does not expose another tenant’s checkpoints', async () => {
    const attempt = await claim('cross-tenant-cp');
    await infra.committer.commitStep(
      attempt.grant,
      await produceRequest(attempt, 'cross-tenant-cp'),
    );

    const foreign = await createTenantFixture(db.pool, 'p0b17 foreign tenant');
    const foreignCtx: AuthContext = {
      tenantId: foreign.tenantId,
      principalId: foreign.principalId,
      policyVersion: 1,
    };

    await expect(
      infra.checkpoints.loadLatest({
        tenantId: foreignCtx.tenantId,
        taskId: attempt.lease.taskId,
        runId: attempt.lease.runId,
        agentId: otherAgentId,
        attempt: 1,
        leaseEpoch: 1,
      }),
    ).resolves.toBeNull();

    await expect(infra.checkpoints.get(attempt.grant, randomUUID())).resolves.toBeNull();
  });
});
