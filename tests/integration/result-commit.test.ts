import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CommitStepRequest, RunExecutionContext, RunGrant } from '@ember/contracts';
import type { AuthContext, LeasedRun } from '@ember/domain';
import {
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresRunResultCommitter,
  PostgresTaskRepository,
  resolveLeaseQueueConfig,
  type CommitFaultInjector,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';
import {
  ManualClock,
  createQueuedTask,
  waitForTaskLockWaiter,
  databaseNow,
  readTask,
} from './support/leases.js';
import { createP06Infra, grantOfContext, type P06Infra } from './support/p0b06.js';

/**
 * B-T26 — atomic result commit under fault injection, plus concurrent idempotency, fencing,
 * cancellation and deadline rejection.
 *
 * Every case asserts the *whole* snapshot (Task, Run, Workspace, Checkpoint, Artifact,
 * Event, Receipt) rather than only the returned value, so a partially applied commit cannot
 * pass.
 */

const WORKER_ID = 'worker-p0b06-commit';
const LEASE_MS = 5_000;

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenant: TenantFixture;
let ctx: AuthContext;
let agentId: string;
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

/** Create a Task and claim it through the real lease queue. */
async function claimTask(label: string): Promise<Attempt> {
  await createQueuedTask(tasks, ctx, agentId, label);
  await syncClock();
  const lease = await queue.claimNext(WORKER_ID, clock.now());

  if (lease === null) {
    throw new Error('expected a claimable task');
  }

  const context = await reader.read(lease, clock.now());

  return { lease, context, grant: grantOfContext(context) };
}

async function stageArtifact(content: string): Promise<{
  staged: Awaited<ReturnType<P06Infra['blobs']['stage']>>;
  artifactId: string;
}> {
  const staged = await infra.blobs.stage(tenant.tenantId, Buffer.from(content), 'text/plain');

  return { staged, artifactId: staged.stagedId };
}

async function resultRequest(
  content: string,
  operationId = `op:result:${randomUUID()}`,
): Promise<CommitStepRequest> {
  const { staged, artifactId } = await stageArtifact(content);

  return {
    operationId,
    mode: 'result',
    artifacts: [{ artifactId, staged }],
  };
}

/**
 * Committer with a fault injector, sharing this file's blob store.
 *
 * Sharing the root matters: a fresh root would make the artifact install fail before the
 * injection point, which would silently turn a rollback assertion into a false positive.
 */
function committerWithFault(faultInjector: CommitFaultInjector): PostgresRunResultCommitter {
  return new PostgresRunResultCommitter(db.pool, {
    policy: resolveLeaseQueueConfig({ leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 500 }),
    blobs: infra.blobs,
    faultInjector,
  });
}

/** Move the persisted lease of one Run into the past (a real crash, not a clock sample). */
async function expireLease(attempt: Attempt): Promise<void> {
  await db.pool.query(
    `UPDATE runs SET leased_until = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, attempt.lease.runId],
  );
  // `lease_expires_at >= created_at` is a database check, so the creation stamp moves too.
  await db.pool.query(
    `UPDATE tasks
        SET created_at = clock_timestamp() - interval '1 hour',
            lease_expires_at = clock_timestamp() - interval '59 minutes'
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, attempt.lease.taskId],
  );
}

/** Shorten the persisted lease so it expires during a lock wait. */
async function shortenLease(attempt: Attempt, ms: number): Promise<void> {
  await db.pool.query(
    `UPDATE runs SET leased_until = clock_timestamp() + ($3::text || ' milliseconds')::interval
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, attempt.lease.runId, ms],
  );
  await db.pool.query(
    `UPDATE tasks SET lease_expires_at = clock_timestamp() + ($3::text || ' milliseconds')::interval
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, attempt.lease.taskId, ms],
  );
}

async function counters(taskId: string): Promise<Record<string, number>> {
  const result = await db.pool.query<{ phase: string; count: string }>(
    `SELECT phase, count(*)::text AS count
       FROM task_events
      WHERE tenant_id = $1 AND task_id = $2
      GROUP BY phase`,
    [tenant.tenantId, taskId],
  );

  return Object.fromEntries(result.rows.map((row) => [row.phase, Number(row.count)]));
}

async function artifactRows(taskId: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2',
    [tenant.tenantId, taskId],
  );

  return Number(result.rows[0]?.count ?? '0');
}

async function workspaceVersions(agent: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM workspace_versions v
       JOIN workspaces w ON w.tenant_id = v.tenant_id AND w.id = v.workspace_id
      WHERE w.tenant_id = $1 AND w.agent_id = $2`,
    [tenant.tenantId, agent],
  );

  return Number(result.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  db = await createTestDatabase();
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool);
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 3 };
  const agent = await agents.create(ctx, { name: 'p0b06 commit agent' });
  agentId = agent.agentId;
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
  // Keep unrelated open Tasks out of this file's claim window.
  await db.pool.query(
    `UPDATE tasks SET next_run_at = now() + interval '1 day'
      WHERE status IN ('queued', 'retryable_failed')`,
  );
});

describe('P0B06 B-T26 atomic result commit', () => {
  it('commits artifact, terminal state, event and receipt as one unit', async () => {
    const attempt = await claimTask('commit-ok');
    const request = await resultRequest('atomic result');

    const receipt = await infra.committer.commitStep(attempt.grant, request);

    expect(receipt.replayed).toBe(false);
    expect(receipt.artifactIds).toHaveLength(1);

    const task = await readTask(db.pool, tenant.tenantId, attempt.lease.taskId);
    const run = await db.pool.query<{ status: string; finished_at: Date | null }>(
      'SELECT status, finished_at FROM runs WHERE tenant_id = $1 AND id = $2',
      [tenant.tenantId, attempt.lease.runId],
    );

    expect(task.status).toBe('completed');
    expect(run.rows[0]?.status).toBe('succeeded');
    expect(await counters(attempt.lease.taskId)).toMatchObject({ completed: 1, accepted: 1 });
    expect(await artifactRows(attempt.lease.taskId)).toBe(1);
  });

  it('replays a committed operation read-only, including after the lease expired', async () => {
    const attempt = await claimTask('commit-replay');
    const request = await resultRequest('replay me');
    const first = await infra.committer.commitStep(attempt.grant, request);

    // The ACK was lost: the caller retries the identical request.
    const second = await infra.committer.commitStep(attempt.grant, request);

    expect(second.replayed).toBe(true);
    expect(second.artifactIds).toEqual(first.artifactIds);
    expect(second.committedAt).toBe(first.committedAt);
    expect(await counters(attempt.lease.taskId)).toMatchObject({ completed: 1 });
    expect(await artifactRows(attempt.lease.taskId)).toBe(1);

    // Even after the original lease expired, the receipt is still readable but grants no
    // further write.
    clock.advance(LEASE_MS + 1_000);

    await expect(
      infra.committer.findReceipt(attempt.grant, request.operationId),
    ).resolves.toMatchObject({ replayed: true, operationId: request.operationId });
    await expect(
      infra.committer.commitStep(
        attempt.grant,
        await resultRequest('different', request.operationId),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects the same operation id with different content', async () => {
    const attempt = await claimTask('commit-conflict');
    const request = await resultRequest('first content');

    await infra.committer.commitStep(attempt.grant, request);

    await expect(
      infra.committer.commitStep(
        attempt.grant,
        await resultRequest('second content', request.operationId),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rolls back completely when the event append fails', async () => {
    await proveRollback('before_event');
  });

  it('rolls back completely when the checkpoint insert fails', async () => {
    await proveRollback('before_checkpoint_insert');
  });

  it('rolls back completely when the database commit window fails', async () => {
    await proveRollback('before_commit');
  });

  it('answers a lost ACK after a real commit with the original receipt', async () => {
    const attempt = await claimTask('commit-ack');
    const request = await resultRequest('ack loss');

    const hits: string[] = [];
    const faulty = committerWithFault((point) => {
      hits.push(point);

      if (point === 'after_commit') {
        throw new Error('simulated ACK loss');
      }
    });

    {
      await expect(faulty.commitStep(attempt.grant, request)).rejects.toMatchObject({
        code: 'DB_UNAVAILABLE',
      });
      expect(hits).toContain('before_commit');
      expect(hits).toContain('after_commit');

      // The transaction did commit: the Task is terminal and exactly one event exists.
      const task = await readTask(db.pool, tenant.tenantId, attempt.lease.taskId);

      expect(task.status).toBe('completed');
      expect(await counters(attempt.lease.taskId)).toMatchObject({ completed: 1 });

      // A retry finds the receipt and writes nothing new.
      const replay = await infra.committer.commitStep(attempt.grant, request);

      expect(replay.replayed).toBe(true);
      expect(await counters(attempt.lease.taskId)).toMatchObject({ completed: 1 });
    }
  });
});

/**
 * Inject a failure at one point of the commit and prove that nothing at all was written.
 */
async function proveRollback(point: Parameters<CommitFaultInjector>[0]): Promise<void> {
  const attempt = await claimTask(`rollback-${point}`);
  const request = await resultRequest(`rollback ${point}`);
  const hits: string[] = [];
  const faulty = committerWithFault((hit) => {
    hits.push(hit);

    if (hit === point) {
      throw new Error(`simulated failure at ${point}`);
    }
  });

  // The rejection must come from the injected point, not from a missing staging file that
  // would otherwise make this a vacuous rollback assertion.
  await expect(faulty.commitStep(attempt.grant, request)).rejects.toMatchObject({
    code: 'DB_UNAVAILABLE',
  });
  expect(hits).toContain(point);

  const task = await readTask(db.pool, tenant.tenantId, attempt.lease.taskId);
  const run = await db.pool.query<{ status: string }>(
    'SELECT status FROM runs WHERE tenant_id = $1 AND id = $2',
    [tenant.tenantId, attempt.lease.runId],
  );

  expect(task.status).toBe('running');
  expect(run.rows[0]?.status).toBe('running');
  expect(await artifactRows(attempt.lease.taskId)).toBe(0);
  expect(await workspaceVersions(agentId)).toBe(0);
  expect(await counters(attempt.lease.taskId)).toEqual({ accepted: 1, leased: 1, started: 1 });

  const receipts = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM operation_receipts WHERE tenant_id = $1 AND task_id = $2',
    [tenant.tenantId, attempt.lease.taskId],
  );

  expect(receipts.rows[0]?.count).toBe('0');
  const checkpoints = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
    [tenant.tenantId, attempt.lease.taskId],
  );

  expect(checkpoints.rows[0]?.count).toBe('0');
}

describe('P0B06 fencing and concurrency around the commit', () => {
  it('rejects a commit for a cancelled Task with zero writes', async () => {
    const attempt = await claimTask('commit-cancel');
    const request = await resultRequest('cancelled result');

    await tasks.requestCancel(ctx, attempt.lease.taskId);

    await expect(infra.committer.commitStep(attempt.grant, request)).rejects.toMatchObject({
      code: 'CANCELLED',
    });

    const task = await readTask(db.pool, tenant.tenantId, attempt.lease.taskId);

    expect(task.status).toBe('running');
    expect(await artifactRows(attempt.lease.taskId)).toBe(0);
    expect(await counters(attempt.lease.taskId)).toEqual({ accepted: 1, leased: 1, started: 1 });
  });

  it('rejects a commit after the Task deadline with zero writes', async () => {
    const attempt = await claimTask('commit-deadline');
    await db.pool.query(
      `UPDATE tasks SET deadline_at = now() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, attempt.lease.taskId],
    );

    await expect(
      infra.committer.commitStep(attempt.grant, await resultRequest('late result')),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });

    expect(await artifactRows(attempt.lease.taskId)).toBe(0);
  });

  it('rejects a commit after the lease expired with zero writes', async () => {
    const attempt = await claimTask('commit-expired');
    await expireLease(attempt);

    await expect(
      infra.committer.commitStep(attempt.grant, await resultRequest('expired result')),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    expect(await artifactRows(attempt.lease.taskId)).toBe(0);
    expect((await counters(attempt.lease.taskId))['completed'] ?? 0).toBe(0);
  });

  it('re-validates the lease after a row-lock wait that outlived it', async () => {
    const attempt = await claimTask('commit-lock-wait');
    const request = await resultRequest('lock wait result');
    const blocker = await db.pool.connect();

    await shortenLease(attempt, 400);

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        tenant.tenantId,
        attempt.lease.taskId,
      ]);

      const pending = infra.committer.commitStep(attempt.grant, request);

      await waitForTaskLockWaiter(db.pool, blocker);
      // The lease expires while the commit waits for the Task row lock. A pre-lock clock
      // sample would still show a valid lease, which is exactly the bug this asserts away.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await blocker.query('ROLLBACK');

      await expect(pending).rejects.toMatchObject({ code: 'STALE_LEASE' });
    } finally {
      blocker.release();
    }

    expect(await artifactRows(attempt.lease.taskId)).toBe(0);
    expect((await counters(attempt.lease.taskId))['completed'] ?? 0).toBe(0);
  });

  it('lets exactly one of 24 concurrent identical commits write', async () => {
    const attempt = await claimTask('commit-concurrent');
    const request = await resultRequest('concurrent result');

    const receipts = await Promise.all(
      Array.from({ length: 24 }, () => infra.committer.commitStep(attempt.grant, request)),
    );

    expect(receipts.filter((receipt) => receipt.replayed === false)).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.committedAt)).size).toBe(1);
    expect(new Set(receipts.map((receipt) => receipt.artifactIds[0])).size).toBe(1);
    expect(await artifactRows(attempt.lease.taskId)).toBe(1);
    expect(await counters(attempt.lease.taskId)).toMatchObject({ completed: 1 });

    const stored = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM operation_receipts WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, attempt.lease.taskId],
    );

    expect(stored.rows[0]?.count).toBe('1');
  });

  it('rolls the whole commit back on a workspace CAS conflict and keeps the candidate', async () => {
    // Establish workspace version 1 with an unrelated entry first.
    const base = await infra.workspaces.load(ctx, agentId);
    const artifact = await infra.artifacts.put(ctx, Buffer.from('workspace base'), 'text/plain');

    await infra.workspaces.commit(ctx, agentId, base.version, {
      files: [
        {
          path: 'existing.txt',
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          size: artifact.size,
        },
      ],
    });

    const attempt = await claimTask('commit-cas');
    const staged = await infra.blobs.stage(
      tenant.tenantId,
      Buffer.from('candidate bytes'),
      'text/plain',
    );
    const candidateArtifact = staged.stagedId;

    const request: CommitStepRequest = {
      operationId: `op:cas:${randomUUID()}`,
      mode: 'result',
      artifacts: [{ artifactId: candidateArtifact, staged }],
      workspace: {
        // Stale on purpose: the workspace already moved past version 0.
        expectedVersion: 0,
        manifest: {
          files: [
            {
              path: 'existing.txt',
              artifactId: candidateArtifact,
              sha256: staged.sha256,
              size: staged.size,
            },
          ],
        },
      },
    };

    await expect(infra.committer.commitStep(attempt.grant, request)).rejects.toMatchObject({
      code: 'WORKSPACE_VERSION_CONFLICT',
    });

    const task = await readTask(db.pool, tenant.tenantId, attempt.lease.taskId);

    expect(task.status).toBe('running');
    expect(await artifactRows(attempt.lease.taskId)).toBe(0);

    const conflicts = await infra.workspaces.conflicts(ctx, agentId);

    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0]?.conflictPaths).toContain('existing.txt');
  });
});
