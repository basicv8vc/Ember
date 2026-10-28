import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidArgumentError, isDomainError, type AuthContext } from '@ember/domain';
import {
  createPool,
  loadDatabaseConfig,
  PostgresAgentRepository,
  PostgresLeaseQueue,
  PostgresTaskRepository,
  type LeaseQueueConfigOverrides,
} from '@ember/postgres';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';
import {
  ManualClock,
  createQueuedTask,
  databaseNow,
  listEventSnapshots,
  listRuns,
  readRun,
  readTask,
  parkOtherOpenTasks,
  setTaskControls,
} from './support/leases.js';

const RECOVERY_OPTIONS: LeaseQueueConfigOverrides = {
  baseDelayMs: 100,
  capDelayMs: 400,
  leaseDurationMs: 1_000,
  heartbeatIntervalMs: 100,
  reaperBatchSize: 10,
};

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenant: TenantFixture;
let ctx: AuthContext;
let agent: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let clock: ManualClock;
let queue: PostgresLeaseQueue;
let secondQueue: PostgresLeaseQueue;

async function syncClock(): Promise<void> {
  clock.set(await databaseNow(db.pool));
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 24 });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool, 'recovery tenant');
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };
  agent = await agents.create(ctx, { name: 'recovery agent' });

  clock = new ManualClock(await databaseNow(db.pool));
  queue = new PostgresLeaseQueue(db.pool, { ...RECOVERY_OPTIONS, clock });
  secondQueue = new PostgresLeaseQueue(db.observerPool, { ...RECOVERY_OPTIONS, clock });
});

afterAll(async () => {
  await db?.close();
});

describe('B-T10 lease expiry and recovery', () => {
  it('reaps a crashed worker, schedules bounded backoff and claims a fresh run', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'crash-recovery');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    const claimed = await queue.claimNext('worker-crash', clock.now());
    expect(claimed).not.toBeNull();

    // Simulate a crashed worker: no heartbeat and no finish.
    clock.advance(RECOVERY_OPTIONS.leaseDurationMs as number);
    const reaped = await queue.reapExpired(clock.now());
    expect(reaped).toBe(1);

    const taskAfterReap = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(taskAfterReap.status).toBe('retryable_failed');
    expect(taskAfterReap.attempt_count).toBe(1);
    expect(taskAfterReap.lease_epoch).toBe('1');
    expect(taskAfterReap.lease_expires_at).toBeNull();
    expect(taskAfterReap.next_run_at.getTime()).toBe(
      clock.now().getTime() + (RECOVERY_OPTIONS.baseDelayMs as number),
    );

    const oldRun = await readRun(
      db.observerPool,
      ctx.tenantId,
      created.taskId,
      claimed?.runId as string,
    );
    expect(oldRun?.status).toBe('lease_expired');
    expect(oldRun?.finished_at).not.toBeNull();
    expect(oldRun?.leased_until).toBeNull();

    const eventsAfterReap = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(eventsAfterReap.map((event) => event.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'retry_scheduled',
    ]);
    expect(eventsAfterReap[3]?.payload['runStatus']).toBe('lease_expired');
    expect(eventsAfterReap[3]?.payload['toStatus']).toBe('retryable_failed');

    // Backoff has not elapsed yet.
    const tooEarly = await queue.claimNext('worker-too-early', clock.now());
    expect(tooEarly).toBeNull();

    // Step exactly to next_run_at and claim a brand-new Run/Epoch.
    clock.set(taskAfterReap.next_run_at);
    await parkOtherOpenTasks(db.pool, created.taskId);
    const retried = await queue.claimNext('worker-retry', clock.now());
    expect(retried?.taskId).toBe(created.taskId);
    expect(retried?.attempt).toBe(2);
    expect(retried?.leaseEpoch).toBe(2);
    expect(retried?.runId).not.toBe(claimed?.runId);

    const runs = await listRuns(db.observerPool, ctx.tenantId, created.taskId);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe('lease_expired');
    expect(runs[0]?.attempt).toBe(1);
    expect(runs[1]?.status).toBe('running');
    expect(runs[1]?.attempt).toBe(2);
    expect(runs[1]?.lease_epoch).toBe('2');

    const taskAfterRetry = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(taskAfterRetry.status).toBe('running');
    expect(taskAfterRetry.current_run_id).toBe(retried?.runId);
    expect(taskAfterRetry.attempt_count).toBe(2);
    expect(taskAfterRetry.lease_epoch).toBe('2');
  });

  it('lets two independent reapers terminalize the same expired run only once', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'dual-reaper');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);
    const claimed = await queue.claimNext('worker-dual-reaper', clock.now());
    expect(claimed).not.toBeNull();

    clock.advance(RECOVERY_OPTIONS.leaseDurationMs as number);

    const [first, second] = await Promise.all([
      queue.reapExpired(clock.now()),
      secondQueue.reapExpired(clock.now()),
    ]);

    expect(first + second).toBeGreaterThanOrEqual(1);

    const runs = await listRuns(db.observerPool, ctx.tenantId, created.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('lease_expired');

    const retryEvents = (
      await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId)
    ).filter((event) => event.phase === 'retry_scheduled');
    expect(retryEvents).toHaveLength(1);

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('retryable_failed');
    expect(task.attempt_count).toBe(1);
  });

  it('recovers from a restart through a new pool and queue instance', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'process-restart');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);
    const claimed = await queue.claimNext('worker-before-restart', clock.now());
    expect(claimed).not.toBeNull();

    clock.advance(RECOVERY_OPTIONS.leaseDurationMs as number);
    const freshQueue = new PostgresLeaseQueue(db.observerPool, { ...RECOVERY_OPTIONS, clock });
    const reaped = await freshQueue.reapExpired(clock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(['retryable_failed', 'failed']).toContain(task.status);
    expect(task.current_run_id).toBe(claimed?.runId);
  });

  it('does not retry after the attempt budget is exhausted', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'budget');
    await setTaskControls(db.pool, created.taskId, { maxAttempts: 1 });
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    const claimed = await queue.claimNext('worker-budget', clock.now());
    expect(claimed).not.toBeNull();
    clock.advance(RECOVERY_OPTIONS.leaseDurationMs as number);

    const reaped = await queue.reapExpired(clock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('failed');
    expect(task.attempt_count).toBe(1);
    expect(task.lease_expires_at).toBeNull();

    const runs = await listRuns(db.observerPool, ctx.tenantId, created.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('lease_expired');

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual(['accepted', 'leased', 'started', 'failed']);
    expect(events[3]?.payload['runStatus']).toBe('lease_expired');
  });

  it('converges a queued task whose deadline elapsed before any claim (OQ-2)', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'preclaim-deadline');
    await syncClock();
    const deadline = new Date(clock.now().getTime() + 200);
    await setTaskControls(db.pool, created.taskId, { deadlineAt: deadline });
    await parkOtherOpenTasks(db.pool, created.taskId);

    clock.set(deadline);

    const claimed = await queue.claimNext('worker-deadline', clock.now());
    expect(claimed).toBeNull();

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('failed');
    expect(task.attempt_count).toBe(0);
    expect(task.lease_epoch).toBe('0');
    expect(task.current_run_id).toBeNull();
    expect(await listRuns(db.observerPool, ctx.tenantId, created.taskId)).toHaveLength(0);

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual(['accepted', 'failed']);
    expect(events[1]?.payload['fromStatus']).toBe('queued');
    expect(events[1]?.payload['toStatus']).toBe('failed');
    expect(events[1]?.payload['errorCode']).toBe('DEADLINE_EXCEEDED');
  });

  it('reaps a running task at its deadline even before the lease expires', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'running-deadline');
    await syncClock();
    const deadline = new Date(clock.now().getTime() + 500);
    await setTaskControls(db.pool, created.taskId, { deadlineAt: deadline });
    await parkOtherOpenTasks(db.pool, created.taskId);

    const claimed = await queue.claimNext('worker-running-deadline', clock.now());
    expect(claimed).not.toBeNull();

    clock.set(deadline);
    const heartbeat = await queue.heartbeat(claimed as NonNullable<typeof claimed>, clock.now());
    expect(heartbeat).toBe(false);

    const reaped = await queue.reapExpired(clock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);

    const run = await readRun(
      db.observerPool,
      ctx.tenantId,
      created.taskId,
      claimed?.runId as string,
    );
    expect(run?.status).toBe('failed_terminal');

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('failed');
    expect(task.lease_expires_at).toBeNull();

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events[events.length - 1]?.phase).toBe('failed');
    expect(events[events.length - 1]?.payload['errorCode']).toBe('DEADLINE_EXCEEDED');
  });

  it('does not schedule a retry whose next_run_at would reach the deadline', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'retry-deadline');
    await syncClock();
    const deadline = new Date(clock.now().getTime() + 50);
    await setTaskControls(db.pool, created.taskId, { deadlineAt: deadline });
    await parkOtherOpenTasks(db.pool, created.taskId);

    const claimed = await queue.claimNext('worker-retry-deadline', clock.now());
    expect(claimed).not.toBeNull();

    // base backoff is 100ms; deadline is 50ms away, so no retry may be scheduled.
    expect(await queue.finish(claimed as NonNullable<typeof claimed>, 'failed_retryable')).toBe(
      true,
    );

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('failed');
    expect(task.lease_expires_at).toBeNull();

    const run = await readRun(
      db.observerPool,
      ctx.tenantId,
      created.taskId,
      claimed?.runId as string,
    );
    expect(run?.status).toBe('failed_retryable');

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual(['accepted', 'leased', 'started', 'failed']);
    expect(events[3]?.payload['errorCode']).toBe('DEADLINE_EXCEEDED');
    expect(await queue.claimNext('worker-after-retry-deadline', clock.now())).toBeNull();
  });

  it('rejects invalid clocks and does not swallow database outages', async () => {
    await expect(queue.reapExpired(new Date('not-a-date'))).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );

    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    expect(testDatabaseUrl).toBeDefined();
    const unreachable = new URL(testDatabaseUrl as string);
    unreachable.hostname = '127.0.0.1';
    unreachable.port = '1';
    const config = loadDatabaseConfig({
      DATABASE_URL: unreachable.toString(),
      EMBER_DB_CONNECT_TIMEOUT_MS: '300',
    });
    const unreachablePool = createPool({ ...config, maxConnections: 1 });

    try {
      const unreachableQueue = new PostgresLeaseQueue(unreachablePool, {
        ...RECOVERY_OPTIONS,
        clock,
      });
      let caught: unknown;
      try {
        await unreachableQueue.reapExpired(clock.now());
      } catch (error) {
        caught = error;
      }

      expect(isDomainError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('DB_UNAVAILABLE');
      expect(JSON.stringify(caught)).not.toContain('password');
    } finally {
      await unreachablePool.end();
    }
  });

  it('fails closed on an orphan running task instead of repairing it silently', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'orphan-running');
    await syncClock();
    const brokenLeaseExpiry = clock.now();
    await db.pool.query(
      `UPDATE tasks
          SET status = 'running', lease_expires_at = $1, current_run_id = NULL
        WHERE id = $2`,
      [brokenLeaseExpiry, created.taskId],
    );

    let caught: unknown;
    try {
      await queue.reapExpired(clock.now());
    } catch (error) {
      caught = error;
    }

    expect(isDomainError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('DB_UNAVAILABLE');
    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('running');
    expect(task.current_run_id).toBeNull();
    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual(['accepted']);
  });
});
