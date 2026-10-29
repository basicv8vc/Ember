import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '@ember/domain';
import {
  DeterministicExecutionRouter,
  DeterministicExecutor,
  EXECUTABLE_TASK_KINDS,
  FakeLlm,
} from '@ember/execution';
import {
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresTaskRepository,
  type LeaseQueueConfigOverrides,
} from '@ember/postgres';
import {
  createRunHandler,
  type RunHandler,
  type RunHandlerCompletion,
} from '../../apps/worker/src/run-handler.js';
import { runPollLoop, type PollLoopSummary } from '../../apps/worker/src/poll-loop.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { computeCommand, createTenantFixture, type TenantFixture } from './support/fixtures.js';
import {
  ManualClock,
  createQueuedTask,
  databaseNow,
  listEventSnapshots,
  readRun,
  readTask,
  setTaskControls,
} from './support/leases.js';

const WORKER_ID = 'worker-p0b05';

const QUEUE_OPTIONS: LeaseQueueConfigOverrides = {
  // A long retry backoff keeps a retryable task out of the way of later tests.
  baseDelayMs: 60_000,
  capDelayMs: 60_000,
  leaseDurationMs: 5_000,
  heartbeatIntervalMs: 500,
  reaperBatchSize: 10,
};

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenant: TenantFixture;
let ctx: AuthContext;
let agentId: string;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let reader: PostgresRunExecutionContextReader;

/** Build the production worker seam (router + executor + handler) over the real database. */
function buildHandler(
  executor = new DeterministicExecutor({ sandboxExecDurationMs: 1 }),
): RunHandler {
  return createRunHandler({
    contextReader: reader,
    router: new DeterministicExecutionRouter(),
    executor,
    clock,
    logger: createWorkerLogger({ level: 'error', sink: () => undefined }),
  });
}

/**
 * Advance the manual clock to database time.
 *
 * A queued Task is only claimable once `next_run_at <= now`, and `next_run_at` is written by
 * PostgreSQL, so a clock sampled before creation would never be eligible.
 */
async function syncClock(): Promise<void> {
  clock.set(await databaseNow(db.pool));
}

/**
 * Run the real poll loop in the background until `isDone()` reports that the database
 * converged, then stop it and return the loop's own summary.
 */
async function driveUntil(
  handler: RunHandler,
  isDone: () => Promise<boolean>,
  options: {
    readonly queue?: PostgresLeaseQueue;
    readonly stopAfterMs?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<PollLoopSummary> {
  const controller = new AbortController();

  // Make every Task created by the test eligible for the loop's first claim.
  await syncClock();

  const loop = runPollLoop({
    queue: options.queue ?? queue,
    handler,
    clock,
    workerId: WORKER_ID,
    concurrency: 2,
    heartbeatIntervalMs: QUEUE_OPTIONS.heartbeatIntervalMs ?? 500,
    idleIntervalMs: 25,
    errorBackoffMs: 25,
    logger: createWorkerLogger({ level: 'error', sink: () => undefined }),
    signal: controller.signal,
  });

  const startedAt = Date.now();
  const deadline = startedAt + (options.timeoutMs ?? 10_000);

  try {
    while (!(await isDone())) {
      const elapsed = Date.now() - startedAt;

      if (options.stopAfterMs !== undefined && elapsed > options.stopAfterMs) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('the worker did not converge within the test timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    controller.abort();
  }

  return loop;
}

async function taskStatus(taskId: string): Promise<string> {
  return (await readTask(db.pool, tenant.tenantId, taskId)).status;
}

describe('P0B05-T03 fencing through the execution context', () => {
  it('refuses a context and a finish once the lease has expired', async () => {
    const created = await createQueuedTask(tasks, ctx, agentId, 'fence');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());

    expect(lease?.taskId).toBe(created.taskId);

    const live = await reader.read(lease!, clock.now());

    expect(live.taskId).toBe(created.taskId);
    expect(live.runId).toBe(lease!.runId);
    expect(live.kind).toBe('mock.chat');
    expect(live.leaseEpoch).toBe(lease!.leaseEpoch);
    expect(live.attempt).toBe(lease!.attempt);
    expect(live.policyVersion).toBe(3);
    expect(Object.isFrozen(live)).toBe(true);

    clock.advance((QUEUE_OPTIONS.leaseDurationMs ?? 5_000) + 1_000);

    // The old lease can no longer obtain a context, renew, or submit a result.
    await expect(reader.read(lease!, clock.now())).rejects.toMatchObject({ code: 'STALE_LEASE' });
    await expect(queue.heartbeat(lease!, clock.now())).resolves.toBe(false);
    await expect(queue.finish(lease!, 'succeeded')).resolves.toBe(false);
  });

  it('does not return a context for a Run that is not visible in the tenant', async () => {
    const created = await createQueuedTask(tasks, ctx, agentId, 'fence-missing');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());

    expect(lease?.taskId).toBe(created.taskId);

    await expect(
      reader.read({ ...lease!, runId: randomUUID() }, clock.now()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await queue.finish(lease!, 'cancelled');
  });

  it('refuses a context whose lease expired while the statement was in flight', async () => {
    const created = await createQueuedTask(tasks, ctx, agentId, 'fence-round-trip');
    await syncClock();
    const lease = await queue.claimNext(WORKER_ID, clock.now());

    expect(lease?.taskId).toBe(created.taskId);

    // The worker sampled its clock *before* the round trip and the database still evaluates
    // the row against its own statement time; a lease that expires while the statement runs
    // must not yield an execution context.
    const late = new PostgresRunExecutionContextReader(db.pool, {
      now: () => new Date(clock.now().getTime() + (QUEUE_OPTIONS.leaseDurationMs ?? 5_000) + 1_000),
    });

    await expect(late.read(lease!, clock.now())).rejects.toMatchObject({ code: 'STALE_LEASE' });

    // The identical read with an honest clock is accepted, so the rejection is caused by the
    // hand-off re-validation and not by an unrelated fencing mismatch.
    await expect(reader.read(lease!, clock.now())).resolves.toMatchObject({
      taskId: created.taskId,
      runId: lease!.runId,
    });

    await queue.finish(lease!, 'cancelled');
  });
});

describe('P0B05-T04 failure classification', () => {
  it('schedules a bounded retry for a retryable simulated failure', async () => {
    const created = await createQueuedTask(tasks, ctx, agentId, 'retryable');
    const failing = new DeterministicExecutor({ llm: new FakeLlm({ fault: 'tool_failed' }) });

    await driveUntil(
      buildHandler(failing),
      async () => (await taskStatus(created.taskId)) === 'retryable_failed',
    );

    const task = await readTask(db.pool, tenant.tenantId, created.taskId);
    const phases = (await listEventSnapshots(db.pool, tenant.tenantId, created.taskId)).map(
      (event) => event.phase,
    );

    expect(task.status).toBe('retryable_failed');
    expect(task.attempt_count).toBe(1);
    expect(new Date(task.next_run_at).getTime()).toBeGreaterThan(0);
    expect(phases).toContain('retry_scheduled');
  });

  it('fails terminally when the simulated policy denies execution', async () => {
    const created = await createQueuedTask(tasks, ctx, agentId, 'denied');
    const denying = new DeterministicExecutor({ llm: new FakeLlm({ fault: 'denied' }) });

    await driveUntil(
      buildHandler(denying),
      async () => (await taskStatus(created.taskId)) === 'failed',
    );

    const task = await readTask(db.pool, tenant.tenantId, created.taskId);
    const run = await readRun(db.pool, tenant.tenantId, created.taskId, task.current_run_id ?? '');
    const phases = (await listEventSnapshots(db.pool, tenant.tenantId, created.taskId)).map(
      (event) => event.phase,
    );

    expect(task.status).toBe('failed');
    expect(run?.status).toBe('failed_terminal');
    expect(phases).toContain('failed');
  });

  it('never completes a Task whose deadline already passed', async () => {
    const created = await createQueuedTask(tasks, ctx, agentId, 'deadline');
    const past = new Date(clock.now().getTime() - 60_000);

    await setTaskControls(db.pool, created.taskId, { deadlineAt: past });

    await driveUntil(buildHandler(), async () => (await taskStatus(created.taskId)) === 'failed', {
      stopAfterMs: 2_000,
    });

    const task = await readTask(db.pool, tenant.tenantId, created.taskId);

    expect(task.status).toBe('failed');
    expect(task.deadline_at?.getTime()).toBe(past.getTime());
  });
});

describe('P0B05-T02 claim → execute → finish', () => {
  it('completes a mock.chat Task through the real lease and worker flow', async () => {
    const created = await createQueuedTask(tasks, ctx, agentId, 'chat-e2e');

    const summary = await driveUntil(buildHandler(), async () => {
      const status = await taskStatus(created.taskId);
      return status === 'completed' || status === 'failed';
    });

    const task = await readTask(db.pool, tenant.tenantId, created.taskId);
    const run = await readRun(db.pool, tenant.tenantId, created.taskId, task.current_run_id ?? '');
    const phases = (await listEventSnapshots(db.pool, tenant.tenantId, created.taskId)).map(
      (event) => event.phase,
    );

    expect(task.status).toBe('completed');
    expect(run?.status).toBe('succeeded');
    expect(run?.worker_id).toBe(WORKER_ID);
    expect(phases).toContain('started');
    expect(phases).toContain('completed');
    // The simulated result is never persisted as an artifact, so no artifact event exists.
    expect(phases).not.toContain('artifact_created');
    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    expect(summary.finished).toBeGreaterThanOrEqual(1);
    expect(summary.abandoned).toBe(0);
  });

  it('completes a mock.compute Task through the simulated sandbox lifecycle', async () => {
    const receipt = await tasks.create(ctx, computeCommand(agentId, `compute-e2e-${randomUUID()}`));

    const summary = await driveUntil(buildHandler(), async () => {
      const status = await taskStatus(receipt.taskId);
      return status === 'completed' || status === 'failed';
    });

    const task = await readTask(db.pool, tenant.tenantId, receipt.taskId);

    expect(task.status).toBe('completed');
    expect(summary.finished).toBeGreaterThanOrEqual(1);
  });

  it('does not claim or mutate a Task of a kind it cannot execute', async () => {
    const receipt = await tasks.create(ctx, {
      agentId,
      idempotencyKey: `file-unclaimed-${randomUUID()}`,
      kind: 'mock.file',
      input: { fileKey: 'notes/report.txt', content: 'payload', mediaType: 'text/plain' },
    });

    const summary = await driveUntil(buildHandler(), () => Promise.resolve(false), {
      stopAfterMs: 400,
    });

    const task = await readTask(db.pool, tenant.tenantId, receipt.taskId);

    expect(summary.claimed).toBe(0);
    expect(task.status).toBe('queued');
    expect(task.attempt_count).toBe(0);

    // A queue without the capability filter can still claim it, which proves the isolation
    // comes from `claimableKinds` and not from the Task being invisible.
    const unfiltered = new PostgresLeaseQueue(db.pool, { ...QUEUE_OPTIONS, clock });
    const lease = await unfiltered.claimNext('worker-unfiltered', clock.now());

    expect(lease?.taskId).toBe(receipt.taskId);
    await unfiltered.finish(lease!, 'cancelled');
  });
});

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 24 });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool, 'P0B-05 execution tenant');
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 3 };
  agentId = (await agents.create(ctx, { name: 'P0B-05 execution agent' })).agentId;

  clock = new ManualClock(await databaseNow(db.pool));
  queue = new PostgresLeaseQueue(db.pool, {
    ...QUEUE_OPTIONS,
    clock,
    claimableKinds: EXECUTABLE_TASK_KINDS,
  });
  reader = new PostgresRunExecutionContextReader(db.pool, clock);
});

afterAll(async () => {
  await db?.close();
});
describe('P0B05-T06 graceful shutdown', () => {
  it('stops without finishing an in-flight execution and leaves recovery to the reaper', async () => {
    const created = await createQueuedTask(tasks, ctx, agentId, 'shutdown');
    const controller = new AbortController();

    await syncClock();
    let started = (): void => undefined;
    const startedOnce = new Promise<void>((resolve) => {
      started = resolve;
    });

    const blocking: RunHandler = {
      handle: async (_run, signal): Promise<RunHandlerCompletion> => {
        started();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { type: 'finish', outcome: 'succeeded' } as const;
      },
    };

    const loop = runPollLoop({
      queue,
      handler: blocking,
      clock,
      workerId: WORKER_ID,
      concurrency: 1,
      heartbeatIntervalMs: QUEUE_OPTIONS.heartbeatIntervalMs ?? 500,
      idleIntervalMs: 25,
      errorBackoffMs: 25,
      logger: createWorkerLogger({ level: 'error', sink: () => undefined }),
      signal: controller.signal,
    });

    await startedOnce;
    controller.abort();

    const summary = await loop;
    const task = await readTask(db.pool, tenant.tenantId, created.taskId);
    const run = await readRun(db.pool, tenant.tenantId, created.taskId, task.current_run_id ?? '');

    expect(summary.abandoned).toBe(1);
    expect(summary.finished).toBe(0);
    // Nothing was submitted: the lease is still held exactly as the database left it.
    expect(task.status).toBe('running');
    expect(run?.status).toBe('running');

    // A later Reaper tick owns the recovery of the abandoned lease.
    clock.advance((QUEUE_OPTIONS.leaseDurationMs ?? 5_000) + 1_000);

    expect(await queue.reapExpired(clock.now())).toBeGreaterThanOrEqual(1);
    expect((await readTask(db.pool, tenant.tenantId, created.taskId)).status).not.toBe('running');
  });
});
