import type { DurableObjectStorageLike, SqlStorageLike } from '../storage.js';
import { sqlExecAll, sqlExecMaybe } from './queries.js';

const R2_PENDING_DELETES_BATCH_LIMIT = 100;
export const R2_DELETE_RETRY_BASE_MS = 15_000;
export const R2_DELETE_RETRY_MAX_MS = 3_600_000;
export const R2_DELETE_MAX_BACKOFF_EXPONENT = 8;

/** Compute bounded exponential backoff (ms) for retrying failed R2 deletions. */
export function computeR2DeleteBackoffMs(nextAttemptCount: number): number {
  const exponent = Math.max(0, Math.min(nextAttemptCount - 1, R2_DELETE_MAX_BACKOFF_EXPONENT));
  return Math.min(R2_DELETE_RETRY_MAX_MS, R2_DELETE_RETRY_BASE_MS * 2 ** exponent);
}

function hasSqliteTableSync(sql: SqlStorageLike, tableName: string): boolean {
  return (
    sqlExecMaybe<{ readonly name: string }>(
      sql,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      tableName,
    ) !== null
  );
}

export function hasR2PendingDeletesTableSync(sql: SqlStorageLike): boolean {
  return hasSqliteTableSync(sql, 'v2_r2_pending_deletes');
}

/** Return `true` if `r2Key` currently has an outstanding entry in `v2_r2_pending_deletes`. */
export function isPendingR2DeleteKeySync(sql: SqlStorageLike, r2Key: string): boolean {
  if (!hasR2PendingDeletesTableSync(sql)) return false;
  return (
    sqlExecMaybe<{ readonly r2_key: string }>(
      sql,
      `SELECT r2_key FROM v2_r2_pending_deletes WHERE r2_key = ? LIMIT 1`,
      r2Key,
    ) !== null
  );
}

/** Return `true` if `(runId, artifactId)` has a retired-artifact tombstone for the active run. */
export function isRetiredRunArtifactSync(
  sql: SqlStorageLike,
  runId: string,
  artifactId: string,
): boolean {
  if (!hasSqliteTableSync(sql, 'v2_retired_run_artifacts')) return false;
  return (
    sqlExecMaybe<{ readonly artifact_id: string }>(
      sql,
      `SELECT artifact_id
         FROM v2_retired_run_artifacts
        WHERE run_id = ? AND artifact_id = ?
        LIMIT 1`,
      runId,
      artifactId,
    ) !== null
  );
}

/** Record run-scoped retired artifact tombstones inside the active SQLite transaction. */
export function recordRetiredRunArtifactsSync(
  sql: SqlStorageLike,
  taskId: string,
  runId: string,
  artifactIds: readonly string[],
  nowMs: number,
): void {
  if (artifactIds.length === 0 || !hasSqliteTableSync(sql, 'v2_retired_run_artifacts')) return;
  for (const artifactId of artifactIds) {
    sql.exec(
      `INSERT OR IGNORE INTO v2_retired_run_artifacts (
        task_id, run_id, artifact_id, retired_at_ms
      ) VALUES (?, ?, ?, ?)`,
      taskId,
      runId,
      artifactId,
      nowMs,
    );
  }
}

/** Remove run-scoped retired artifact tombstones once the task/lease is fenced or terminal. */
export function clearRetiredRunArtifactsForTaskSync(sql: SqlStorageLike, taskId: string): void {
  if (!hasSqliteTableSync(sql, 'v2_retired_run_artifacts')) return;
  sql.exec(`DELETE FROM v2_retired_run_artifacts WHERE task_id = ?`, taskId);
}

/** Return the earliest scheduled retry timestamp across `v2_r2_pending_deletes`, or `null` if empty. */
export function earliestPendingR2DeleteAtMsSync(sql: SqlStorageLike): number | null {
  if (!hasR2PendingDeletesTableSync(sql)) return null;
  const row = sqlExecMaybe<{ readonly m: number | null }>(
    sql,
    `SELECT MIN(next_attempt_at_ms) AS m FROM v2_r2_pending_deletes`,
  );
  return row?.m ?? null;
}

/**
 * Durably enqueue R2 keys for post-commit deletion inside the active SQLite transaction.
 * Because insertion occurs in the same transaction as `DELETE FROM v2_task_artifacts`, any
 * SQLite rollback automatically rolls back the pending delete markers as well.
 */
export function enqueuePendingR2DeletesSync(
  sql: SqlStorageLike,
  keys: readonly string[],
  nowMs: number,
): void {
  if (keys.length === 0 || !hasR2PendingDeletesTableSync(sql)) return;
  for (const key of keys) {
    sql.exec(
      `INSERT OR IGNORE INTO v2_r2_pending_deletes (
        r2_key, created_at_ms, next_attempt_at_ms, attempt_count
      ) VALUES (?, ?, ?, 0)`,
      key,
      nowMs,
      nowMs,
    );
  }
}

async function syncPostFlushAlarm(params: {
  readonly storage: Pick<DurableObjectStorageLike, 'transactionSync'>;
  readonly nowMs: number;
  readonly recomputeAlarmSync?: (nowMs: number) => number | null;
  readonly syncPlatformAlarm?: (
    targetAlarmAtMs: number | null,
    nowMs: number,
    options?: { readonly forceRearmConsumed?: boolean },
  ) => Promise<boolean | void>;
}): Promise<void> {
  const { storage, nowMs, recomputeAlarmSync, syncPlatformAlarm } = params;
  if (recomputeAlarmSync === undefined || syncPlatformAlarm === undefined) return;
  const nextAlarmAtMs = storage.transactionSync(() => recomputeAlarmSync(nowMs));
  await syncPlatformAlarm(nextAlarmAtMs, nowMs, { forceRearmConsumed: true });
}

/**
 * Flush due durably queued R2 deletions strictly outside SQLite transactions.
 * Failed deletes increment `attempt_count`, advance `next_attempt_at_ms` with bounded backoff,
 * and re-arm the DO platform alarm for autonomous retry.
 */
export async function flushPendingR2Deletes(params: {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly deleteR2Keys?: (keys: readonly string[]) => Promise<void>;
  readonly nowMs?: number;
  readonly recomputeAlarmSync?: (nowMs: number) => number | null;
  readonly syncPlatformAlarm?: (
    targetAlarmAtMs: number | null,
    nowMs: number,
    options?: { readonly forceRearmConsumed?: boolean },
  ) => Promise<boolean | void>;
  readonly skipAlarmSync?: boolean;
}): Promise<number> {
  const {
    storage,
    deleteR2Keys,
    nowMs = Date.now(),
    recomputeAlarmSync,
    syncPlatformAlarm,
    skipAlarmSync = false,
  } = params;
  if (!hasR2PendingDeletesTableSync(storage.sql)) {
    return 0;
  }

  const pending = sqlExecAll<{ readonly r2_key: string; readonly attempt_count: number }>(
    storage.sql,
    `SELECT r2_key, attempt_count
       FROM v2_r2_pending_deletes
      WHERE next_attempt_at_ms <= ?
      ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, r2_key ASC
      LIMIT ?`,
    nowMs,
    R2_PENDING_DELETES_BATCH_LIMIT,
  );
  if (pending.length === 0) return 0;

  const keys = pending.map((row) => row.r2_key);
  try {
    if (deleteR2Keys === undefined) {
      throw new Error('deleteR2Keys handler unavailable for pending R2 deletes');
    }
    await deleteR2Keys(keys);
  } catch {
    storage.transactionSync(() => {
      for (const row of pending) {
        const nextAttempt = row.attempt_count + 1;
        const nextAttemptAtMs = nowMs + computeR2DeleteBackoffMs(nextAttempt);
        storage.sql.exec(
          `UPDATE v2_r2_pending_deletes
              SET attempt_count = ?, next_attempt_at_ms = ?
            WHERE r2_key = ?`,
          nextAttempt,
          nextAttemptAtMs,
          row.r2_key,
        );
      }
    });
    if (!skipAlarmSync) {
      await syncPostFlushAlarm({ storage, nowMs, recomputeAlarmSync, syncPlatformAlarm });
    }
    return 0;
  }

  storage.transactionSync(() => {
    for (const key of keys) {
      storage.sql.exec(`DELETE FROM v2_r2_pending_deletes WHERE r2_key = ?`, key);
    }
  });
  if (!skipAlarmSync) {
    await syncPostFlushAlarm({ storage, nowMs, recomputeAlarmSync, syncPlatformAlarm });
  }
  return keys.length;
}
