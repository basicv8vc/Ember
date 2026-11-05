import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createPool, loadDatabaseConfig } from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresB1ConsumerProvisioningRepository } from '../../packages/postgres/src/repositories/b1-session-provisioning-repository.js';
import { PostgresB1ConsumerSessionRepository } from '../../packages/postgres/src/repositories/b1-session-repository.js';
import { createTestDatabase, type TestDatabase, type TestPool } from './support/database.js';

interface Token {
  readonly raw: string;
  readonly digest: Buffer;
}

function token(): Token {
  const raw = `ems_${randomBytes(32).toString('base64url')}`;
  return { raw, digest: createHash('sha256').update(raw).digest() };
}

function ttl() {
  const now = Date.now();
  return {
    expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    idleExpiresAt: new Date(now + 14 * 86_400_000).toISOString(),
  };
}

describe('B1-2C: rotated-token replay on protected reads (PostgreSQL 17)', () => {
  let db: TestDatabase;
  let poolA: TestPool;
  let poolB: TestPool;
  let provisioning: PostgresB1ConsumerProvisioningRepository;
  let sessionsA: PostgresB1ConsumerSessionRepository;
  let sessionsB: PostgresB1ConsumerSessionRepository;

  beforeAll(async () => {
    db = await createTestDatabase({ maxConnections: 8 });
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('TEST_DATABASE_URL is required');
    }
    const config = loadDatabaseConfig({ DATABASE_URL: databaseUrl });
    poolA = createPool({ ...config, maxConnections: 1, searchPath: db.schema });
    poolB = createPool({ ...config, maxConnections: 1, searchPath: db.schema });
    provisioning = new PostgresB1ConsumerProvisioningRepository(db.pool);
    sessionsA = new PostgresB1ConsumerSessionRepository(poolA);
    sessionsB = new PostgresB1ConsumerSessionRepository(poolB);

    const version = await db.pool.query<{ version: string }>('SELECT version() AS version');
    expect(version.rows[0]?.version).toMatch(/^PostgreSQL 17\./);
  });

  afterAll(async () => {
    await poolA?.end().catch(() => undefined);
    await poolB?.end().catch(() => undefined);
    await db?.close();
  });

  async function signIn(providerSubject: string, sessionToken: Token) {
    const window = ttl();
    return provisioning.provisionIdentityAndCreateSession({
      provider: 'dev',
      providerSubject,
      tokenDigest: sessionToken.digest,
      expiresAt: window.expiresAt,
      idleExpiresAt: window.idleExpiresAt,
    });
  }

  async function activeSessions(consumerId: string): Promise<number> {
    const result = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM consumer_sessions
        WHERE consumer_id = $1 AND revoked_at IS NULL`,
      [consumerId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  it('commits consumer-wide revocation when a rotated token is presented to a protected read', async () => {
    const original = token();
    const other = token();
    const successor = token();
    const subject = `read-replay-${randomUUID()}`;
    const owner = await signIn(subject, original);
    // A second live session belongs to the same Consumer.
    await signIn(subject, other);

    const window = ttl();
    const rotation = await sessionsA.rotateSession({
      currentTokenDigest: original.digest,
      newTokenDigest: successor.digest,
      expiresAt: window.expiresAt,
      idleExpiresAt: window.idleExpiresAt,
    });
    expect(rotation.kind).toBe('rotated');

    await expect(sessionsA.findActiveSession(original.digest)).resolves.toBeNull();
    expect(await activeSessions(owner.identity.consumerId)).toBe(0);

    const reasons = await db.pool.query<{ revocation_reason: string | null }>(
      'SELECT revocation_reason FROM consumer_sessions WHERE consumer_id = $1',
      [owner.identity.consumerId],
    );
    expect(reasons.rows.filter((row) => row.revocation_reason === 'reuse_detected')).toHaveLength(
      2,
    );
    expect(reasons.rows.filter((row) => row.revocation_reason === 'rotated')).toHaveLength(1);
  });

  it('serializes read replay against a concurrent refresh with no surviving active session', async () => {
    const original = token();
    const secondSession = token();
    const successor = token();
    const refreshSuccessor = token();
    const subject = `read-refresh-race-${randomUUID()}`;
    const owner = await signIn(subject, original);
    const window = ttl();
    await provisioning.provisionIdentityAndCreateSession({
      provider: 'dev',
      providerSubject: subject,
      tokenDigest: secondSession.digest,
      expiresAt: window.expiresAt,
      idleExpiresAt: window.idleExpiresAt,
    });
    const firstRotation = await sessionsA.rotateSession({
      currentTokenDigest: original.digest,
      newTokenDigest: successor.digest,
      expiresAt: window.expiresAt,
      idleExpiresAt: window.idleExpiresAt,
    });
    expect(firstRotation.kind).toBe('rotated');

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replay = gate.then(() => sessionsA.findActiveSession(original.digest));
    const refresh = gate.then(() =>
      sessionsB.rotateSession({
        currentTokenDigest: successor.digest,
        newTokenDigest: refreshSuccessor.digest,
        expiresAt: window.expiresAt,
        idleExpiresAt: window.idleExpiresAt,
      }),
    );
    release();
    const [readResult, refreshResult] = await Promise.all([replay, refresh]);

    expect(readResult).toBeNull();
    expect(['inactive', 'rotated']).toContain(refreshResult.kind);
    expect(await activeSessions(owner.identity.consumerId)).toBe(0);

    const rows = await db.pool.query<{ revocation_reason: string | null }>(
      'SELECT revocation_reason FROM consumer_sessions WHERE consumer_id = $1',
      [owner.identity.consumerId],
    );
    expect(rows.rows.some((row) => row.revocation_reason === 'reuse_detected')).toBe(true);
  });
});
