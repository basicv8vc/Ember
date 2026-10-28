import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidArgumentError, isDomainError, type AuthContext } from '@ember/domain';
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
  databaseNow,
  listEventSnapshots,
  listRuns,
  readRun,
  readTask,
  createQueuedTask,
  parkOtherOpenTasks,
} from './support/leases.js';

const CLAIM_OPTIONS: LeaseQueueConfigOverrides = {
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
let queueA: PostgresLeaseQueue;
let queueB: PostgresLeaseQueue;

async function syncClock(): Promise<void> {
  clock.set(await databaseNow(db.pool));
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 32 });
  agents = new PostgresAgentRepository(db.pool);
  tasks = new PostgresTaskRepository(db.pool);

  tenantA = await createTenantFixture(db.pool, 'claim tenant A');
  tenantB = await createTenantFixture(db.pool, 'claim tenant B');
  ctxA = { tenantId: tenantA.tenantId, principalId: tenantA.principalId, policyVersion: 1 };
  ctxB = { tenantId: tenantB.tenantId, principalId: tenantB.principalId, policyVersion: 1 };
  agentA = await agents.create(ctxA, { name: 'claim agent A' });
  agentB = await agents.create(ctxB, { name: 'claim agent B' });

  clock = new ManualClock(await databaseNow(db.pool));
  queueA = new PostgresLeaseQueue(db.pool, { ...CLAIM_OPTIONS, clock });
  // A genuinely separate `pg.Pool`/connection set, not a second object over the same pool.
  queueB = new PostgresLeaseQueue(db.observerPool, { ...CLAIM_OPTIONS, clock });
});

afterAll(async () => {
  await db?.close();
});

describe('B-T09 concurrent claim', () => {
  it('uses two independent database backends for the two lease queues', async () => {
    const [pidA, pidB] = await Promise.all([
      db.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
      db.observerPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
    ]);

    expect(pidA.rows[0]?.pid).toBeTypeOf('number');
    expect(pidB.rows[0]?.pid).toBeTypeOf('number');
    expect(pidA.rows[0]?.pid).not.toBe(pidB.rows[0]?.pid);
  });

  it('allows exactly one of two independent workers to claim a task', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'dual-claim');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    const [first, second] = await Promise.all([
      queueA.claimNext('worker-a', clock.now()),
      queueB.claimNext('worker-b', clock.now()),
    ]);

    const claimed = [first, second].filter((run) => run !== null);
    expect(claimed).toHaveLength(1);
    const leased = claimed[0];
    expect(leased?.taskId).toBe(created.taskId);
    expect(leased?.tenantId).toBe(ctxA.tenantId);
    expect(leased?.attempt).toBe(1);
    expect(leased?.leaseEpoch).toBe(1);

    const task = await readTask(db.observerPool, ctxA.tenantId, created.taskId);
    expect(task.status).toBe('running');
    expect(task.attempt_count).toBe(1);
    expect(task.lease_epoch).toBe('1');
    expect(task.current_run_id).toBe(leased?.runId);
    expect(task.lease_expires_at).not.toBeNull();
    expect(task.lease_expires_at?.toISOString()).toBe(leased?.leaseExpiresAt);

    const runs = await listRuns(db.observerPool, ctxA.tenantId, created.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('running');
    expect(runs[0]?.attempt).toBe(1);
    expect(runs[0]?.lease_epoch).toBe('1');
    expect(runs[0]?.worker_id).toBe(first === null ? 'worker-b' : 'worker-a');

    const events = await listEventSnapshots(db.observerPool, ctxA.tenantId, created.taskId);
    expect(events.map((event) => event.phase)).toEqual(['accepted', 'leased', 'started']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[1]?.payload['runId']).toBe(leased?.runId);
    expect(JSON.stringify(events)).not.toContain('prompt');
  });

  it('survives 24 concurrent claim attempts with exactly one valid run', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'stress-claim');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        queueA.claimNext(`stress-worker-${index}`, clock.now()),
      ),
    );

    const winners = results.filter((run) => run !== null);
    expect(winners).toHaveLength(1);

    const runs = await listRuns(db.observerPool, ctxA.tenantId, created.taskId);
    expect(runs).toHaveLength(1);
    expect(runs.filter((run) => run.status === 'running')).toHaveLength(1);

    const task = await readTask(db.observerPool, ctxA.tenantId, created.taskId);
    expect(task.attempt_count).toBe(1);
    expect(task.lease_epoch).toBe('1');
    expect(task.current_run_id).toBe(winners[0]?.runId);
  });

  it('claims different tasks and tenants concurrently without cross-tenant references', async () => {
    await db.pool.query(
      "UPDATE tasks SET next_run_at = now() + interval '1 day' WHERE status IN ('queued', 'retryable_failed')",
    );
    const tasksA = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createQueuedTask(tasks, ctxA, agentA.agentId, `parallel-a-${index}`),
      ),
    );
    const tasksB = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createQueuedTask(tasks, ctxB, agentB.agentId, `parallel-b-${index}`),
      ),
    );
    await syncClock();

    const results = await Promise.all([
      ...Array.from({ length: 16 }, (_, index) =>
        queueA.claimNext(`parallel-a-${index}`, clock.now()),
      ),
      ...Array.from({ length: 16 }, (_, index) =>
        queueB.claimNext(`parallel-b-${index}`, clock.now()),
      ),
    ]);

    const leased = results.filter((run) => run !== null);
    expect(leased).toHaveLength(16);

    const runIds = new Set(leased.map((run) => run.runId));
    const taskIds = new Set(leased.map((run) => run.taskId));
    expect(runIds.size).toBe(16);
    expect(taskIds.size).toBe(16);

    for (const run of leased) {
      const allowedTenant = run.tenantId === ctxA.tenantId || run.tenantId === ctxB.tenantId;
      expect(allowedTenant).toBe(true);
      const task = await readTask(db.observerPool, run.tenantId, run.taskId);
      expect(task.status).toBe('running');
      expect(task.current_run_id).toBe(run.runId);
      expect(task.lease_epoch).toBe(String(run.leaseEpoch));
      expect(
        tasksA.some((task) => task.taskId === run.taskId) ||
          tasksB.some((task) => task.taskId === run.taskId),
      ).toBe(true);
    }

    const runsA = await Promise.all(
      tasksA.map(async (task) => listRuns(db.observerPool, ctxA.tenantId, task.taskId)),
    );
    const runsB = await Promise.all(
      tasksB.map(async (task) => listRuns(db.observerPool, ctxB.tenantId, task.taskId)),
    );
    expect(runsA.flat().filter((run) => run.status === 'running')).toHaveLength(8);
    expect(runsB.flat().filter((run) => run.status === 'running')).toHaveLength(8);
  });

  it('rolls back the whole claim when event appends fail', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'event-rollback');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    await db.pool.query(`
      CREATE OR REPLACE FUNCTION p0b04_reject_leased_event()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.phase = 'leased' THEN
          RAISE EXCEPTION 'injected leased event failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER p0b04_reject_leased_event_trg
        BEFORE INSERT ON task_events
        FOR EACH ROW EXECUTE FUNCTION p0b04_reject_leased_event();
    `);

    let caught: unknown;
    try {
      await queueA.claimNext('worker-event-failure', clock.now());
    } catch (error) {
      caught = error;
    } finally {
      await db.pool.query(`
        DROP TRIGGER IF EXISTS p0b04_reject_leased_event_trg ON task_events;
        DROP FUNCTION IF EXISTS p0b04_reject_leased_event();
      `);
    }

    expect(isDomainError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('DB_UNAVAILABLE');
    expect(JSON.stringify(caught)).not.toContain('injected');

    const task = await readTask(db.observerPool, ctxA.tenantId, created.taskId);
    expect(task.status).toBe('queued');
    expect(task.attempt_count).toBe(0);
    expect(task.lease_epoch).toBe('0');
    expect(task.current_run_id).toBeNull();
    expect(await listRuns(db.observerPool, ctxA.tenantId, created.taskId)).toHaveLength(0);
    expect(
      (await listEventSnapshots(db.observerPool, ctxA.tenantId, created.taskId)).map(
        (event) => event.phase,
      ),
    ).toEqual(['accepted']);

    const retried = await queueA.claimNext('worker-event-retry', clock.now());
    expect(retried?.taskId).toBe(created.taskId);
  });

  it('rolls back the whole claim when COMMIT fails', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'commit-rollback');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    await db.pool.query(`
      CREATE OR REPLACE FUNCTION p0b04_reject_claim_commit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected claim commit failure';
      END;
      $$;
      CREATE CONSTRAINT TRIGGER p0b04_reject_claim_commit_trg
        AFTER INSERT ON runs
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION p0b04_reject_claim_commit();
    `);

    let caught: unknown;
    try {
      await queueA.claimNext('worker-commit-failure', clock.now());
    } catch (error) {
      caught = error;
    } finally {
      await db.pool.query(`
        DROP TRIGGER IF EXISTS p0b04_reject_claim_commit_trg ON runs;
        DROP FUNCTION IF EXISTS p0b04_reject_claim_commit();
      `);
    }

    expect(isDomainError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('DB_UNAVAILABLE');
    const task = await readTask(db.observerPool, ctxA.tenantId, created.taskId);
    expect(task.status).toBe('queued');
    expect(task.attempt_count).toBe(0);
    expect(task.lease_epoch).toBe('0');
    expect(task.current_run_id).toBeNull();
    expect(await listRuns(db.observerPool, ctxA.tenantId, created.taskId)).toHaveLength(0);

    const retried = await queueA.claimNext('worker-commit-retry', clock.now());
    expect(retried?.taskId).toBe(created.taskId);
  });

  it('enforces safe lease-epoch bounds in PostgreSQL', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'epoch-bounds');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    await expect(
      db.pool.query('UPDATE tasks SET lease_epoch = 9007199254740992 WHERE id = $1', [
        created.taskId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      db.pool.query(
        `INSERT INTO runs (id, tenant_id, task_id, attempt, lease_epoch, status)
         VALUES ($1, $2, $3, 1, 9007199254740992, 'created')`,
        [randomUUID(), ctxA.tenantId, created.taskId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const task = await readTask(db.observerPool, ctxA.tenantId, created.taskId);
    expect(task.lease_epoch).toBe('0');
    expect(await listRuns(db.observerPool, ctxA.tenantId, created.taskId)).toHaveLength(0);
  });

  it('rejects invalid worker ids and invalid clocks without changing state', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'invalid-input');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    for (const workerId of ['', ' leading', 'x'.repeat(129), 'worker id', 'worker\nid']) {
      await expect(queueA.claimNext(workerId, clock.now())).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
    }

    await expect(queueA.claimNext('worker-ok', new Date(Number.NaN))).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );

    const task = await readTask(db.observerPool, ctxA.tenantId, created.taskId);
    expect(task.status).toBe('queued');
    expect(task.attempt_count).toBe(0);
    expect(await listRuns(db.observerPool, ctxA.tenantId, created.taskId)).toHaveLength(0);
    await tasks.requestCancel(ctxA, created.taskId);
  });

  it('enforces at most one active run per task with a database index', async () => {
    const created = await createQueuedTask(tasks, ctxA, agentA.agentId, 'active-index');
    await syncClock();
    await parkOtherOpenTasks(db.pool, created.taskId);

    const claimed = await queueA.claimNext('worker-index', clock.now());
    expect(claimed).not.toBeNull();

    const index = await db.pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'runs_one_active_per_task_idx'",
    );
    expect(index.rows[0]?.indexdef).toContain(
      "WHERE (status = ANY (ARRAY['created'::text, 'running'::text]))",
    );

    await expect(
      db.pool.query(
        `INSERT INTO runs (id, tenant_id, task_id, attempt, status)
         VALUES ($1, $2, $3, 2, 'running')`,
        [randomUUID(), ctxA.tenantId, created.taskId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const run = await readRun(
      db.observerPool,
      ctxA.tenantId,
      created.taskId,
      claimed?.runId as string,
    );
    expect(run?.status).toBe('running');
  });
});
