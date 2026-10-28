import { randomUUID } from 'node:crypto';
import type { AuthContext, LeasedRun } from '@ember/domain';
import type { PostgresTaskRepository } from '@ember/postgres';
import type { Clock } from '@ember/postgres';
import type { TestPool } from './database.js';
import { chatCommand, type TenantFixture } from './fixtures.js';

/** Deterministic clock for lease tests. All times are enforced to move forward. */
export class ManualClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(value: Date): void {
    this.current = new Date(value.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export async function databaseNow(pool: TestPool): Promise<Date> {
  const result = await pool.query<{ now: Date }>('SELECT now() AS now');
  const now = result.rows[0]?.now;

  if (now === undefined) {
    throw new Error('database did not return now()');
  }

  return now;
}

export async function clockAfter<T>(
  pool: TestPool,
  prepare: () => Promise<T>,
): Promise<{
  readonly clock: ManualClock;
  readonly value: T;
}> {
  const value = await prepare();
  const clock = new ManualClock(await databaseNow(pool));
  return { clock, value };
}

export function contextOf(tenant: TenantFixture): AuthContext {
  return {
    tenantId: tenant.tenantId,
    principalId: tenant.principalId,
    policyVersion: 1,
  };
}

export interface CreatedTask {
  readonly taskId: string;
  readonly agentId: string;
  readonly tenantId: string;
}

export async function createQueuedTask(
  tasks: PostgresTaskRepository,
  ctx: AuthContext,
  agentId: string,
  label = 'lease',
): Promise<CreatedTask> {
  const receipt = await tasks.create(ctx, chatCommand(agentId, `${label}-${randomUUID()}`));
  return { taskId: receipt.taskId, agentId, tenantId: ctx.tenantId };
}

export interface TaskRowSnapshot {
  status: string;
  attempt_count: number;
  max_attempts: number;
  lease_epoch: string;
  current_run_id: string | null;
  lease_expires_at: Date | null;
  next_run_at: Date;
  deadline_at: Date | null;
  cancel_requested_at: Date | null;
  updated_at: Date;
}

export async function readTask(
  pool: TestPool,
  tenantId: string,
  taskId: string,
): Promise<TaskRowSnapshot> {
  const result = await pool.query<TaskRowSnapshot>(
    `SELECT status, attempt_count, max_attempts, lease_epoch::text AS lease_epoch,
            current_run_id, lease_expires_at, next_run_at, deadline_at,
            cancel_requested_at, updated_at
       FROM tasks
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, taskId],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error('expected task row');
  }

  return row;
}

export interface RunRowSnapshot {
  id: string;
  task_id: string;
  attempt: number;
  lease_epoch: string;
  status: string;
  worker_id: string | null;
  leased_until: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export async function readRun(
  pool: TestPool,
  tenantId: string,
  taskId: string,
  runId: string,
): Promise<RunRowSnapshot | null> {
  const result = await pool.query<RunRowSnapshot>(
    `SELECT id, task_id, attempt, lease_epoch::text AS lease_epoch, status, worker_id,
            leased_until, started_at, finished_at
       FROM runs
      WHERE tenant_id = $1 AND task_id = $2 AND id = $3`,
    [tenantId, taskId, runId],
  );

  return result.rows[0] ?? null;
}

export async function listRuns(
  pool: TestPool,
  tenantId: string,
  taskId: string,
): Promise<readonly RunRowSnapshot[]> {
  const result = await pool.query<RunRowSnapshot>(
    `SELECT id, task_id, attempt, lease_epoch::text AS lease_epoch, status, worker_id,
            leased_until, started_at, finished_at
       FROM runs
      WHERE tenant_id = $1 AND task_id = $2
      ORDER BY attempt ASC`,
    [tenantId, taskId],
  );

  return result.rows;
}

export interface EventSnapshot {
  sequence: number;
  phase: string;
  payload: Record<string, unknown>;
}

export async function listEventSnapshots(
  pool: TestPool,
  tenantId: string,
  taskId: string,
): Promise<readonly EventSnapshot[]> {
  const result = await pool.query<EventSnapshot>(
    `SELECT sequence, phase, payload
       FROM task_events
      WHERE tenant_id = $1 AND task_id = $2
      ORDER BY sequence ASC`,
    [tenantId, taskId],
  );

  return result.rows;
}

export async function countEventsByPhase(
  pool: TestPool,
  tenantId: string,
  taskId: string,
): Promise<Record<string, number>> {
  const events = await listEventSnapshots(pool, tenantId, taskId);
  return events.reduce<Record<string, number>>((counts, event) => {
    counts[event.phase] = (counts[event.phase] ?? 0) + 1;
    return counts;
  }, {});
}

export async function setTaskControls(
  pool: TestPool,
  taskId: string,
  controls: {
    readonly maxAttempts?: number;
    readonly deadlineAt?: Date | null;
    readonly nextRunAt?: Date;
  },
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (controls.maxAttempts !== undefined) {
    values.push(controls.maxAttempts);
    assignments.push(`max_attempts = $${values.length}`);
  }
  if (controls.deadlineAt !== undefined) {
    values.push(controls.deadlineAt);
    assignments.push(`deadline_at = $${values.length}`);
  }
  if (controls.nextRunAt !== undefined) {
    values.push(controls.nextRunAt);
    assignments.push(`next_run_at = $${values.length}`);
  }

  if (assignments.length === 0) {
    return;
  }

  values.push(taskId);
  await pool.query(
    `UPDATE tasks SET ${assignments.join(', ')} WHERE id = $${values.length}`,
    values,
  );
}

export function leaseOf(taskId: string, tenantId: string, run: LeasedRun): LeasedRun {
  return Object.freeze({ ...run, taskId, tenantId });
}

/**
 * Test-only isolation: keep the global queue from claiming another test's still-open Task.
 * The production queue intentionally has no per-test filtering.
 */
export async function parkOtherOpenTasks(pool: TestPool, keepTaskId: string): Promise<void> {
  await pool.query(
    `UPDATE tasks
        SET next_run_at = now() + interval '1 day'
      WHERE id <> $1 AND status IN ('queued', 'retryable_failed')`,
    [keepTaskId],
  );
}
