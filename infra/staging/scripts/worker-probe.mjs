/**
 * Worker container health probe.
 *
 * The Worker exposes no socket, and adding one would mean changing the runtime in a PR that
 * owns infrastructure only. Instead the probe asks the two questions that matter for this
 * process and that can be answered from outside it:
 *
 *   1. Can the Worker still reach PostgreSQL? A dead pool means every claim and heartbeat
 *      fails, so the process is unhealthy even while the event loop looks alive.
 *   2. Is a claimable backlog being left behind? A Task that has been due for longer than
 *      the grace window and holds no lease means the poll loop is not making progress
 *      (crashed loop, lost privileges, wrong worker id).
 *
 * It deliberately imports `@ember/postgres` rather than speaking to `pg` directly, so the
 * probe validates DATABASE_URL through the same loader and pool options the Worker uses.
 *
 * Exit codes: 0 healthy, 1 unhealthy.
 */

const GRACE_SECONDS = Number(process.env.EMBER_WORKER_HEALTH_GRACE_SECONDS || 300);
const PROBE_TIMEOUT_MS = Number(process.env.EMBER_WORKER_HEALTH_TIMEOUT_MS || 8000);

function report(status, detail) {
  process.stdout.write(`${JSON.stringify({ status, ...detail })}\n`);
  process.exit(status === 'healthy' ? 0 : 1);
}

async function main() {
  let pool;

  try {
    const { createPool, loadDatabaseConfig } = await import('@ember/postgres');
    pool = createPool(loadDatabaseConfig());
  } catch (error) {
    // Category only: a configuration error message can quote the connection string.
    report('unhealthy', { reason: 'configuration_error', category: error?.name ?? 'unknown' });
    return;
  }

  const timer = setTimeout(() => {
    report('unhealthy', { reason: 'probe_timeout', timeout_ms: PROBE_TIMEOUT_MS });
  }, PROBE_TIMEOUT_MS);
  timer.unref();

  try {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int
            FROM tasks
           WHERE status IN ('queued', 'retryable_failed')
             AND next_run_at < now() - ($1::text || ' seconds')::interval
             AND lease_expires_at IS NULL) AS stalled_tasks,
         (SELECT count(*)::int
            FROM tasks
           WHERE lease_expires_at IS NOT NULL
             AND lease_expires_at < now()) AS expired_leases,
         (SELECT count(*)::int FROM schema_migrations) AS migrations`,
      [String(GRACE_SECONDS)],
    );

    const row = result.rows[0] ?? {};
    const stalled = Number(row.stalled_tasks ?? 0);
    const expired = Number(row.expired_leases ?? 0);
    const migrations = Number(row.migrations ?? 0);

    clearTimeout(timer);

    if (migrations === 0) {
      report('unhealthy', { reason: 'schema_not_migrated', migrations });
      return;
    }
    if (stalled > 0) {
      report('unhealthy', {
        reason: 'claimable_backlog_overdue',
        stalled_tasks: stalled,
        grace_s: GRACE_SECONDS,
      });
      return;
    }

    report('healthy', {
      stalled_tasks: stalled,
      expired_leases: expired,
      migrations,
    });
    return;
  } catch (error) {
    clearTimeout(timer);
    // The driver error text can carry the connection string; only the class is reported.
    report('unhealthy', { reason: 'database_unreachable', category: error?.name ?? 'unknown' });
    return;
  } finally {
    clearTimeout(timer);
    await pool?.end().catch(() => undefined);
  }
}

await main();
