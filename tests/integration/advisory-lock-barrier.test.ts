import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobLockKey } from '@ember/postgres';
import { backendPid, createTestDatabase, type TestDatabase } from './support/database.js';
import {
  observeAdvisoryLock,
  resolveAdvisoryLockIdentity,
  waitForAdvisoryLockQueueEntry,
} from './support/advisory-locks.js';

/**
 * P0B-06-T1: the barrier the Artifact/GC race regression relies on must synchronize on one
 * exact advisory lock.
 *
 * The previous barrier waited for *any* ungranted advisory lock in the database. Integration
 * files share a database and every file runs migrations, which serialize on one advisory key,
 * so the old barrier could be satisfied by a waiter that had nothing to do with the race and
 * let the test continue before the collector was queued. These tests pin the corrected
 * contract: an unrelated waiter — including a waiter on another digest of the same tenant —
 * can never satisfy the barrier, while the intended session is still detected.
 */

let db: TestDatabase;
/** Unique per run, so keys never collide with leftovers of an interrupted run. */
const tenantId = randomUUID();

function digestFor(label: string): string {
  return createHash('sha256').update(`${label}:${randomUUID()}`).digest('hex');
}

/** Keys the migrator and other subsystems use; unrelated to blob collection. */
function unrelatedKeyFor(label: string): string {
  return `ember.test.unrelated:${label}:${randomUUID()}`;
}

interface HeldLock {
  readonly pid: number;
  /** Roll back and hand the connection back; safe to call more than once. */
  release(): Promise<void>;
}

type PoolClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  /** `true` destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean): void;
};

/** How long a cancelled statement may take to settle before its connection is destroyed. */
const CANCEL_GRACE_MS = 1_000;

/** `true` when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Roll back and hand a client back exactly once, so a repeated release stays harmless. */
function releaseOnce(client: PoolClient): () => Promise<void> {
  let released = false;

  return async () => {
    if (released) {
      return;
    }
    released = true;

    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  };
}

/**
 * Give back a client whose statement may still be waiting on a server lock.
 *
 * Awaiting that statement would hang the very failure this path exists to report, so the backend
 * is cancelled from another connection first. If the cancellation does not land, the connection
 * is destroyed rather than handed back busy. Either way the pool gets its slot back, so a fixture
 * that fails cannot make `db.close()` in `afterAll()` wait for an abandoned session.
 */
async function cancelWaitingAndRelease(
  client: PoolClient,
  release: () => Promise<void>,
  pid: number,
  waiting: Promise<unknown>,
): Promise<void> {
  await db.pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);

  if (await settlesWithin(waiting, CANCEL_GRACE_MS)) {
    await release();

    return;
  }

  client.release(true);
}

/** Begin a transaction that holds `lockKey` until `release()`. */
async function holdLock(lockKey: string): Promise<HeldLock> {
  const client = await db.pool.connect();
  const release = releaseOnce(client);

  try {
    const pid = await backendPid(client);

    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

    return { pid, release };
  } catch (error) {
    // The connection is checked out of the pool already: return it before reporting the failure.
    await release();
    throw error;
  }
}

/**
 * Begin a transaction whose advisory lock request is queued behind `holderPid`.
 *
 * Returns only once the statement is genuinely waiting on `holderPid` for `lockKey`. The holder
 * must be released before this session is released, so the queued statement can complete instead
 * of being cut off on a busy connection. If the barrier never sees the expected queue entry, the
 * waiting statement is cancelled and the connection is still handed back, so a barrier timeout
 * reports itself instead of wedging the pool.
 */
async function queueLock(
  lockKey: string,
  holderPid: number,
  barrierTimeoutMs?: number,
): Promise<HeldLock> {
  const client = await db.pool.connect();
  const release = releaseOnce(client);
  let pid: number;

  try {
    pid = await backendPid(client);
  } catch (error) {
    await release();
    throw error;
  }

  const waiting = client
    .query('BEGIN')
    .then(() => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]))
    // Settled either way: the grant itself is never asserted on, only the queue position.
    .catch(() => undefined);

  try {
    await waitForAdvisoryLockQueueEntry(db.pool, {
      lockKey,
      blockerPid: holderPid,
      timeoutMs: barrierTimeoutMs,
    });
  } catch (error) {
    await cancelWaitingAndRelease(client, release, pid, waiting);
    throw error;
  }

  return {
    pid,
    release: async () => {
      // The holder is released first, so the queued statement finishes before its connection
      // goes back; `release()` itself is idempotent.
      await waiting;
      await release();
    },
  };
}

/** The removed barrier's predicate, kept only to show that it accepts these fixtures. */
async function databaseWideAdvisoryLockWaiters(): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  );

  return Number(result.rows[0]?.count ?? '0');
}

/**
 * Run `body` with sessions that hold or queue on advisory locks, then release them in creation
 * order. Holders are created before the sessions they block, so the release order unblocks
 * every queued statement before its connection is handed back.
 */
async function withLockSessions(
  body: (sessions: {
    hold: (lockKey: string) => Promise<HeldLock>;
    queue: (lockKey: string, holderPid: number) => Promise<HeldLock>;
  }) => Promise<void>,
): Promise<void> {
  const created: HeldLock[] = [];

  try {
    await body({
      hold: async (lockKey) => {
        const held = await holdLock(lockKey);
        created.push(held);

        return held;
      },
      queue: async (lockKey, holderPid) => {
        const held = await queueLock(lockKey, holderPid);
        created.push(held);

        return held;
      },
    });
  } finally {
    for (const held of created) {
      await held.release();
    }
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db?.close();
});

/** A tenant-digest key whose int8 hash is negative: the sign-extension edge case. */
async function negativeHashKey(): Promise<string> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = blobLockKey(tenantId, digestFor('negative-hash'));
    const result = await db.pool.query<{ key: string }>(
      'SELECT hashtextextended($1, 0)::text AS key',
      [candidate],
    );

    if (BigInt(result.rows[0]?.key ?? '0') < 0n) {
      return candidate;
    }
  }

  throw new Error('no negative advisory lock hash found in 64 attempts');
}

describe('P0B06-T1 advisory lock identity', () => {
  it('resolves the exact pg_locks identity PostgreSQL records for a key', async () => {
    const plainKey = blobLockKey(tenantId, digestFor('identity-plain'));
    const signedKey = await negativeHashKey();
    const plain = await resolveAdvisoryLockIdentity(db.pool, plainKey);
    const signed = await resolveAdvisoryLockIdentity(db.pool, signedKey);

    // Two different keys must never collapse onto one identity.
    expect(signed).not.toEqual(plain);

    const plainHolder = await holdLock(plainKey);
    const signedHolder = await holdLock(signedKey);

    try {
      // The derived identity names the row PostgreSQL actually recorded for that session...
      await expect(observeAdvisoryLock(db.pool, plain)).resolves.toEqual([
        { pid: plainHolder.pid, granted: true, blockedBy: [] },
      ]);
      // ...including a negative hash, which must not be sign-extended onto another identity.
      await expect(observeAdvisoryLock(db.pool, signed)).resolves.toEqual([
        { pid: signedHolder.pid, granted: true, blockedBy: [] },
      ]);
    } finally {
      await signedHolder.release();
      await plainHolder.release();
    }
  });
});

describe('P0B06-T1 exact-target queue barrier', () => {
  it('detects only the session queued behind the holder on that lock', async () => {
    const targetKey = blobLockKey(tenantId, digestFor('barrier-target'));
    const unrelatedKey = unrelatedKeyFor('migrator');

    await withLockSessions(async ({ hold, queue }) => {
      const target = await hold(targetKey);
      const unrelated = await hold(unrelatedKey);
      // An unrelated advisory lock already has a waiter, exactly like the migration serializer
      // of another test file, and it stays queued for the whole test.
      const unrelatedWaiter = await queue(unrelatedKey, unrelated.pid);
      const targetWaiter = await queue(targetKey, target.pid);

      const entry = await waitForAdvisoryLockQueueEntry(db.pool, {
        lockKey: targetKey,
        blockerPid: target.pid,
      });

      // The session queued on the target lock, not the unrelated waiter that a database-wide
      // count also sees.
      expect(await databaseWideAdvisoryLockWaiters()).toBeGreaterThanOrEqual(2);
      expect(entry.pid).toBe(targetWaiter.pid);
      expect(entry.pid).not.toBe(unrelatedWaiter.pid);
      expect(entry.blockedBy).toContain(target.pid);
    });
  });

  it('never accepts an unrelated advisory-lock waiter', async () => {
    const targetKey = blobLockKey(tenantId, digestFor('barrier-quiet'));

    await withLockSessions(async ({ hold, queue }) => {
      const target = await hold(targetKey);
      const unrelatedKey = unrelatedKeyFor('migrator');
      const unrelated = await hold(unrelatedKey);
      const unrelatedWaiter = await queue(unrelatedKey, unrelated.pid);

      // The removed barrier returned as soon as one advisory lock anywhere in the database was
      // ungranted, which is true here while nothing at all is queued on the target lock.
      expect(await databaseWideAdvisoryLockWaiters()).toBeGreaterThanOrEqual(1);
      await expect(
        waitForAdvisoryLockQueueEntry(db.pool, {
          lockKey: targetKey,
          blockerPid: target.pid,
          timeoutMs: 250,
        }),
      ).rejects.toThrow(/timed out/);

      // The unrelated waiter really is queued and blocked, yet the target lock only holds.
      const unrelatedRows = await observeAdvisoryLock(
        db.pool,
        await resolveAdvisoryLockIdentity(db.pool, unrelatedKey),
      );

      expect(unrelatedRows).toHaveLength(2);
      expect(unrelatedRows).toEqual(
        expect.arrayContaining([
          { pid: unrelated.pid, granted: true, blockedBy: [] },
          { pid: unrelatedWaiter.pid, granted: false, blockedBy: [unrelated.pid] },
        ]),
      );
      await expect(
        observeAdvisoryLock(db.pool, await resolveAdvisoryLockIdentity(db.pool, targetKey)),
      ).resolves.toEqual([{ pid: target.pid, granted: true, blockedBy: [] }]);
    });
  });

  it('never accepts a waiter on another digest of the same tenant', async () => {
    const targetKey = blobLockKey(tenantId, digestFor('sibling-target'));
    const siblingKey = blobLockKey(tenantId, digestFor('sibling-other'));

    await withLockSessions(async ({ hold, queue }) => {
      const target = await hold(targetKey);
      const sibling = await hold(siblingKey);
      const siblingWaiter = await queue(siblingKey, sibling.pid);

      expect(siblingWaiter.pid).not.toBe(sibling.pid);
      await expect(
        waitForAdvisoryLockQueueEntry(db.pool, {
          lockKey: targetKey,
          blockerPid: target.pid,
          timeoutMs: 250,
        }),
      ).rejects.toThrow(/timed out/);
    });
  });
});

interface PoolCounts {
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
}

function poolCounts(): PoolCounts {
  return {
    total: db.pool.totalCount,
    idle: db.pool.idleCount,
    waiting: db.pool.waitingCount,
  };
}

/** Wait until the pool is back to `expected`, which proves no connection stayed checked out. */
async function waitForPoolCounts(expected: PoolCounts, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = poolCounts();

    if (current.total === expected.total && current.idle === expected.idle) {
      expect(current.waiting).toBe(0);

      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `pool did not return to ${JSON.stringify(expected)}; saw ${JSON.stringify(poolCounts())}`,
  );
}

/**
 * Wait until `pid` is not waiting on any lock, i.e. its cancelled statement really ended.
 *
 * Only the wait condition is asserted, never `state`/`xact_start`: the returned connection may be
 * recycled into this very polling query, which would then look busy or "in transaction" forever.
 */
async function waitForNoLockWait(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE pid = $1
          AND wait_event_type = 'Lock'`,
      [pid],
    );

    if (Number(result.rows[0]?.count ?? '0') === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`backend ${pid} is still waiting on a lock`);
}

describe('P0B06-T1 lock fixture cleanup', () => {
  it('returns the connection to the pool when the queue barrier times out', async () => {
    const targetKey = blobLockKey(tenantId, digestFor('cleanup-timeout'));
    const holder = await holdLock(targetKey);

    try {
      const before = poolCounts();
      // No backend can have pid 0, so this barrier can only time out - while the session below
      // really is queued and blocked. That is exactly the failing path that must not leak.
      const attempt = queueLock(targetKey, 0, 250);
      const queued = await waitForAdvisoryLockQueueEntry(db.pool, {
        lockKey: targetKey,
        blockerPid: holder.pid,
      });

      expect(queued.pid).not.toBe(holder.pid);
      await expect(attempt).rejects.toThrow(/timed out/);

      // The failed fixture cancelled its statement and handed the connection back, so the pool
      // is where it was before the attempt and `db.close()` has nothing to wait for.
      await waitForPoolCounts(before);
      expect(poolCounts().waiting).toBe(0);
      await waitForNoLockWait(queued.pid);

      // Nothing is left queued on the target lock either.
      await expect(
        observeAdvisoryLock(db.pool, await resolveAdvisoryLockIdentity(db.pool, targetKey)),
      ).resolves.toEqual([{ pid: holder.pid, granted: true, blockedBy: [] }]);
    } finally {
      await holder.release();
    }
  });

  it('releases a lock session more than once without error', async () => {
    const targetKey = blobLockKey(tenantId, digestFor('cleanup-double-release'));
    const holder = await holdLock(targetKey);

    await holder.release();
    // The `HeldLock.release()` contract says it is safe to call twice; a second `client.release()`
    // would throw, so this pins the flag inside `releaseOnce()`.
    await expect(holder.release()).resolves.toBeUndefined();
    expect(poolCounts().waiting).toBe(0);
  });
});
