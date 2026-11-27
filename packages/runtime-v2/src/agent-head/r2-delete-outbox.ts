import type { DurableObjectStorageLike, SqlStorageLike } from '../storage.js';
import { sqlExecAll, sqlExecMaybe } from './queries.js';

const R2_PENDING_DELETES_BATCH_LIMIT = 100;

export function hasR2PendingDeletesTableSync(sql: SqlStorageLike): boolean {
  return (
    sqlExecMaybe<{ readonly name: string }>(
      sql,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v2_r2_pending_deletes'`,
    ) !== null
  );
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
      `INSERT OR IGNORE INTO v2_r2_pending_deletes (r2_key, created_at_ms) VALUES (?, ?)`,
      key,
      nowMs,
    );
  }
}

/**
 * Flush durably queued R2 deletions strictly outside SQLite transactions.
 * Keys remain persisted in `v2_r2_pending_deletes` if `deleteR2Keys` fails so later cycles retry.
 */
export async function flushPendingR2Deletes(params: {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly deleteR2Keys?: (keys: readonly string[]) => Promise<void>;
}): Promise<number> {
  const { storage, deleteR2Keys } = params;
  if (deleteR2Keys === undefined || !hasR2PendingDeletesTableSync(storage.sql)) {
    return 0;
  }

  const pending = sqlExecAll<{ readonly r2_key: string }>(
    storage.sql,
    `SELECT r2_key
       FROM v2_r2_pending_deletes
      ORDER BY created_at_ms ASC, r2_key ASC
      LIMIT ?`,
    R2_PENDING_DELETES_BATCH_LIMIT,
  );
  if (pending.length === 0) return 0;

  const keys = pending.map((row) => row.r2_key);
  try {
    await deleteR2Keys(keys);
  } catch {
    // Retain rows in v2_r2_pending_deletes for durable retry on the next flush/alarm cycle.
    return 0;
  }

  storage.transactionSync(() => {
    for (const key of keys) {
      storage.sql.exec(`DELETE FROM v2_r2_pending_deletes WHERE r2_key = ?`, key);
    }
  });
  return keys.length;
}
