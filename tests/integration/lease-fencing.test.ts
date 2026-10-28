import { randomUUID } from 'node:crypto';
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
} from './support/leases.js';

const FENCING_OPTIONS: LeaseQueueConfigOverrides = {
  baseDelayMs: 100,
  capDelayMs: 400,
  leaseDurationMs: 1_000,
  heartbeatIntervalMs: 100,
  reaperBatchSize: 10,
};

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let ctxA: AuthContext;
let ctxB: AuthContext;
let agentA: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let agentB: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let clock: ManualClock;
let queue: PostgresLeaseQueue;

async function syncClock(): Promise<void> {
  clock.set(await databaseNow(db.pool));
}

interface PersistentSnapshot {
  readonly task: Awaited<ReturnType<typeof readTask>>;
  readonly runs: Awaited<ReturnType<typeof listRuns>>;
  readonly events: string;
}

async function snapshot(tenantId: string, taskId: string): Promise<PersistentSnapshot> {
  return {
    task: await readTask(db.observerPool, tenantId, taskId),
    runs: await listRuns(db.observerPool, tenantId, taskId),
    events: JSON.stringify(await listEventSnapshots(db.observerPool, tenantId, taskId)),
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 24 });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenantA = await createTenantFixture(db.pool, 'fencing tenant A');
  tenantB = await createTenantFixture(db.pool, 'fencing tenant B');
  ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
  ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };
  agentA = await agents.create(ctxA, { name: 'fencing agent A' });
  agentB = await agents.create(ctxB, { name: 'fencing agent B' });

  clock = new ManualClock(await databaseNow(db.pool));
  queue = new PostgresLeaseQueue(db.pool, { ...FENCING_OPTIONS, clock });
});

afterAll(async () => {
  await db?.close();
});

describe('B-T11 fencing and late results', () => {
  it('rejects heartbeat and finish from an old run after a new run was claimed', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'old-run');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    const first = await queue.claimNext('worker-old', clock.now());
    expect(first).not.toBeNull();

    clock.advance(FENCING_OPTIONS.leaseDurationMs as number);
    await queue.reapExpired(clock.now());
    const afterReap = await readTask(db.observerPool, ctxA.tenantId, created.taskId);
    clock.set(afterReap.next_run_at);
    await parkOtherOpenTasks(db.pool, created.taskId);

    const second = await queue.claimNext('worker-new', clock.now());
    expect(second).not.toBeNull();
    expect(second?.attempt).toBe(2);
    expect(second?.leaseEpoch).toBe(2);

    const before = await snapshot(ctxA.tenantId, created.taskId);

    expect(await queue.heartbeat(first as NonNullable<typeof first>, clock.now())).toBe(false);
    expect(await queue.finish(first as NonNullable<typeof first>, 'succeeded')).toBe(false);
    expect(await queue.finish(first as NonNullable<typeof first>, 'failed_retryable')).toBe(false);

    const after = await snapshot(ctxA.tenantId, created.taskId);
    expect(after).toEqual(before);
    expect(after.task.current_run_id).toBe(second?.runId);
    expect(after.task.attempt_count).toBe(2);

    const oldRun = await readRun(
      db.observerPool,
      ctxA.tenantId,
      created.taskId,
      first?.runId as string,
    );
    expect(oldRun?.status).toBe('lease_expired');
  });

  it('rejects a correct run id with a stale or forged epoch, and a correct epoch with a wrong run id', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'epoch-fencing');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);
    const leased = await queue.claimNext('worker-epoch', clock.now());
    expect(leased).not.toBeNull();
    const before = await snapshot(ctxA.tenantId, created.taskId);

    const wrongEpoch = { ...(leased as NonNullable<typeof leased>), leaseEpoch: 999 };
    expect(await queue.heartbeat(wrongEpoch, clock.now())).toBe(false);
    expect(await queue.finish(wrongEpoch, 'succeeded')).toBe(false);

    const wrongRun = {
      ...(leased as NonNullable<typeof leased>),
      runId: randomUUID(),
    };
    expect(await queue.heartbeat(wrongRun, clock.now())).toBe(false);
    expect(await queue.finish(wrongRun, 'succeeded')).toBe(false);

    const after = await snapshot(ctxA.tenantId, created.taskId);
    expect(after).toEqual(before);
  });

  it('rejects a cross-tenant lease reference without touching either tenant', async () => {
    const taskA = await createQueuedTask(tasks, ctxA, agentA.agentId, 'cross-tenant-a');
    const taskB = await createQueuedTask(tasks, ctxB, agentB.agentId, 'cross-tenant-b');
    await syncClock();
    await parkOtherOpenTasks(db.pool, taskA.taskId);

    const leasedA = await queue.claimNext('worker-cross-a', clock.now());
    expect(leasedA?.taskId).toBe(taskA.taskId);
    const beforeA = await snapshot(ctxA.tenantId, taskA.taskId);
    const beforeB = await snapshot(ctxB.tenantId, taskB.taskId);

    const forged = { ...(leasedA as NonNullable<typeof leasedA>), tenantId: ctxB.tenantId };
    expect(await queue.heartbeat(forged, clock.now())).toBe(false);
    expect(await queue.finish(forged, 'succeeded')).toBe(false);

    expect(await snapshot(ctxA.tenantId, taskA.taskId)).toEqual(beforeA);
    expect(await snapshot(ctxB.tenantId, taskB.taskId)).toEqual(beforeB);

    // Do not leak a claimable Task into later tests.
    await tasks.requestCancel(ctxB, taskB.taskId);
  });

  it('rejects heartbeat and finish exactly at lease expiry before the reaper runs', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'expiry-boundary');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);
    const leased = await queue.claimNext('worker-boundary', clock.now());
    expect(leased).not.toBeNull();

    const expiry = new Date(leased?.leaseExpiresAt as string);
    clock.set(expiry);
    const before = await snapshot(ctxA.tenantId, created.taskId);

    expect(await queue.heartbeat(leased as NonNullable<typeof leased>, clock.now())).toBe(false);
    expect(await queue.finish(leased as NonNullable<typeof leased>, 'succeeded')).toBe(false);
    expect(await snapshot(ctxA.tenantId, created.taskId)).toEqual(before);

    // The Reaper still owns the transition, and the old worker cannot revive the Run.
    const reaped = await queue.reapExpired(clock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(await queue.finish(leased as NonNullable<typeof leased>, 'succeeded')).toBe(false);

    const run = await readRun(
      db.observerPool,
      ctxA.tenantId,
      created.taskId,
      leased?.runId as string,
    );
    expect(run?.status).toBe('lease_expired');
  });

  it('finishes a current run exactly once and never emits a second terminal event', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'single-finish');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);
    const leased = await queue.claimNext('worker-finish', clock.now());
    expect(leased).not.toBeNull();

    expect(await queue.finish(leased as NonNullable<typeof leased>, 'succeeded')).toBe(true);

    const first = await snapshot(ctxA.tenantId, created.taskId);
    expect(first.task.status).toBe('completed');
    expect(first.task.lease_expires_at).toBeNull();
    const run = await readRun(
      db.observerPool,
      ctxA.tenantId,
      created.taskId,
      leased?.runId as string,
    );
    expect(run?.status).toBe('succeeded');
    expect(run?.finished_at).not.toBeNull();

    expect(await queue.finish(leased as NonNullable<typeof leased>, 'succeeded')).toBe(false);
    expect(await queue.finish(leased as NonNullable<typeof leased>, 'failed_retryable')).toBe(
      false,
    );

    const second = await snapshot(ctxA.tenantId, created.taskId);
    expect(second).toEqual(first);

    const completedEvents = (
      await listEventSnapshots(db.observerPool, ctxA.tenantId, created.taskId)
    ).filter((event) => event.phase === 'completed');
    expect(completedEvents).toHaveLength(1);
    expect(await queue.claimNext('worker-after-finish', clock.now())).toBeNull();
  });

  it('refuses lease_expired as a worker outcome and rejects database errors instead of returning false', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'reaper-only-outcome');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);
    const leased = await queue.claimNext('worker-illegal-outcome', clock.now());
    expect(leased).not.toBeNull();
    const before = await snapshot(ctxA.tenantId, created.taskId);

    await expect(
      queue.finish(leased as NonNullable<typeof leased>, 'lease_expired'),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await snapshot(ctxA.tenantId, created.taskId)).toEqual(before);

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
        ...FENCING_OPTIONS,
        clock,
      });
      let caught: unknown;
      try {
        await unreachableQueue.finish(leased as NonNullable<typeof leased>, 'succeeded');
      } catch (error) {
        caught = error;
      }
      expect(isDomainError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('DB_UNAVAILABLE');
    } finally {
      await unreachablePool.end();
    }
  });
});
