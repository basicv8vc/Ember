import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ArtifactRef,
  BlobStore,
  CommitStepRequest,
  RunExecutionContext,
  RunGrant,
} from '@ember/contracts';
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
  // `now()` has microsecond precision; a JS Date truncates to milliseconds, so reusing the
  // sample verbatim can be earlier than the row's next_run_at within the same millisecond.
  // The +1ms models the round trip and keeps the claim predicate deterministic.
  clock.set(new Date((await databaseNow(db.pool)).getTime() + 1));
}

/** Create a Task and claim it through the real lease queue. */
async function claimTask(label: string, agent = agentId): Promise<Attempt> {
  await createQueuedTask(tasks, ctx, agent, label);
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
 * Publish an Artifact whose id sorts *below* `threshold` and is already committed.
 *
 * Artifact ids are random UUIDs, so a caller that needs a deterministic ascending pair cannot
 * plan one; publishing until a lower id appears is bounded and keeps the lock-order assertion
 * below free of sleeps. The Artifact must be committed: a row inserted by the committing
 * transaction itself is invisible to every other session, so a probe could never observe a
 * lock on it.
 */
async function publishArtifactBelow(threshold: string): Promise<ArtifactRef> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const artifact = await infra.artifacts.put(ctx, Buffer.from(`lower ${attempt}`), 'text/plain');

    if (artifact.artifactId < threshold) {
      return artifact;
    }
  }

  throw new Error('could not publish an artifact with a lower id');
}

/** One Workspace manifest entry pointing at an already durable Artifact. */
function manifestEntry(
  path: string,
  artifact: ArtifactRef,
): { path: string; artifactId: string; sha256: string; size: number } {
  return { path, artifactId: artifact.artifactId, sha256: artifact.sha256, size: artifact.size };
}

/**
 * `true` when no other session holds a row lock on this Artifact.
 *
 * A `FOR UPDATE NOWAIT` is granted only if no `FOR SHARE`/`FOR UPDATE` holder exists, which is
 * exactly what a lock-order assertion needs to observe a *held* Artifact lock.
 */
async function probeArtifactLock(artifactId: string): Promise<boolean> {
  const probe = await db.pool.connect();

  try {
    await probe.query('BEGIN');
    await probe.query(
      'SELECT 1 FROM artifacts WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT',
      [tenant.tenantId, artifactId],
    );

    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') {
      return false;
    }

    throw error;
  } finally {
    await probe.query('ROLLBACK').catch(() => undefined);
    probe.release();
  }
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

describe('P0B06 P2-A reference lock scope covers an auto-merged manifest', () => {
  it('pre-locks an artifact the merge pulls in instead of locking it after the request set', async () => {
    // Both ids must be durable before the commit runs: a row inserted by the commit itself is
    // invisible to every other session, so probing it could never observe a held lock.
    const requested = await infra.artifacts.put(ctx, Buffer.from('requested entry'), 'text/plain');
    // The Artifact only the merge contributes sorts *below* the requested one, which is the
    // arrangement that inverts the ascending order if it is locked after the request's set.
    const mergedIn = await publishArtifactBelow(requested.artifactId);
    // A dedicated agent keeps the version arithmetic of this case independent of the shared one.
    const mergeAgent = (await agents.create(ctx, { name: 'p0b06 merge scope agent' })).agentId;
    const base = await infra.workspaces.load(ctx, mergeAgent);

    await infra.workspaces.commit(ctx, mergeAgent, base.version, {
      files: [manifestEntry('merged.txt', mergedIn)],
    });

    const attempt = await claimTask('commit-merge-lock-order', mergeAgent);
    const blocker = await db.pool.connect();

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM artifacts WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        tenant.tenantId,
        mergedIn.artifactId,
      ]);

      const committed = infra.committer.commitStep(attempt.grant, {
        operationId: `op:merge-lock:${randomUUID()}`,
        mode: 'result',
        workspace: {
          // Stale on purpose: the workspace already reached the `merged.txt` version, so this
          // candidate is auto-merged and the final manifest references both artifacts.
          expectedVersion: 0,
          manifest: {
            files: [manifestEntry('requested.txt', requested)],
          },
        },
      });

      // The commit is now waiting for the merged-in id, the lowest id of the final manifest.
      await waitForTaskLockWaiter(db.pool, blocker);

      // While it waits it must hold nothing above it: pre-locking only the request would leave
      // `requested` locked here, which inverts the ascending order against any other writer.
      // (`mergedIn` is held by the blocker, so probing it would say nothing about the commit.)
      await expect(probeArtifactLock(requested.artifactId)).resolves.toBe(true);

      await blocker.query('COMMIT');

      const receipt = await committed;

      expect(receipt.replayed).toBe(false);
      expect(receipt.workspaceVersion).toBe(2);

      const snapshot = await infra.workspaces.load(ctx, mergeAgent);

      expect(snapshot.version).toBe(2);
      expect(snapshot.manifest.files.map((entry) => entry.path).sort()).toEqual([
        'merged.txt',
        'requested.txt',
      ]);

      // The lock is released with the commit, so the Artifact stayed usable throughout.
      await expect(probeArtifactLock(requested.artifactId)).resolves.toBe(true);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('merges a shared artifact into two workspaces while a delete of it is refused', async () => {
    // Both workspaces start empty, so each merge lands on version 2 deterministically.
    const firstAgent = (await agents.create(ctx, { name: 'p0b06 shared artifact agent a' }))
      .agentId;
    const secondAgent = (await agents.create(ctx, { name: 'p0b06 shared artifact agent b' }))
      .agentId;
    const shared = await infra.artifacts.put(ctx, Buffer.from('shared bytes'), 'text/plain');

    for (const agent of [firstAgent, secondAgent]) {
      await infra.workspaces.commit(ctx, agent, 0, {
        files: [manifestEntry('shared.txt', shared)],
      });
    }

    const first = await claimTask('merge-shared-first', firstAgent);
    const second = await claimTask('merge-shared-second', secondAgent);
    const firstStaged = await infra.blobs.stage(
      tenant.tenantId,
      Buffer.from('first branch entry'),
      'text/plain',
    );
    const secondStaged = await infra.blobs.stage(
      tenant.tenantId,
      Buffer.from('second branch entry'),
      'text/plain',
    );

    // Both workspaces reference the same Artifact row and both merge onto it, so the scope lock
    // and the deleter's `FOR UPDATE` meet on the same rows from three sessions. The expectation
    // is attached before the commits start so a fast rejection is never unhandled.
    const deletion = expect(infra.artifacts.delete(ctx, shared.artifactId)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    const [firstReceipt, secondReceipt] = await Promise.all([
      infra.committer.commitStep(first.grant, {
        operationId: `op:merge-shared:${randomUUID()}`,
        mode: 'result',
        artifacts: [{ artifactId: firstStaged.stagedId, staged: firstStaged }],
        workspace: {
          expectedVersion: 0,
          manifest: {
            files: [
              {
                path: 'first.txt',
                artifactId: firstStaged.stagedId,
                sha256: firstStaged.sha256,
                size: firstStaged.size,
              },
            ],
          },
        },
      }),
      infra.committer.commitStep(second.grant, {
        operationId: `op:merge-shared:${randomUUID()}`,
        mode: 'result',
        artifacts: [{ artifactId: secondStaged.stagedId, staged: secondStaged }],
        workspace: {
          expectedVersion: 0,
          manifest: {
            files: [
              {
                path: 'second.txt',
                artifactId: secondStaged.stagedId,
                sha256: secondStaged.sha256,
                size: secondStaged.size,
              },
            ],
          },
        },
      }),
    ]);

    await deletion;
    expect(firstReceipt.workspaceVersion).toBe(2);
    expect(secondReceipt.workspaceVersion).toBe(2);

    for (const [agent, ownPath] of [
      [firstAgent, 'first.txt'],
      [secondAgent, 'second.txt'],
    ] as const) {
      const snapshot = await infra.workspaces.load(ctx, agent);

      expect(snapshot.version).toBe(2);
      expect(snapshot.manifest.files.map((entry) => entry.path).sort()).toEqual(
        ['shared.txt', ownPath].sort(),
      );
    }
  });

  it('merges two workspaces that each introduce the artifact the other one head-references', async () => {
    // The mirror image of the previous case: A's head references `firstShared` and its candidate
    // references `secondShared`, while B's head references `secondShared` and its candidate
    // references `firstShared`. Both transactions therefore hold one shared row and need the
    // other one during the merge. Writers only take `FOR SHARE`, which is mutually compatible,
    // so this cannot deadlock by itself — what it proves is that the scope lock turns both
    // commits into one ascending pass and both merges keep the other writer's head entry.
    const firstAgent = (await agents.create(ctx, { name: 'p0b06 lock order agent a' })).agentId;
    const secondAgent = (await agents.create(ctx, { name: 'p0b06 lock order agent b' })).agentId;
    const firstShared = await infra.artifacts.put(ctx, Buffer.from('first shared'), 'text/plain');
    const secondShared = await infra.artifacts.put(ctx, Buffer.from('second shared'), 'text/plain');
    const firstOwn = await infra.artifacts.put(ctx, Buffer.from('first own'), 'text/plain');
    const secondOwn = await infra.artifacts.put(ctx, Buffer.from('second own'), 'text/plain');
    const sides = [
      { agent: firstAgent, own: firstOwn, shared: firstShared },
      { agent: secondAgent, own: secondOwn, shared: secondShared },
    ];

    // Version 1 is the merge base; version 2 adds the head entry a merge keeps.
    for (const side of sides) {
      const own = manifestEntry('own.txt', side.own);
      const start = await infra.workspaces.load(ctx, side.agent);

      await infra.workspaces.commit(ctx, side.agent, start.version, { files: [own] });
      await infra.workspaces.commit(ctx, side.agent, start.version + 1, {
        files: [own, manifestEntry('head.txt', side.shared)],
      });
    }

    const firstAttempt = await claimTask('merge-order-first', firstAgent);
    const secondAttempt = await claimTask('merge-order-second', secondAgent);

    let arrivals = 0;
    let bothPaused: (() => void) | undefined;
    let releaseCommits: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      bothPaused = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCommits = resolve;
    });

    const committer = committerWithFault(async (point) => {
      if (point !== 'before_workspace_cas') {
        return;
      }

      arrivals += 1;

      // Both transactions are past their reference locks here, so the merges overlap.
      if (arrivals >= 2) {
        bothPaused?.();
      }

      await gate;
    });

    const firstCommit = committer.commitStep(firstAttempt.grant, {
      operationId: `op:merge-order-a:${randomUUID()}`,
      mode: 'progress',
      workspace: {
        // One version behind, so both commits merge onto their own version 2.
        expectedVersion: 1,
        manifest: {
          files: [manifestEntry('own.txt', firstOwn), manifestEntry('new.txt', secondShared)],
        },
      },
    });
    const secondCommit = committer.commitStep(secondAttempt.grant, {
      operationId: `op:merge-order-b:${randomUUID()}`,
      mode: 'progress',
      workspace: {
        expectedVersion: 1,
        manifest: {
          files: [manifestEntry('own.txt', secondOwn), manifestEntry('new.txt', firstShared)],
        },
      },
    });

    // Release once both are paused (deterministic overlap), with a bounded fallback so a commit
    // that stalls before its fault point cannot hang the case.
    await Promise.race([paused, new Promise((resolve) => setTimeout(resolve, 500))]);
    releaseCommits?.();

    const [firstOutcome, secondOutcome] = await Promise.allSettled([firstCommit, secondCommit]);

    // Surface the underlying error rather than a vague assertion if either commit is aborted.
    if (firstOutcome.status === 'rejected') {
      throw firstOutcome.reason;
    }
    if (secondOutcome.status === 'rejected') {
      throw secondOutcome.reason;
    }

    expect(firstOutcome.value.workspaceVersion).toBe(3);
    expect(secondOutcome.value.workspaceVersion).toBe(3);

    for (const agent of [firstAgent, secondAgent]) {
      const snapshot = await infra.workspaces.load(ctx, agent);

      // Each merge kept the other writer's head entry and added its own candidate entry.
      expect(snapshot.version).toBe(3);
      expect(snapshot.manifest.files.map((entry) => entry.path).sort()).toEqual([
        'head.txt',
        'new.txt',
        'own.txt',
      ]);
    }
  });
});

describe('P0B06 grant binding (P1-3)', () => {
  it('rejects a grant bound to another agent of the same tenant with zero writes', async () => {
    const attempt = await claimTask('grant-wrong-agent');
    const otherAgent = await agents.create(ctx, { name: 'p0b06 second agent' });
    const forged = { ...attempt.grant, agentId: otherAgent.agentId };
    const versionsBefore = await workspaceVersions(agentId);

    await expect(
      infra.committer.commitStep(forged, await resultRequest('forged agent')),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });

    const task = await readTask(db.pool, tenant.tenantId, attempt.lease.taskId);

    expect(task.status).toBe('running');
    expect(await artifactRows(attempt.lease.taskId)).toBe(0);
    expect(await workspaceVersions(agentId)).toBe(versionsBefore);
    expect(await workspaceVersions(otherAgent.agentId)).toBe(0);
  });

  it('rejects a grant that names a worker which does not own the run', async () => {
    const attempt = await claimTask('grant-wrong-worker');

    for (const workerId of ['worker-someone-else', null]) {
      await expect(
        infra.committer.commitStep(
          { ...attempt.grant, workerId },
          await resultRequest(`forged worker ${String(workerId)}`),
        ),
      ).rejects.toMatchObject({ code: 'STALE_LEASE' });
    }

    expect(await artifactRows(attempt.lease.taskId)).toBe(0);
    expect((await counters(attempt.lease.taskId))['completed'] ?? 0).toBe(0);
  });

  it('accepts the grant derived from the persisted run', async () => {
    const attempt = await claimTask('grant-valid');
    const receipt = await infra.committer.commitStep(
      attempt.grant,
      await resultRequest('valid grant'),
    );

    expect(receipt.replayed).toBe(false);
    expect((await readTask(db.pool, tenant.tenantId, attempt.lease.taskId)).status).toBe(
      'completed',
    );
  });
});

describe('P0B06 idempotency digest completeness (P2-1)', () => {
  it('treats a different checkpoint dependency as a conflicting command', async () => {
    const attempt = await claimTask('digest-dependency');
    const staged = await infra.blobs.stage(
      tenant.tenantId,
      Buffer.from('digest dependency'),
      'text/plain',
    );
    const base: CommitStepRequest = {
      operationId: 'step:digest:dependency',
      mode: 'progress',
      artifacts: [{ artifactId: staged.stagedId, staged }],
      checkpoint: {
        stepId: 'produce',
        stepSequence: 1,
        inputDigest: 'a'.repeat(64),
        executorVersion: 'deterministic-executor@1',
        workspaceVersion: 0,
        artifacts: [],
      },
    };

    await infra.committer.commitStep(attempt.grant, base);

    // Same operation id and same artifacts, but a different workspace dependency and cursor:
    // this is not the same request and must not be replayed as if it were.
    await expect(
      infra.committer.commitStep(attempt.grant, {
        ...base,
        checkpoint: { ...base.checkpoint!, workspaceVersion: 7 },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    await expect(
      infra.committer.commitStep(attempt.grant, {
        ...base,
        checkpoint: { ...base.checkpoint!, stepSequence: 2 },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('P0B06 P2-3 conflict candidate persistence in the committer', () => {
  it('does not report a conflict when the candidate could not be stored', async () => {
    const base = await infra.workspaces.load(ctx, agentId);
    const artifact = await infra.artifacts.put(ctx, Buffer.from('p2-3 base'), 'text/plain');

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

    const attempt = await claimTask('commit-conflict-persist');
    const staged = await infra.blobs.stage(
      tenant.tenantId,
      Buffer.from('p2-3 candidate'),
      'text/plain',
    );
    const request: CommitStepRequest = {
      operationId: `op:cas-persist:${randomUUID()}`,
      mode: 'result',
      artifacts: [{ artifactId: staged.stagedId, staged }],
      workspace: {
        expectedVersion: base.version,
        manifest: {
          files: [
            {
              path: 'existing.txt',
              artifactId: staged.stagedId,
              sha256: staged.sha256,
              size: staged.size,
            },
          ],
        },
      },
    };

    await db.pool.query(
      'ALTER TABLE workspace_conflicts ADD CONSTRAINT p0b06_block_conflict_commit CHECK (false) NOT VALID',
    );

    try {
      await expect(infra.committer.commitStep(attempt.grant, request)).rejects.toMatchObject({
        code: 'DB_UNAVAILABLE',
      });
    } finally {
      await db.pool.query(
        'ALTER TABLE workspace_conflicts DROP CONSTRAINT p0b06_block_conflict_commit',
      );
    }

    // The result commit is still fully rolled back.
    expect((await readTask(db.pool, tenant.tenantId, attempt.lease.taskId)).status).toBe('running');
    expect(await artifactRows(attempt.lease.taskId)).toBe(0);
    expect((await counters(attempt.lease.taskId))['completed'] ?? 0).toBe(0);
  });
});

/**
 * Blob store whose installed file disappears right after `install`, i.e. the collector won the
 * race while the publisher was still between install and its publishing transaction.
 */
function blobsLosingToGc(): BlobStore {
  return {
    stage: (tenantId, source, mediaType, options) =>
      infra.blobs.stage(tenantId, source, mediaType, options),
    install: async (tenantId, staged) => {
      const installed = await infra.blobs.install(tenantId, staged);

      await infra.files.removeKey(installed.storageKey, 'blobs');

      return installed;
    },
    read: (tenantId, storageKey) => infra.blobs.read(tenantId, storageKey),
    verifyContent: (tenantId, sha256, size) => infra.blobs.verifyContent(tenantId, sha256, size),
    assertInstalled: (tenantId, sha256, size) =>
      infra.blobs.assertInstalled(tenantId, sha256, size),
    verify: (tenantId, storageKey, expectedSha256, expectedSize) =>
      infra.blobs.verify(tenantId, storageKey, expectedSha256, expectedSize),
    discard: (tenantId, staged) => infra.blobs.discard(tenantId, staged),
    sweepOrphans: (now, options) => infra.blobs.sweepOrphans(now, options),
  };
}

describe('P0B06 P1-4 a publish that races the collector', () => {
  it('writes nothing when the installed bytes are gone at publication time', async () => {
    const attempt = await claimTask('gc-race');
    const request = await resultRequest('swept between install and commit');
    const [artifact] = request.artifacts ?? [];

    expect(artifact).toBeDefined();

    const committer = new PostgresRunResultCommitter(db.pool, {
      policy: resolveLeaseQueueConfig({ leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 500 }),
      blobs: blobsLosingToGc(),
    });

    await expect(committer.commitStep(attempt.grant, request)).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
    });

    // No row may point at bytes that no longer exist, and the Task keeps running so the step
    // is redone instead of the Run being lost.
    expect(await artifactRows(attempt.lease.taskId)).toBe(0);
    expect((await readTask(db.pool, tenant.tenantId, attempt.lease.taskId)).status).toBe('running');

    const blobRows = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM blobs WHERE tenant_id = $1 AND sha256 = $2',
      [tenant.tenantId, artifact!.staged.sha256],
    );

    expect(Number(blobRows.rows[0]?.count ?? '0')).toBe(0);
  });
});

/**
 * Round 3 review, P1-B.
 *
 * A Step checkpoint is a durable Artifact reference that no foreign key protects. The commit
 * must hold `FOR SHARE` on each referenced Artifact row until it commits, so an in-flight
 * `ArtifactStore.delete` waits and then observes the checkpoint instead of deleting first.
 */
describe('P0B06 P1-B a checkpoint that races an artifact delete', () => {
  it('holds the reference lock until commit, then the delete is refused', async () => {
    const attempt = await claimTask('checkpoint-delete-race');
    const published = await infra.artifacts.put(
      ctx,
      Buffer.from('checkpoint referenced bytes'),
      'text/plain',
    );

    let reachedCheckpoint: (() => void) | undefined;
    let releaseCommit: (() => void) | undefined;
    const checkpointWritten = new Promise<void>((resolve) => {
      reachedCheckpoint = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });

    const committer = new PostgresRunResultCommitter(db.pool, {
      policy: resolveLeaseQueueConfig({ leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 500 }),
      blobs: infra.blobs,
      faultInjector: async (point) => {
        if (point === 'before_event') {
          // The checkpoint row is written but the transaction is still open.
          reachedCheckpoint?.();
          await gate;
        }
      },
    });

    const request: CommitStepRequest = {
      operationId: `op:checkpoint-race:${randomUUID()}`,
      mode: 'progress',
      checkpoint: {
        stepId: 'checkpoint-delete-race',
        inputDigest: 'd'.repeat(64),
        executorVersion: 'executor-test@1',
        artifacts: [
          {
            artifactId: published.artifactId,
            sha256: published.sha256,
            size: published.size,
            mediaType: 'text/plain',
          },
        ],
      },
    };

    const commit = committer.commitStep(attempt.grant, request);

    await checkpointWritten;

    const deletion = infra.artifacts.delete(ctx, published.artifactId);
    let settled = false;

    void deletion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);

    releaseCommit?.();
    const receipt = await commit;

    expect(receipt.checkpointId).not.toBeNull();
    await expect(deletion).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(infra.artifacts.get(ctx, published.artifactId)).resolves.toEqual(
      Buffer.from('checkpoint referenced bytes'),
    );
  });
});
