import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDomainError, type AuthContext } from '@ember/domain';
import {
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
  setTaskControls,
} from './support/leases.js';

const CANCEL_OPTIONS: LeaseQueueConfigOverrides = {
  baseDelayMs: 100,
  capDelayMs: 400,
  leaseDurationMs: 1_000,
  heartbeatIntervalMs: 100,
  reaperBatchSize: 20,
};

let db: TestDatabase;
let agents: PostgresAgentRepository;
let tasks: PostgresTaskRepository;
let tenant: TenantFixture;
let ctx: AuthContext;
let agent: Awaited<ReturnType<PostgresAgentRepository['create']>>;
let clock: ManualClock;
let queue: PostgresLeaseQueue;

async function syncClock(): Promise<void> {
  clock.set(await databaseNow(db.pool));
}

function cancelledEvents(events: readonly { phase: string }[]): number {
  return events.filter((event) => event.phase === 'cancelled').length;
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 32 });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);
  tenant = await createTenantFixture(db.pool, 'cancellation tenant');
  ctx = { tenantId: tenant.tenantId, principalId: tenant.principalId, policyVersion: 1 };
  agent = await agents.create(ctx, { name: 'cancellation agent' });

  clock = new ManualClock(await databaseNow(db.pool));
  queue = new PostgresLeaseQueue(db.pool, { ...CANCEL_OPTIONS, clock });
});

afterAll(async () => {
  await db?.close();
});

describe('OQ-1 cancellation and retry coordination', () => {
  it('cancels a queued task once and never creates a run for it', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'cancel-queued');
    await tasks.requestCancel(ctx, created.taskId);

    const first = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(first.status).toBe('cancelled');
    expect(first.cancel_requested_at).toBeInstanceOf(Date);

    await tasks.requestCancel(ctx, created.taskId);
    const second = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(second.cancel_requested_at?.toISOString()).toBe(
      first.cancel_requested_at?.toISOString(),
    );
    expect(second.updated_at.toISOString()).toBe(first.updated_at.toISOString());

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual(['accepted', 'cancelled']);
    expect(events[1]?.payload['fromStatus']).toBe('queued');
    expect(events[1]?.payload['cancelRequested']).toBe(true);
    expect(cancelledEvents(events)).toBe(1);

    expect(await listRuns(db.observerPool, ctx.tenantId, created.taskId)).toHaveLength(0);
    expect(await queue.claimNext('worker-after-cancel', clock.now())).toBeNull();
  });

  it('cancels retryable_failed directly (ADR-0001) without requeueing or creating a run', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'cancel-retryable');
    await syncClock();
    const leased = await queue.claimNext('worker-retryable-cancel', clock.now());
    expect(leased?.taskId).toBe(created.taskId);
    expect(await queue.finish(leased as NonNullable<typeof leased>, 'failed_retryable')).toBe(true);

    const retryable = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(retryable.status).toBe('retryable_failed');
    const runsBefore = await listRuns(db.observerPool, ctx.tenantId, created.taskId);

    await tasks.requestCancel(ctx, created.taskId);
    const cancelled = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancel_requested_at).not.toBeNull();

    const runsAfter = await listRuns(db.observerPool, ctx.tenantId, created.taskId);
    expect(runsAfter).toHaveLength(runsBefore.length);
    expect(runsAfter).toHaveLength(1);

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'retry_scheduled',
      'cancelled',
    ]);
    expect(cancelledEvents(events)).toBe(1);

    // Even when the old retry timer becomes due, cancellation must prevent a new Run.
    clock.set(cancelled.next_run_at);
    expect(await queue.claimNext('worker-due-after-cancel', clock.now())).toBeNull();
  });

  it('cancels waiting_approval directly and never resurrects the task', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'cancel-approval');
    await db.pool.query("UPDATE tasks SET status = 'waiting_approval' WHERE id = $1", [
      created.taskId,
    ]);

    await tasks.requestCancel(ctx, created.taskId);
    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('cancelled');

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events[events.length - 1]?.payload['fromStatus']).toBe('waiting_approval');
    expect(cancelledEvents(events)).toBe(1);
    expect(await queue.claimNext('worker-after-approval-cancel', clock.now())).toBeNull();
  });

  it('keeps a running task running after cancel, stops heartbeat and finalizes as cancelled', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'cancel-running');
    await syncClock();
    const leased = await queue.claimNext('worker-running-cancel', clock.now());
    expect(leased?.taskId).toBe(created.taskId);

    await tasks.requestCancel(ctx, created.taskId);
    const running = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(running.status).toBe('running');
    expect(running.cancel_requested_at).not.toBeNull();
    const firstCancelAt = running.cancel_requested_at?.toISOString();

    await tasks.requestCancel(ctx, created.taskId);
    const repeated = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(repeated.cancel_requested_at?.toISOString()).toBe(firstCancelAt);

    expect(await queue.heartbeat(leased as NonNullable<typeof leased>, clock.now())).toBe(false);
    expect(
      cancelledEvents(await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId)),
    ).toBe(0);

    // A late successful attempt must not override the committed cancellation intent.
    expect(await queue.finish(leased as NonNullable<typeof leased>, 'succeeded')).toBe(true);

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('cancelled');
    const run = await readRun(
      db.observerPool,
      ctx.tenantId,
      created.taskId,
      leased?.runId as string,
    );
    expect(run?.status).toBe('cancelled');

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'cancelled',
    ]);
    expect(cancelledEvents(events)).toBe(1);
    expect(events.some((event) => event.phase === 'completed')).toBe(false);
    expect(await listRuns(db.observerPool, ctx.tenantId, created.taskId)).toHaveLength(1);
  });

  it('lets the reaper converge cancelled running work as lease_expired with no retry', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'cancel-reaper');
    await syncClock();
    const leased = await queue.claimNext('worker-cancel-reaper', clock.now());
    expect(leased?.taskId).toBe(created.taskId);

    await tasks.requestCancel(ctx, created.taskId);
    clock.advance(CANCEL_OPTIONS.leaseDurationMs as number);
    const reaped = await queue.reapExpired(clock.now());
    expect(reaped).toBeGreaterThanOrEqual(1);

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('cancelled');

    const run = await readRun(
      db.observerPool,
      ctx.tenantId,
      created.taskId,
      leased?.runId as string,
    );
    expect(run?.status).toBe('lease_expired');

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'cancelled',
    ]);
    expect(events.some((event) => event.phase === 'retry_scheduled')).toBe(false);
    expect(await listRuns(db.observerPool, ctx.tenantId, created.taskId)).toHaveLength(1);
    expect(await queue.claimNext('worker-after-cancel-reap', clock.now())).toBeNull();
  });

  it('treats cancellation after a committed terminal outcome as a no-op', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'terminal-noop');
    await syncClock();
    const leased = await queue.claimNext('worker-terminal', clock.now());
    expect(await queue.finish(leased as NonNullable<typeof leased>, 'succeeded')).toBe(true);

    const before = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    const eventsBefore = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);

    await tasks.requestCancel(ctx, created.taskId);
    await tasks.requestCancel(ctx, created.taskId);

    const after = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    const eventsAfter = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(after).toEqual(before);
    expect(eventsAfter).toEqual(eventsBefore);
    expect(after.cancel_requested_at).toBeNull();
  });

  it('serializes cancel-versus-claim: either no run exists or the run carries cancel intent', async () => {
    for (let index = 0; index < 8; index += 1) {
      const created = await createQueuedTask(tasks, ctx, agent.agentId, `cancel-race-${index}`);
      await syncClock();

      const [claimResult] = await Promise.allSettled([
        queue.claimNext(`race-worker-${index}`, clock.now()),
        tasks.requestCancel(ctx, created.taskId),
      ]);
      expect(claimResult.status).toBe('fulfilled');
      const claimed = claimResult.status === 'fulfilled' ? claimResult.value : null;

      const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
      const runs = await listRuns(db.observerPool, ctx.tenantId, created.taskId);

      if (task.status === 'cancelled') {
        expect(runs).toHaveLength(0);
        expect(claimed).toBeNull();
      } else {
        expect(task.status).toBe('running');
        expect(task.cancel_requested_at).not.toBeNull();
        expect(runs).toHaveLength(1);
        expect(claimed?.taskId).toBe(created.taskId);
        expect(claimed?.runId).toBe(task.current_run_id);

        // The winning claim still cannot commit a success after cancellation intent.
        expect(await queue.finish(claimed as NonNullable<typeof claimed>, 'succeeded')).toBe(true);
        expect((await readTask(db.observerPool, ctx.tenantId, created.taskId)).status).toBe(
          'cancelled',
        );
      }

      expect(
        cancelledEvents(await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId)),
      ).toBe(1);
    }
  });

  it('serializes cancel-versus-due-retry without ever creating a post-cancel run', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'cancel-retry-race');
    await syncClock();
    const leased = await queue.claimNext('worker-retry-race', clock.now());
    expect(await queue.finish(leased as NonNullable<typeof leased>, 'failed_retryable')).toBe(true);

    const retryable = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(retryable.status).toBe('retryable_failed');
    await setTaskControls(db.pool, created.taskId, {
      nextRunAt: new Date(retryable.next_run_at.getTime()),
    });
    clock.set(retryable.next_run_at);

    const [claimSettled, cancelSettled] = await Promise.allSettled([
      queue.claimNext('worker-due-retry-race', clock.now()),
      tasks.requestCancel(ctx, created.taskId),
    ]);
    expect(claimSettled.status).toBe('fulfilled');
    expect(cancelSettled.status).toBe('fulfilled');

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    const runs = await listRuns(db.observerPool, ctx.tenantId, created.taskId);

    if (task.status === 'cancelled') {
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('failed_retryable');
    } else {
      expect(task.status).toBe('running');
      expect(task.cancel_requested_at).not.toBeNull();
      expect(runs).toHaveLength(2);
      expect(runs[1]?.status).toBe('running');
      expect(runs[1]?.id).toBe(task.current_run_id);
    }

    // Whatever won, a later cancellation must not produce another Run.
    const runsAfterCancel = await listRuns(db.observerPool, ctx.tenantId, created.taskId);
    expect(runsAfterCancel).toHaveLength(runs.length);
    if (task.status === 'running') {
      expect(
        await queue.heartbeat(
          {
            tenantId: ctx.tenantId,
            taskId: created.taskId,
            runId: runs[1]?.id as string,
            attempt: runs[1]?.attempt as number,
            leaseEpoch: Number(runs[1]?.lease_epoch),
            leaseExpiresAt: clock.now().toISOString(),
          },
          clock.now(),
        ),
      ).toBe(false);
    }
  });

  it('does not leak SQL or task input through cancellation errors', async () => {
    let caught: unknown;
    try {
      await tasks.requestCancel(
        { tenantId: ctx.tenantId, principalId: ctx.principalId, policyVersion: 1 },
        '00000000-0000-4000-8000-000000000000',
      );
    } catch (error) {
      caught = error;
    }

    expect(isDomainError(caught)).toBe(true);
    expect(JSON.stringify(caught)).toBe(
      JSON.stringify({
        code: 'NOT_FOUND',
        message: 'Resource not found',
        retryable: 'not_retryable',
      }),
    );
  });
});
