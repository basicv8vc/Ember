import type { TestPool } from './database.js';

/**
 * Exact synchronization on one PostgreSQL advisory lock (P0B-06-T1).
 *
 * Integration test files share a single database and isolate themselves by schema, but
 * advisory locks are database-wide. `runMigrations` serializes every runner on one advisory
 * key, and every test file migrates its throwaway schema, so "some session in this database
 * is waiting for some advisory lock" is routinely true while the two transactions under test
 * are not ordered at all. Counting those waiters cannot establish an acquisition order.
 *
 * These helpers instead identify a lock the way PostgreSQL records it:
 *
 * - the current database (`pg_locks.database`);
 * - `classid`/`objid`, the two unsigned 32-bit words of an int8 advisory key;
 * - `objsubid = 1`, which marks the single-bigint form (`pg_advisory_xact_lock(bigint)`).
 *
 * A queue entry is accepted only when it is ungranted *and* its blocking chain contains the
 * intended holder, so an unrelated lock (or a sibling digest of the same tenant) can never
 * satisfy the barrier. PostgreSQL reports predecessors in the wait queue for the same lock
 * ("soft blockers") through `pg_blocking_pids()`, which is what proves two test sessions are
 * queued in a specific order rather than merely both waiting.
 */

export interface AdvisoryLockIdentity {
  /** `pg_locks.classid` of the int8 advisory key, as an unsigned decimal string. */
  readonly classId: string;
  /** `pg_locks.objid` of the int8 advisory key, as an unsigned decimal string. */
  readonly objId: string;
}

export interface AdvisoryLockObservation {
  readonly pid: number;
  /** A granted row is the lock holder, never a queue entry. */
  readonly granted: boolean;
  /** Transitive `pg_blocking_pids()` chain of `pid`, including soft blockers. */
  readonly blockedBy: readonly number[];
}

export interface AdvisoryLockQueueEntry {
  readonly pid: number;
  readonly blockedBy: readonly number[];
}

export interface WaitForAdvisoryLockQueueEntryOptions {
  /** Key passed to `blobLockKey()`/`pg_advisory_xact_lock(hashtextextended(...))`. */
  readonly lockKey: string;
  /** Session that holds the lock and must block the new queue entry. */
  readonly blockerPid: number;
  /** Sessions already known to be queued ahead; the new entry must be blocked by them too. */
  readonly aheadOf?: readonly number[];
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 5;

/**
 * Identity of the advisory lock PostgreSQL will record for `lockKey`.
 *
 * `hashtextextended(text, 0)` is the same expression publishers and the collector use, so the
 * value is read back from the server instead of being re-implemented. PostgreSQL splits the
 * signed 64-bit key into two unsigned 32-bit words, which is why the shifted value is rebased
 * with `BigInt.asUintN` (a negative hash sign-extends).
 */
export async function resolveAdvisoryLockIdentity(
  pool: TestPool,
  lockKey: string,
): Promise<AdvisoryLockIdentity> {
  const result = await pool.query<{ key: string }>('SELECT hashtextextended($1, 0)::text AS key', [
    lockKey,
  ]);
  const raw = result.rows[0]?.key;

  if (raw === undefined) {
    throw new Error(`could not hash the advisory lock key ${lockKey}`);
  }

  const key = BigInt(raw);

  return Object.freeze({
    classId: BigInt.asUintN(32, key >> 32n).toString(),
    objId: BigInt.asUintN(32, key).toString(),
  });
}

/**
 * Every `pg_locks` row for exactly this lock in the current database, granted or queued.
 *
 * Only this identity is returned: waiters on any other advisory lock in the same database are
 * invisible here by construction.
 */
export async function observeAdvisoryLock(
  pool: TestPool,
  identity: AdvisoryLockIdentity,
): Promise<readonly AdvisoryLockObservation[]> {
  const result = await pool.query<{
    pid: number;
    granted: boolean;
    blockedBy: number[] | null;
  }>(
    `
WITH RECURSIVE target AS (
  SELECT l.pid, l.granted
    FROM pg_locks l
   WHERE l.locktype = 'advisory'
     AND l.objsubid = 1
     AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND l.classid = $1::oid
     AND l.objid = $2::oid
),
chain AS (
  SELECT target.pid AS source, unnest(pg_blocking_pids(target.pid)) AS pid
    FROM target
  UNION
  SELECT chain.source, unnest(pg_blocking_pids(chain.pid))
    FROM chain
)
SELECT target.pid,
       target.granted,
       COALESCE(array_agg(DISTINCT chain.pid) FILTER (WHERE chain.pid IS NOT NULL), '{}'::integer[])
         AS "blockedBy"
  FROM target
  LEFT JOIN chain ON chain.source = target.pid
 GROUP BY target.pid, target.granted
 ORDER BY target.pid
`,
    [identity.classId, identity.objId],
  );

  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        pid: row.pid,
        granted: row.granted,
        blockedBy: Object.freeze([...(row.blockedBy ?? [])]),
      }),
    ),
  );
}

/**
 * Wait until one new session is queued on exactly `lockKey`, behind `blockerPid`.
 *
 * The barrier requires all of:
 *
 * - a queue entry appears on the target lock's own identity, so no other advisory lock counts;
 * - it is ungranted and is an entry nobody has accounted for yet;
 * - the target queue grew by exactly one entry, so nothing extra is queued on the same lock;
 * - the holder is in its blocking chain, and every `aheadOf` pid as well, which places the new
 *   session behind those sessions rather than beside them.
 *
 * Returns the pid of the session that queued, so callers can assert on the exact backend.
 */
export async function waitForAdvisoryLockQueueEntry(
  pool: TestPool,
  options: WaitForAdvisoryLockQueueEntryOptions,
): Promise<AdvisoryLockQueueEntry> {
  const identity = await resolveAdvisoryLockIdentity(pool, options.lockKey);
  const aheadOf = options.aheadOf ?? [];
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let observed: readonly AdvisoryLockObservation[] = [];

  while (Date.now() < deadline) {
    observed = await observeAdvisoryLock(pool, identity);

    const queued = observed.filter((row) => !row.granted);
    const unknown = queued.filter((row) => !aheadOf.includes(row.pid));
    const entry = unknown[0];

    if (
      unknown.length === 1 &&
      entry !== undefined &&
      queued.length === aheadOf.length + 1 &&
      entry.pid !== options.blockerPid &&
      entry.blockedBy.includes(options.blockerPid) &&
      aheadOf.every((pid) => entry.blockedBy.includes(pid))
    ) {
      return Object.freeze({ pid: entry.pid, blockedBy: entry.blockedBy });
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `timed out waiting for a session to queue on advisory lock ${options.lockKey} ` +
      `behind ${options.blockerPid}; last observation: ${JSON.stringify(observed)}`,
  );
}
