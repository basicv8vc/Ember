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
  clock.set(new Date((await databaseNow(db.pool)).getTime() + 5));
}

/**
 * Simulate the invariant violation ADR-0002 forbids: a `queued`/`retryable_failed` Task
 * that still has a live Run. The normal API cannot create this, so the test writes it
 * directly to prove the pre-claim convergence path fails closed.
 */
async function insertActiveRun(tenantId: string, taskId: string): Promise<string> {
  const runId = randomUUID();

  await db.pool.query(
    `INSERT INTO runs (
       id, tenant_id, task_id, attempt, lease_epoch, status, worker_id, leased_until,
       started_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, 1, 0, 'running', 'anomalous-worker', now() + interval '1 hour',
             now(), now(), now())`,
    [runId, tenantId, taskId],
  );

  return runId;
}

/**
 * Remove a Task created only for an invariant-violation test so its anomalous Run cannot
 * leak into later Reaper/Claim tests in the same schema.
 */
async function removeTestTask(tenantId: string, taskId: string): Promise<void> {
  await db.pool.query('DELETE FROM runs WHERE tenant_id = $1 AND task_id = $2', [tenantId, taskId]);
  await db.pool.query('DELETE FROM task_events WHERE tenant_id = $1 AND task_id = $2', [
    tenantId,
    taskId,
  ]);
  await db.pool.query('DELETE FROM tasks WHERE tenant_id = $1 AND id = $2', [tenantId, taskId]);
}

/**
 * Inject a failure on the second `leased` event (the retry claim) after the intermediate
 * `retryable_failed → queued` promotion has already been written. This proves that the
 * promotion, its event and the new Run share one transaction.
 */
async function installSecondLeaseEventFailureTrigger(): Promise<void> {
  await db.pool.query(`
    CREATE OR REPLACE FUNCTION p0b04_reject_second_lease()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.phase = 'leased' AND (NEW.payload->>'attempt')::int >= 2 THEN
        RAISE EXCEPTION 'injected second lease failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER p0b04_reject_second_lease_trg
      BEFORE INSERT ON task_events
      FOR EACH ROW EXECUTE FUNCTION p0b04_reject_second_lease();
  `);
}

async function removeSecondLeaseEventFailureTrigger(): Promise<void> {
  await db.pool.query(`
    DROP TRIGGER IF EXISTS p0b04_reject_second_lease_trg ON task_events;
    DROP FUNCTION IF EXISTS p0b04_reject_second_lease();
  `);
}

/**
 * Record every real `tasks.status` change in this test schema.
 *
 * A durable event alone cannot prove that the intermediate `queued` state was written to
 * PostgreSQL, so this audit table observes the actual row updates.
 */
async function installTaskStatusAudit(): Promise<void> {
  await db.pool.query(`
    CREATE TABLE p0b04_task_status_audit (
      id bigserial PRIMARY KEY,
      task_id uuid NOT NULL,
      from_status text NOT NULL,
      to_status text NOT NULL,
      changed_at timestamptz NOT NULL
    );
    CREATE OR REPLACE FUNCTION p0b04_audit_task_status()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO p0b04_task_status_audit (task_id, from_status, to_status, changed_at)
        VALUES (NEW.id, OLD.status, NEW.status, now());
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER p0b04_audit_task_status_trg
      AFTER UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION p0b04_audit_task_status();
  `);
}

async function readTaskStatusAudit(
  taskId: string,
): Promise<readonly { from_status: string; to_status: string }[]> {
  const result = await db.observerPool.query<{ from_status: string; to_status: string }>(
    `SELECT from_status, to_status
       FROM p0b04_task_status_audit
      WHERE task_id = $1
      ORDER BY id ASC`,
    [taskId],
  );

  return result.rows;
}

async function removeTaskStatusAudit(): Promise<void> {
  await db.pool.query(`
    DROP TRIGGER IF EXISTS p0b04_audit_task_status_trg ON tasks;
    DROP FUNCTION IF EXISTS p0b04_audit_task_status();
    DROP TABLE IF EXISTS p0b04_task_status_audit;
  `);
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

    // P1-1: the durable event trail must show both approved edges, not a direct
    // retryable_failed -> running transition.
    const eventsAfterRetry = await listEventSnapshots(
      db.observerPool,
      ctx.tenantId,
      created.taskId,
    );
    expect(eventsAfterRetry.map((event) => event.phase)).toEqual([
      'accepted',
      'leased',
      'started',
      'retry_scheduled',
      'retry_scheduled',
      'leased',
      'started',
    ]);
    expect(eventsAfterRetry[3]?.payload['fromStatus']).toBe('running');
    expect(eventsAfterRetry[3]?.payload['toStatus']).toBe('retryable_failed');
    expect(eventsAfterRetry[4]?.payload['fromStatus']).toBe('retryable_failed');
    expect(eventsAfterRetry[4]?.payload['toStatus']).toBe('queued');
    expect(eventsAfterRetry[5]?.payload['fromStatus']).toBe('queued');
    expect(eventsAfterRetry[5]?.payload['toStatus']).toBe('running');
    expect(eventsAfterRetry[5]?.payload['runId']).toBe(retried?.runId);
    expect(eventsAfterRetry[5]?.payload['attempt']).toBe(2);
    expect(eventsAfterRetry[6]?.payload['runStatus']).toBe('running');
  });

  it('rolls back the retry promotion and its event when the retry claim fails', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'retry-atomic');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);
    const first = await queue.claimNext('worker-retry-atomic', clock.now());
    expect(first).not.toBeNull();

    clock.advance(RECOVERY_OPTIONS.leaseDurationMs as number);
    await queue.reapExpired(clock.now());

    const afterReap = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(afterReap.status).toBe('retryable_failed');
    clock.set(afterReap.next_run_at);
    await parkOtherOpenTasks(db.pool, created.taskId);

    const taskBefore = afterReap;
    const runsBefore = await listRuns(db.observerPool, ctx.tenantId, created.taskId);
    const eventsBefore = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);

    await installSecondLeaseEventFailureTrigger();

    let caught: unknown;
    try {
      await queue.claimNext('worker-retry-atomic-2', clock.now());
    } catch (error) {
      caught = error;
    } finally {
      await removeSecondLeaseEventFailureTrigger();
    }

    expect(isDomainError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('DB_UNAVAILABLE');

    // The in-transaction promotion and its event must be gone with the failed claim.
    const taskAfter = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(taskAfter).toEqual(taskBefore);
    expect(taskAfter.status).toBe('retryable_failed');
    expect(taskAfter.attempt_count).toBe(1);
    expect(taskAfter.lease_epoch).toBe('1');
    expect(taskAfter.current_run_id).toBe(first?.runId);
    expect(await listRuns(db.observerPool, ctx.tenantId, created.taskId)).toEqual(runsBefore);
    expect(await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId)).toEqual(
      eventsBefore,
    );

    const promotions = eventsBefore.filter(
      (event) => event.phase === 'retry_scheduled' && event.payload['toStatus'] === 'queued',
    );
    expect(promotions).toHaveLength(0);
  });

  it('persists retryable_failed -> queued -> running as real database transitions', async () => {
    await installTaskStatusAudit();

    try {
      const created = await createQueuedTask(tasks, ctx, agent.agentId, 'retry-persistence');
      await syncClock();
      await parkOtherOpenTasks(db.pool, created.taskId);

      const first = await queue.claimNext('worker-persist-1', clock.now());
      expect(first).not.toBeNull();

      clock.advance(RECOVERY_OPTIONS.leaseDurationMs as number);
      await queue.reapExpired(clock.now());

      const afterReap = await readTask(db.observerPool, ctx.tenantId, created.taskId);
      expect(afterReap.status).toBe('retryable_failed');

      clock.set(afterReap.next_run_at);
      await parkOtherOpenTasks(db.pool, created.taskId);

      const second = await queue.claimNext('worker-persist-2', clock.now());
      expect(second?.attempt).toBe(2);

      // Every edge must exist as a real `tasks` row update, including the intermediate
      // `retryable_failed -> queued` promotion that is invisible after COMMIT.
      expect(await readTaskStatusAudit(created.taskId)).toEqual([
        { from_status: 'queued', to_status: 'running' },
        { from_status: 'running', to_status: 'retryable_failed' },
        { from_status: 'retryable_failed', to_status: 'queued' },
        { from_status: 'queued', to_status: 'running' },
      ]);
    } finally {
      await removeTaskStatusAudit();
    }
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

  it('converges a queued task with an exhausted execution budget (ADR-0002)', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'preclaim-budget');
    await syncClock();
    await db.pool.query('UPDATE tasks SET attempt_count = max_attempts WHERE id = $1', [
      created.taskId,
    ]);
    await parkOtherOpenTasks(db.pool, created.taskId);

    const claimed = await queue.claimNext('worker-budget-exhausted', clock.now());
    expect(claimed).toBeNull();

    const task = await readTask(db.observerPool, ctx.tenantId, created.taskId);
    expect(task.status).toBe('failed');
    expect(task.attempt_count).toBe(task.max_attempts);
    expect(task.lease_epoch).toBe('0');
    expect(task.current_run_id).toBeNull();
    expect(await listRuns(db.observerPool, ctx.tenantId, created.taskId)).toHaveLength(0);

    const events = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual(['accepted', 'failed']);
    expect(events[1]?.payload['fromStatus']).toBe('queued');
    expect(events[1]?.payload['toStatus']).toBe('failed');
    expect(events[1]?.payload['errorCode']).toBeUndefined();
  });

  it('refuses pre-claim convergence when the task still has an active run (claim)', async () => {
    const created = await createQueuedTask(tasks, ctx, agent.agentId, 'preclaim-active-run-claim');

    try {
      await syncClock();
      const runId = await insertActiveRun(ctx.tenantId, created.taskId);
      await setTaskControls(db.pool, created.taskId, {
        deadlineAt: new Date(clock.now().getTime() - 1_000),
      });
      await parkOtherOpenTasks(db.pool, created.taskId);

      const taskBefore = await readTask(db.observerPool, ctx.tenantId, created.taskId);
      const runsBefore = await listRuns(db.observerPool, ctx.tenantId, created.taskId);
      const eventsBefore = await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId);

      let caught: unknown;
      try {
        await queue.claimNext('worker-preclaim-active', clock.now());
      } catch (error) {
        caught = error;
      }

      expect(isDomainError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('DB_UNAVAILABLE');

      // ADR-0002: an active Run blocks the edge and the transaction leaves no trace.
      expect(await readTask(db.observerPool, ctx.tenantId, created.taskId)).toEqual(taskBefore);
      expect(await listRuns(db.observerPool, ctx.tenantId, created.taskId)).toEqual(runsBefore);
      expect(await listEventSnapshots(db.observerPool, ctx.tenantId, created.taskId)).toEqual(
        eventsBefore,
      );

      expect(taskBefore.status).toBe('queued');
      expect(taskBefore.attempt_count).toBe(0);
      expect(taskBefore.lease_epoch).toBe('0');
      expect(runsBefore).toHaveLength(1);
      expect(runsBefore[0]?.id).toBe(runId);
      expect(runsBefore[0]?.status).toBe('running');
      expect(eventsBefore.map((event) => event.phase)).toEqual(['accepted']);
    } finally {
      await removeTestTask(ctx.tenantId, created.taskId);
    }
  });

  it('refuses reaper convergence when an expired task still has an active run', async () => {
    const valid = await createQueuedTask(tasks, ctx, agent.agentId, 'reaper-open-deadline');
    const anomalous = await createQueuedTask(tasks, ctx, agent.agentId, 'reaper-active-run');

    try {
      await syncClock();

      // A legally expired Task is converged first so the assertion proves the whole
      // transaction (task update + failed event) rolls back when the anomaly is detected.
      const runId = await insertActiveRun(ctx.tenantId, anomalous.taskId);

      await setTaskControls(db.pool, valid.taskId, {
        deadlineAt: new Date(clock.now().getTime() - 5_000),
      });
      await setTaskControls(db.pool, anomalous.taskId, {
        deadlineAt: new Date(clock.now().getTime() - 3_000),
      });

      const validBefore = await readTask(db.observerPool, ctx.tenantId, valid.taskId);
      const validEventsBefore = await listEventSnapshots(
        db.observerPool,
        ctx.tenantId,
        valid.taskId,
      );
      const anomalousBefore = await readTask(db.observerPool, ctx.tenantId, anomalous.taskId);
      const anomalousRunsBefore = await listRuns(db.observerPool, ctx.tenantId, anomalous.taskId);
      const anomalousEventsBefore = await listEventSnapshots(
        db.observerPool,
        ctx.tenantId,
        anomalous.taskId,
      );

      let caught: unknown;
      try {
        await queue.reapExpired(clock.now());
      } catch (error) {
        caught = error;
      }

      expect(isDomainError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('DB_UNAVAILABLE');

      expect(await readTask(db.observerPool, ctx.tenantId, valid.taskId)).toEqual(validBefore);
      expect(await listEventSnapshots(db.observerPool, ctx.tenantId, valid.taskId)).toEqual(
        validEventsBefore,
      );
      expect(validBefore.status).toBe('queued');

      expect(await readTask(db.observerPool, ctx.tenantId, anomalous.taskId)).toEqual(
        anomalousBefore,
      );
      expect(await listRuns(db.observerPool, ctx.tenantId, anomalous.taskId)).toEqual(
        anomalousRunsBefore,
      );
      expect(await listEventSnapshots(db.observerPool, ctx.tenantId, anomalous.taskId)).toEqual(
        anomalousEventsBefore,
      );

      expect(anomalousBefore.status).toBe('queued');
      expect(anomalousRunsBefore).toHaveLength(1);
      expect(anomalousRunsBefore[0]?.id).toBe(runId);
      expect(anomalousRunsBefore[0]?.status).toBe('running');
      expect(anomalousEventsBefore.map((event) => event.phase)).toEqual(['accepted']);
    } finally {
      await removeTestTask(ctx.tenantId, valid.taskId);
      await removeTestTask(ctx.tenantId, anomalous.taskId);
    }
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
