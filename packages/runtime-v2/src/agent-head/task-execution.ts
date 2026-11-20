import type { SqlStorageLike } from '../storage.js';
import type { RunRow, TaskRow } from './schema.js';

export function startTaskRunSync(
  sql: SqlStorageLike,
  task: TaskRow,
  options: {
    runId: string;
    workerId: string;
    executorKind: 'queue_worker' | 'device';
    nowMs: number;
    leaseMs: number;
  },
) {
  const { runId, workerId, executorKind, nowMs, leaseMs } = options;
  const nextEpoch = task.lease_epoch + 1;
  const nextAttempt = task.attempt_count + 1;
  const leaseExpiresAtMs = Math.min(nowMs + leaseMs, task.deadline_at_ms ?? Infinity);
  sql.exec(
    `INSERT INTO runs (
      id, task_id, attempt, lease_epoch, status, worker_id, executor_kind,
      leased_until_ms, provider_job_handle, started_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
    runId,
    task.id,
    nextAttempt,
    nextEpoch,
    workerId,
    executorKind,
    leaseExpiresAtMs,
    task.provider_job_handle,
    nowMs,
    nowMs,
  );
  sql.exec(
    `UPDATE tasks
        SET status = 'running', attempt_count = ?, current_run_id = ?,
            lease_epoch = ?, lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE id = ?`,
    nextAttempt,
    runId,
    nextEpoch,
    leaseExpiresAtMs,
    nowMs,
    task.id,
  );
  return { nextEpoch, nextAttempt, leaseExpiresAtMs };
}

export function hasLiveTaskLease(
  task: TaskRow,
  run: RunRow,
  nowMs: number,
  fence: { leaseEpoch: number; workerId: string; executorKind: 'queue_worker' | 'device' },
): boolean {
  return (
    task.status === 'running' &&
    run.status === 'running' &&
    task.current_run_id === run.id &&
    task.lease_epoch === fence.leaseEpoch &&
    run.lease_epoch === fence.leaseEpoch &&
    run.worker_id === fence.workerId &&
    run.executor_kind === fence.executorKind &&
    task.lease_expires_at_ms !== null &&
    nowMs < task.lease_expires_at_ms &&
    nowMs < run.leased_until_ms &&
    (task.deadline_at_ms === null || nowMs < task.deadline_at_ms) &&
    task.cancel_requested_at_ms === null
  );
}

export function finishTaskRunSync(
  sql: SqlStorageLike,
  task: TaskRow,
  run: RunRow,
  nowMs: number,
  result: {
    status: 'completed' | 'failed';
    summaryText: string | null;
    detailText: string | null;
    modelLabel: string;
    simulated: boolean;
    truncated: boolean;
    reasonCode: string;
  },
): void {
  sql.exec(
    `UPDATE runs SET status = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
    result.status === 'completed' ? 'succeeded' : 'failed_terminal',
    nowMs,
    nowMs,
    run.id,
  );
  sql.exec(
    `INSERT INTO task_results (
      task_id, summary_text, detail_text, model_label, simulated, truncated, reason_code, produced_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (task_id) DO NOTHING`,
    task.id,
    result.summaryText,
    result.detailText,
    result.modelLabel,
    result.simulated ? 1 : 0,
    result.truncated ? 1 : 0,
    result.reasonCode,
    nowMs,
  );
  sql.exec(
    `UPDATE tasks SET status = ?, lease_expires_at_ms = NULL, updated_at_ms = ? WHERE id = ?`,
    result.status,
    nowMs,
    task.id,
  );
}

export function appendTaskEventSync(
  sql: SqlStorageLike,
  event: {
    id: string;
    taskId: string;
    phase: 'accepted' | 'leased' | 'completed' | 'failed' | 'cancelled' | 'retry_scheduled';
    traceId: string;
    nowMs: number;
    payload: Record<string, unknown>;
  },
): void {
  sql.exec(
    `INSERT INTO task_events (id, task_id, sequence, phase, payload_json, trace_id, occurred_at_ms)
     SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ? FROM task_events WHERE task_id = ?`,
    event.id,
    event.taskId,
    event.phase,
    JSON.stringify(event.payload),
    event.traceId,
    event.nowMs,
    event.taskId,
  );
}
