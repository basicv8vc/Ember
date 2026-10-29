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

/** Begin a transaction that holds `lockKey` until `release()`. */
async function holdLock(lockKey: string): Promise<HeldLock> {
  const client = await db.pool.connect();
  const pid = await backendPid(client);

  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

  return {
    pid,
    release: async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    },
  };
}

/**
 * Begin a transaction whose advisory lock request is queued behind `holderPid`.
 *
 * Returns only once the statement is genuinely waiting on `holderPid` for `lockKey`. The
 * holder must be released before this session is released, so the queued statement can
 * complete instead of being cut off on a busy connection.
 */
async function queueLock(lockKey: string, holderPid: number): Promise<HeldLock> {
  const client = await db.pool.connect();
  const pid = await backendPid(client);
  const granted = client
    .query('BEGIN')
    .then(() => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]))
    .catch(() => undefined);

  await waitForAdvisoryLockQueueEntry(db.pool, { lockKey, blockerPid: holderPid });

  return {
    pid,
    release: async () => {
      await granted;
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
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
