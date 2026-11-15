import {
  DomainError,
  isTerminalTaskStatus,
  transitionTask,
  type Id,
  type TaskStatus,
} from '@ember/domain';
import type pg from 'pg';
import { appendTaskEvent } from './event-store.js';
import { toIsoTimestamp } from './support.js';
import { finalizeTaskTerminalEffects } from './task-terminal-effects.js';

interface TaskCancelRow {
  readonly id: string;
  readonly status: string;
  readonly updated_at: Date | string;
  readonly cancel_requested_at: Date | string | null;
}

/**
 * Authoritative post-transaction snapshot returned by Task cancellation.
 *
 * - `terminal: true` means the Task is already in a terminal state (`cancelled`, `completed`,
 *   or `failed`), so the HTTP API responds `200 OK`.
 * - `terminal: false` means the Task is `running` with `cancel_requested_at` durably recorded,
 *   so the HTTP API responds `202 Accepted` while the active Worker or Reaper converges it.
 */
export interface TaskCancelOutcome {
  readonly taskId: Id;
  readonly status: TaskStatus;
  readonly cancelRequested: boolean;
  readonly cancelRequestedAt: string | null;
  readonly terminal: boolean;
  readonly updatedAt: string;
}

const CANCEL_ROW_COLUMNS = `
  id, status, updated_at, cancel_requested_at
`;

const LOCK_TASK_FOR_CANCEL_SQL = `
SELECT ${CANCEL_ROW_COLUMNS}
  FROM tasks
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

const RECORD_RUNNING_CANCEL_SQL = `
UPDATE tasks
   SET cancel_requested_at = COALESCE(cancel_requested_at, $1),
       updated_at = CASE WHEN cancel_requested_at IS NULL THEN $1 ELSE updated_at END
 WHERE tenant_id = $2 AND id = $3 AND status = 'running'
RETURNING ${CANCEL_ROW_COLUMNS}
`;

const CANCEL_OPEN_TASK_SQL = `
UPDATE tasks
   SET status = $1,
       cancel_requested_at = COALESCE(cancel_requested_at, $2),
       lease_expires_at = NULL,
       updated_at = $3
 WHERE tenant_id = $4 AND id = $5
RETURNING ${CANCEL_ROW_COLUMNS}
`;

const EXPIRE_PENDING_APPROVALS_ON_CANCEL_SQL = `
UPDATE approvals
   SET status = 'expired',
       decided_at = $3,
       updated_at = $3
 WHERE tenant_id = $1 AND task_id = $2 AND status = 'pending'
`;

const SWEEP_RESERVED_BUDGET_ON_CANCEL_SQL = `
UPDATE budget_operations
   SET state = 'expired',
       consumed_steps = reserved_steps,
       consumed_units = reserved_units,
       consumed_elapsed_ms = reserved_elapsed_ms,
       consumed_slots = reserved_slots,
       settled_at = $3
 WHERE tenant_id = $1 AND task_id = $2 AND state = 'reserved'
`;

function toTaskCancelOutcome(row: TaskCancelRow): TaskCancelOutcome {
  const status = row.status as TaskStatus;
  const cancelRequestedAt =
    row.cancel_requested_at === null ? null : toIsoTimestamp(row.cancel_requested_at);

  return Object.freeze({
    taskId: row.id,
    status,
    cancelRequested: cancelRequestedAt !== null || status === 'cancelled',
    cancelRequestedAt,
    terminal: isTerminalTaskStatus(status),
    updatedAt: toIsoTimestamp(row.updated_at),
  });
}

/**
 * Apply the ADR-0001 cancellation policy inside an active PostgreSQL transaction.
 *
 * Returns `null` when `(tenantId, taskId)` is missing or belongs to another tenant. Keeps zero
 * `node:*` imports so both Node repositories and the Cloudflare API Worker can share it.
 */
export async function cancelTaskInTransaction(
  client: pg.PoolClient,
  tenantId: Id,
  taskId: Id,
): Promise<TaskCancelOutcome | null> {
  const locked = await client.query<TaskCancelRow>(LOCK_TASK_FOR_CANCEL_SQL, [tenantId, taskId]);
  const task = locked.rows[0];

  if (task === undefined) {
    return null;
  }

  const status = task.status as TaskStatus;

  if (isTerminalTaskStatus(status)) {
    return toTaskCancelOutcome(task);
  }

  const nowResult = await client.query<{ now: Date }>('SELECT now() AS now');
  const now = nowResult.rows[0]?.now;

  if (now === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'could not read the database clock');
  }

  if (status === 'running') {
    const runningResult = await client.query<TaskCancelRow>(RECORD_RUNNING_CANCEL_SQL, [
      now,
      tenantId,
      taskId,
    ]);
    const runningRow = runningResult.rows[0];

    if (runningRow === undefined) {
      throw new DomainError('DB_UNAVAILABLE', 'could not record cancellation intent');
    }

    return toTaskCancelOutcome(runningRow);
  }

  const nextStatus = transitionTask(status, 'cancelled');
  const updated = await client.query<TaskCancelRow>(CANCEL_OPEN_TASK_SQL, [
    nextStatus,
    now,
    now,
    tenantId,
    taskId,
  ]);
  const cancelledRow = updated.rows[0];

  if (updated.rowCount !== 1 || cancelledRow === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'could not apply cancellation to the task');
  }

  if (status === 'waiting_approval') {
    await client.query(EXPIRE_PENDING_APPROVALS_ON_CANCEL_SQL, [tenantId, taskId, now]);
    await client.query(SWEEP_RESERVED_BUDGET_ON_CANCEL_SQL, [tenantId, taskId, now]);
  }

  await appendTaskEvent(client, {
    tenantId,
    taskId,
    phase: 'cancelled',
    occurredAt: now,
    payload: {
      fromStatus: status,
      toStatus: nextStatus,
      cancelRequested: true,
    },
  });

  await finalizeTaskTerminalEffects(client, {
    tenantId,
    taskId,
    status: 'cancelled',
    occurredAt: now,
  });

  return toTaskCancelOutcome(cancelledRow);
}
