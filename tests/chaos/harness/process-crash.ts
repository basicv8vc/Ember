import type { LeasedRun } from '@ember/domain';
import type { PostgresLeaseQueue } from '@ember/postgres';
import type { TestPool } from '../../integration/support/database.js';
import { databaseNow } from '../../integration/support/leases.js';

/**
 * Controlled crash and fault injection primitives for simulating worker process crashes,
 * backend connection terminations, and lease expirations.
 */

/**
 * Abruptly terminate the PostgreSQL backend servicing a client.
 * Scoped safely to current_database() and never terminates the current backend.
 */
export async function terminateBackendPid(adminPool: TestPool, pid: number): Promise<boolean> {
  const result = await adminPool.query<{ terminated: boolean }>(
    `SELECT pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid = $1
        AND pid <> pg_backend_pid()`,
    [pid],
  );
  return result.rows[0]?.terminated ?? false;
}

/**
 * Simulate an abrupt worker crash for a leased run:
 * 1. Forcefully rewinds `leased_until` on the run row and `created_at`/`lease_expires_at` on the task row
 *    to the past, satisfying the check constraint `lease_expires_at >= created_at` while ensuring
 *    the lease has expired without a graceful release.
 * 2. Runs the lease queue's reaper to converge the expired run into `retryable_failed`.
 */
export async function simulateWorkerCrash(
  pool: TestPool,
  queue: PostgresLeaseQueue,
  tenantId: string,
  lease: LeasedRun,
): Promise<void> {
  // Rewind run lease timestamp to the past
  await pool.query(
    `UPDATE runs
        SET leased_until = clock_timestamp() - interval '10 seconds'
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, lease.runId],
  );

  // Rewind task creation and lease expiration timestamps to satisfy tasks_check (lease_expires_at >= created_at)
  await pool.query(
    `UPDATE tasks
        SET created_at = clock_timestamp() - interval '1 hour',
            lease_expires_at = clock_timestamp() - interval '50 minutes'
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, lease.taskId],
  );

  // Invoke reaper to transition the expired run and reschedule task
  const now = await databaseNow(pool);
  await queue.reapExpired(now);
}
