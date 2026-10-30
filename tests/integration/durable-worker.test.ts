import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  CommitReceipt,
  CommitStepRequest,
  RunGrant,
  RunResultCommitter,
} from '@ember/contracts';
import type { AuthContext } from '@ember/domain';
import {
  DeterministicExecutionRouter,
  DeterministicExecutor,
  type BudgetPolicy,
} from '@ember/execution';
import {
  PostgresAgentRepository,
  PostgresBudgetLedger,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
} from '@ember/postgres';
import {
  createDurableRunHandler,
  CHECKPOINT_EXECUTOR_VERSION,
} from '../../apps/worker/src/durable-run-handler.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { chatCommand, createTenantFixture, type TenantFixture } from './support/fixtures.js';
import { ManualClock, databaseNow, listEventSnapshots, readTask } from './support/leases.js';
import { createP06Infra, type P06Infra } from './support/p0b06.js';

/**
 * P0B-06 closing scenario: the P0B-05 deterministic executor now produces a *durable* result.
 *
 * Artifact → Checkpoint → simulated crash → new Run/epoch → resume from the committed
 * checkpoint → Workspace version + terminal Task, all through the real fenced committer.
 */

const WORKER_ID = 'worker-p0b06-durable';
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

const logger = createWorkerLogger({ level: 'error', sink: () => undefined });

/**
 * This suite proves durability, not limits, so it runs the real durable ledger with headroom.
 * The budget behaviour itself is covered by `persistent-budget.test.ts`.
 */
const PERMISSIVE_BUDGET: BudgetPolicy = Object.freeze({
  policyId: 'p0b06-durability-permissive',
  policyVersion: 1,
  maxRunSteps: 1_000,
  maxRunUnits: 1_000_000,
  maxRunElapsedMs: 10_000_000,
  maxTenantDailyUnits: 1_000_000,
  maxConcurrentSlots: 64,
});

/** Committer wrapper that fails at the publish step: a crash *after* the produce step. */
function crashingCommitter(inner: RunResultCommitter): RunResultCommitter {
  return {
    commitStep: (grant: RunGrant, request: CommitStepRequest): Promise<CommitReceipt> => {
      if (request.operationId.startsWith('step:publish')) {
        return Promise.reject(new Error('simulated worker crash after the produce step'));
      }

      return inner.commitStep(grant, request);
    },
    findReceipt: (grant: RunGrant, operationId: string) => inner.findReceipt(grant, operationId),
  };
}

function handlerWith(committer: RunResultCommitter) {
  return createDurableRunHandler({
    contextReader: reader,
    router: new DeterministicExecutionRouter(),
    executor: new DeterministicExecutor({ sandboxExecDurationMs: 1 }),
    blobs: infra.blobs,
    checkpoints: infra.checkpoints,
    committer,
    workspaces: infra.workspaces,
    budget: new PostgresBudgetLedger(db.pool, { policy: PERMISSIVE_BUDGET }),
    clock,
    logger,
  });
}

async function syncClock(): Promise<void> {
  clock.set(new Date((await databaseNow(db.pool)).getTime() + 1));
}

beforeAll(async () => {
  db = await createTestDatabase();
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool);
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 3 };
  agentId = (await agents.create(ctx, { name: 'p0b06 durable agent' })).agentId;
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

describe('P0B06 durable executor closure', () => {
  it('publishes an artifact and checkpoint, crashes, then resumes and completes', async () => {
    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, 'p0b06-durable-1', 'durable closure prompt'),
    );
    const taskId = receipt.taskId;

    await syncClock();
    const first = await queue.claimNext(WORKER_ID, clock.now());

    expect(first?.taskId).toBe(taskId);

    const firstCompletion = await handlerWith(crashingCommitter(infra.committer)).handle(
      first!,
      AbortSignal.timeout(10_000),
    );

    expect(firstCompletion).toEqual({ type: 'finish', outcome: 'failed_retryable' });

    // The produce step is durable even though the Run did not finish.
    const artifacts = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    const checkpoints = await db.pool.query<{ step_id: string }>(
      `SELECT step_id FROM step_checkpoints
        WHERE tenant_id = $1 AND task_id = $2 ORDER BY step_sequence`,
      [tenant.tenantId, taskId],
    );

    expect(artifacts.rows[0]?.count).toBe('1');
    expect(checkpoints.rows.map((row) => row.step_id)).toEqual(['produce']);
    await expect(infra.workspaces.load(ctx, agentId)).resolves.toMatchObject({ version: 0 });

    // The worker reports the failure; the queue schedules a bounded retry.
    await expect(queue.finish(first!, 'failed_retryable')).resolves.toBe(true);
    expect((await readTask(db.pool, tenant.tenantId, taskId)).status).toBe('retryable_failed');

    clock.advance(1_000);

    const second = await queue.claimNext(WORKER_ID, clock.now());

    expect(second?.taskId).toBe(taskId);
    expect(second?.runId).not.toBe(first?.runId);
    expect(second?.leaseEpoch).toBeGreaterThan(first!.leaseEpoch);

    const completion = await handlerWith(infra.committer).handle(
      second!,
      AbortSignal.timeout(10_000),
    );

    expect(completion.type).toBe('committed');

    // No duplicate artifact or produce checkpoint was written on resume.
    const after = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );

    expect(after.rows[0]?.count).toBe('1');

    const checkpointRows = await db.pool.query<{ step_id: string }>(
      `SELECT step_id FROM step_checkpoints
        WHERE tenant_id = $1 AND task_id = $2 ORDER BY step_sequence`,
      [tenant.tenantId, taskId],
    );

    expect(checkpointRows.rows.map((row) => row.step_id)).toEqual(['produce', 'publish']);

    const published = await infra.workspaces.load(ctx, agentId);
    const expectedPath = `chat/${taskId}.txt`;

    expect(published.version).toBe(1);
    expect(published.manifest.files.map((file) => file.path)).toEqual([expectedPath]);

    const file = published.manifest.files[0];

    expect(file).toBeDefined();

    // The published manifest points at readable, verified bytes.
    const bytes = await infra.artifacts.get(ctx, file!.artifactId);

    expect(bytes.byteLength).toBe(file!.size);
    await expect(
      infra.artifacts.verify(ctx, file!.artifactId, file!.sha256, file!.size),
    ).resolves.toBe(true);

    expect((await readTask(db.pool, tenant.tenantId, taskId)).status).toBe('completed');

    const events = await listEventSnapshots(db.pool, tenant.tenantId, taskId);

    expect(events.filter((event) => event.phase === 'completed')).toHaveLength(1);
    expect(events.filter((event) => event.phase === 'progress')).toHaveLength(1);

    // The checkpoint is readable input for a future Run of the same Task.
    const latest = await infra.checkpoints.loadLatest(
      {
        tenantId: tenant.tenantId,
        taskId,
        runId: second!.runId,
        agentId,
        attempt: second!.attempt,
        leaseEpoch: second!.leaseEpoch,
        workerId: WORKER_ID,
      },
      { executorVersion: CHECKPOINT_EXECUTOR_VERSION },
    );

    expect(latest?.stepId).toBe('publish');
    expect(latest?.runId).toBe(second!.runId);
  });
});

describe('P0B06 incompatible checkpoint must not re-execute the step', () => {
  async function seedCheckpoint(input: {
    readonly taskId: string;
    readonly lease: {
      readonly runId: string;
      readonly attempt: number;
      readonly leaseEpoch: number;
    };
    readonly executorVersion: string;
    readonly inputDigest: string;
    readonly stepId?: string;
    readonly stepSequence?: number;
  }): Promise<void> {
    await db.pool.query(
      `INSERT INTO step_checkpoints (
         id, tenant_id, task_id, run_id, attempt, lease_epoch, schema_version, step_id,
         step_sequence, input_digest, executor_version, cursor, workspace_version, artifacts,
         external_effects
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, $9, $10, $7, $8, '{}'::jsonb, NULL,
                 '[]'::jsonb, '[]'::jsonb)`,
      [
        randomUUID(),
        tenant.tenantId,
        input.taskId,
        input.lease.runId,
        input.lease.attempt,
        input.lease.leaseEpoch,
        input.inputDigest,
        input.executorVersion,
        input.stepId ?? 'produce',
        input.stepSequence ?? 1,
      ],
    );
  }

  it('stops the Run when a committed checkpoint is from an incompatible executor', async () => {
    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, 'p0b06-durable-incompatible', 'incompatible checkpoint prompt'),
    );
    const taskId = receipt.taskId;

    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());

    expect(lease?.taskId).toBe(taskId);

    const workspaceBefore = await infra.workspaces.load(ctx, agentId);

    await seedCheckpoint({
      taskId,
      lease: lease!,
      executorVersion: 'legacy-executor@0',
      inputDigest: 'a'.repeat(64),
    });

    const completion = await handlerWith(infra.committer).handle(
      lease!,
      AbortSignal.timeout(10_000),
    );

    // Safely stopped, not silently re-executed.
    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

    const artifacts = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    const checkpoints = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );

    expect(artifacts.rows[0]?.count).toBe('0');
    expect(checkpoints.rows[0]?.count).toBe('1');
    await expect(infra.workspaces.load(ctx, agentId)).resolves.toMatchObject({
      version: workspaceBefore.version,
    });
  });

  it('stops the Run when the committed step is unreadable but another step is not', async () => {
    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, 'p0b06-durable-mixed', 'mixed checkpoint prompt'),
    );
    const taskId = receipt.taskId;

    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());

    expect(lease?.taskId).toBe(taskId);

    const workspaceBefore = await infra.workspaces.load(ctx, agentId);

    // A readable step from another position plus an unreadable copy of the step this build
    // would run: the readable one must not make the unreadable one look unexecuted.
    await seedCheckpoint({
      taskId,
      lease: lease!,
      executorVersion: CHECKPOINT_EXECUTOR_VERSION,
      inputDigest: 'c'.repeat(64),
      stepId: 'publish',
      stepSequence: 2,
    });
    await seedCheckpoint({
      taskId,
      lease: lease!,
      executorVersion: 'legacy-executor@0',
      inputDigest: 'd'.repeat(64),
      stepSequence: 1,
    });

    const completion = await handlerWith(infra.committer).handle(
      lease!,
      AbortSignal.timeout(10_000),
    );

    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

    const artifacts = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );
    const checkpoints = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );

    expect(artifacts.rows[0]?.count).toBe('0');
    expect(checkpoints.rows[0]?.count).toBe('2');
    await expect(infra.workspaces.load(ctx, agentId)).resolves.toMatchObject({
      version: workspaceBefore.version,
    });
  });

  it('stops the Run when a committed step belongs to different input', async () => {
    const receipt = await tasks.create(
      ctx,
      chatCommand(agentId, 'p0b06-durable-input-mismatch', 'mismatched input prompt'),
    );
    const taskId = receipt.taskId;

    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());

    expect(lease?.taskId).toBe(taskId);

    await seedCheckpoint({
      taskId,
      lease: lease!,
      executorVersion: CHECKPOINT_EXECUTOR_VERSION,
      inputDigest: 'b'.repeat(64),
    });

    const completion = await handlerWith(infra.committer).handle(
      lease!,
      AbortSignal.timeout(10_000),
    );

    expect(completion).toEqual({ type: 'finish', outcome: 'failed_terminal' });

    const artifacts = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1 AND task_id = $2',
      [tenant.tenantId, taskId],
    );

    expect(artifacts.rows[0]?.count).toBe('0');
  });
});
