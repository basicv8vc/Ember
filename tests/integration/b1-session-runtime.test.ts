import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDomainError, type Id } from '@ember/domain';
import { createPool, loadDatabaseConfig } from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { B1ProvisionedSession } from '../../packages/postgres/src/repositories/b1-interfaces.js';
import { PostgresB1ConsumerProvisioningRepository } from '../../packages/postgres/src/repositories/b1-session-provisioning-repository.js';
import { PostgresB1ConsumerSessionRepository } from '../../packages/postgres/src/repositories/b1-session-repository.js';
import {
  B1_SESSION_ABSOLUTE_TTL_DAYS,
  B1_SESSION_IDLE_TTL_DAYS,
} from '../../packages/postgres/src/repositories/b1-session-support.js';
import { createTestDatabase, type TestDatabase, type TestPool } from './support/database.js';

/**
 * B1-2A acceptance: real PostgreSQL 17, real migrations, no mocked store (contract §12 rules).
 *
 * Race cases use dedicated one-connection pools (`poolA` / `poolB`) so the two writers are
 * genuinely separate PostgreSQL backends. Every case uses a unique provider subject, so the
 * shared throwaway schema stays deterministic regardless of execution order.
 *
 * Tokens exist only here, in the test process. The repositories receive their SHA-256 digest
 * exclusively; no test ever hands a raw token to a repository method except to prove that a
 * malformed digest is rejected at the boundary.
 */
const DAY_MS = 86_400_000;

interface Token {
  readonly raw: string;
  readonly digest: Buffer;
}

interface Ttl {
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

interface SessionRow {
  id: string;
  tenant_id: string;
  consumer_id: string;
  token_digest: Buffer;
  issued_at: Date;
  expires_at: Date;
  idle_expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
  rotated_from_session_id: string | null;
}

function subject(label: string): string {
  return `${label}-${randomUUID()}`;
}

function newToken(label: string): Token {
  const raw = `ems_${label}_${randomBytes(32).toString('hex')}`;
  return { raw, digest: createHash('sha256').update(raw, 'utf8').digest() };
}

function ttlFromNow(
  absoluteDays = B1_SESSION_ABSOLUTE_TTL_DAYS,
  idleDays = B1_SESSION_IDLE_TTL_DAYS,
): Ttl {
  const now = Date.now();
  return {
    expiresAt: new Date(now + absoluteDays * DAY_MS).toISOString(),
    idleExpiresAt: new Date(now + idleDays * DAY_MS).toISOString(),
  };
}

function provisioningCommand(providerSubject: string, token: Token, ttl: Ttl) {
  return {
    provider: 'dev' as const,
    providerSubject,
    tokenDigest: token.digest,
    expiresAt: ttl.expiresAt,
    idleExpiresAt: ttl.idleExpiresAt,
  };
}

function rotationCommand(current: Token, next: Token, ttl: Ttl) {
  return {
    currentTokenDigest: current.digest,
    newTokenDigest: next.digest,
    expiresAt: ttl.expiresAt,
    idleExpiresAt: ttl.idleExpiresAt,
  };
}

describe('B1-2A: Consumer identity and session runtime (PostgreSQL 17)', () => {
  let db: TestDatabase;
  let poolA: TestPool;
  let poolB: TestPool;
  let provisioning: PostgresB1ConsumerProvisioningRepository;
  let sessions: PostgresB1ConsumerSessionRepository;

  beforeAll(async () => {
    db = await createTestDatabase();

    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined || url.length === 0) {
      throw new Error('TEST_DATABASE_URL is required');
    }
    const config = loadDatabaseConfig({ DATABASE_URL: url });
    // One connection each: these pools cannot accidentally share a backend during a race.
    poolA = createPool({ ...config, maxConnections: 1, searchPath: db.schema });
    poolB = createPool({ ...config, maxConnections: 1, searchPath: db.schema });

    provisioning = new PostgresB1ConsumerProvisioningRepository(db.pool);
    sessions = new PostgresB1ConsumerSessionRepository(db.pool);
  });

  afterAll(async () => {
    await poolA?.end().catch(() => undefined);
    await poolB?.end().catch(() => undefined);
    await db?.close();
  });

  async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
    const result = await db.pool.query<{ total: string }>(sql, [...params]);
    return Number(result.rows[0]?.total ?? '0');
  }

  async function graphCounts(): Promise<Record<string, number>> {
    return {
      tenants: await count('SELECT count(*)::text AS total FROM tenants'),
      principals: await count('SELECT count(*)::text AS total FROM principals'),
      consumers: await count('SELECT count(*)::text AS total FROM consumers'),
      identities: await count('SELECT count(*)::text AS total FROM consumer_identities'),
      agents: await count('SELECT count(*)::text AS total FROM agents'),
      conversations: await count('SELECT count(*)::text AS total FROM conversations'),
      sessions: await count('SELECT count(*)::text AS total FROM consumer_sessions'),
    };
  }

  async function sessionRow(sessionId: Id): Promise<SessionRow> {
    const result = await db.pool.query<SessionRow>(
      'SELECT * FROM consumer_sessions WHERE id = $1',
      [sessionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('expected a persisted session row');
    }
    return row;
  }

  async function activeSessions(consumerId: Id): Promise<number> {
    return count(
      'SELECT count(*)::text AS total FROM consumer_sessions WHERE consumer_id = $1 AND revoked_at IS NULL',
      [consumerId],
    );
  }

  async function signIn(
    providerSubject: string,
    token: Token,
    ttl: Ttl = ttlFromNow(),
  ): Promise<B1ProvisionedSession> {
    return provisioning.provisionIdentityAndCreateSession(
      provisioningCommand(providerSubject, token, ttl),
    );
  }

  it('1. first sign-in provisions Tenant, owner Principal, Consumer, Identity, Agent, Conversation and Session', async () => {
    const providerSubject = subject('first');
    const token = newToken('first');
    const provisioned = await signIn(providerSubject, token);

    const { consumerId, tenantId, principalId, agentId, conversationId } = provisioned.identity;
    expect(consumerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set([consumerId, tenantId, principalId, agentId, conversationId]).size).toBe(5);

    const tenant = await db.pool.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [
      tenantId,
    ]);
    expect(tenant.rows[0]?.name).toBeTruthy();

    const principal = await db.pool.query<{ role: string }>(
      'SELECT role FROM principals WHERE tenant_id = $1 AND id = $2',
      [tenantId, principalId],
    );
    expect(principal.rows[0]?.role).toBe('owner');

    const consumer = await count(
      'SELECT count(*)::text AS total FROM consumers WHERE id = $1 AND tenant_id = $2 AND principal_id = $3',
      [consumerId, tenantId, principalId],
    );
    expect(consumer).toBe(1);

    const identity = await db.pool.query<{ provider: string; provider_subject: string }>(
      'SELECT provider, provider_subject FROM consumer_identities WHERE consumer_id = $1',
      [consumerId],
    );
    expect(identity.rows).toHaveLength(1);
    expect(identity.rows[0]?.provider).toBe('dev');
    expect(identity.rows[0]?.provider_subject).toBe(providerSubject);

    const agent = await db.pool.query<{ name: string; policy_version: number }>(
      'SELECT name, policy_version FROM agents WHERE tenant_id = $1 AND id = $2',
      [tenantId, agentId],
    );
    expect(agent.rows[0]?.name).toBe('Ember');
    expect(agent.rows[0]?.policy_version).toBeGreaterThanOrEqual(0);

    const conversation = await db.pool.query<{ kind: string; agent_id: string }>(
      'SELECT kind, agent_id FROM conversations WHERE tenant_id = $1 AND id = $2',
      [tenantId, conversationId],
    );
    expect(conversation.rows[0]?.kind).toBe('main');
    expect(conversation.rows[0]?.agent_id).toBe(agentId);

    const row = await sessionRow(provisioned.session.sessionId);
    expect(Buffer.compare(row.token_digest, token.digest)).toBe(0);
    expect(row.revoked_at).toBeNull();
    expect(row.expires_at.getTime() - row.issued_at.getTime()).toBeLessThanOrEqual(
      B1_SESSION_ABSOLUTE_TTL_DAYS * DAY_MS + 5_000,
    );
    expect(row.idle_expires_at.getTime() - row.issued_at.getTime()).toBeLessThanOrEqual(
      B1_SESSION_IDLE_TTL_DAYS * DAY_MS + 5_000,
    );
  });

  it('2. repeated sign-in reuses the identity graph but mints a fresh Session', async () => {
    const providerSubject = subject('repeat');
    const first = await signIn(providerSubject, newToken('repeat-1'));
    const second = await signIn(providerSubject, newToken('repeat-2'));

    expect(second.identity).toEqual(first.identity);
    expect(second.session.sessionId).not.toBe(first.session.sessionId);
    expect(second.session.tenantId).toBe(first.identity.tenantId);

    expect(
      await count(
        'SELECT count(*)::text AS total FROM consumer_identities WHERE provider_subject = $1',
        [providerSubject],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS total FROM consumers WHERE tenant_id = $1', [
        first.identity.tenantId,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS total FROM agents WHERE tenant_id = $1', [
        first.identity.tenantId,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS total FROM conversations WHERE tenant_id = $1', [
        first.identity.tenantId,
      ]),
    ).toBe(1);
    expect(await activeSessions(first.identity.consumerId)).toBe(2);
  });

  it('3. concurrent sign-ins on separate connections do not create duplicate entities', async () => {
    const providerSubject = subject('concurrent');
    const tokenA = newToken('concurrent-a');
    const tokenB = newToken('concurrent-b');
    const repoA = new PostgresB1ConsumerProvisioningRepository(poolA);
    const repoB = new PostgresB1ConsumerProvisioningRepository(poolB);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.then(() =>
      repoA.provisionIdentityAndCreateSession(
        provisioningCommand(providerSubject, tokenA, ttlFromNow()),
      ),
    );
    const second = gate.then(() =>
      repoB.provisionIdentityAndCreateSession(
        provisioningCommand(providerSubject, tokenB, ttlFromNow()),
      ),
    );
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(left.identity).toEqual(right.identity);
    expect(left.session.sessionId).not.toBe(right.session.sessionId);
    expect(
      await count(
        'SELECT count(*)::text AS total FROM consumer_identities WHERE provider_subject = $1',
        [providerSubject],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS total FROM consumers WHERE tenant_id = $1', [
        left.identity.tenantId,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS total FROM principals WHERE tenant_id = $1', [
        left.identity.tenantId,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS total FROM agents WHERE tenant_id = $1', [
        left.identity.tenantId,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::text AS total FROM conversations WHERE tenant_id = $1', [
        left.identity.tenantId,
      ]),
    ).toBe(1);
    expect(await activeSessions(left.identity.consumerId)).toBe(2);
  });

  it('4. provisioning failures roll back every insert', async () => {
    const injectedSubject = subject('rollback-injected');
    const failing = new PostgresB1ConsumerProvisioningRepository(db.pool, {
      beforeSessionInsert: () => Promise.reject(new Error('injected provisioning failure')),
    });
    const beforeInjected = await graphCounts();
    await expect(
      failing.provisionIdentityAndCreateSession(
        provisioningCommand(injectedSubject, newToken('rollback-injected'), ttlFromNow()),
      ),
    ).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(await graphCounts()).toEqual(beforeInjected);
    expect(
      await count(
        'SELECT count(*)::text AS total FROM consumer_identities WHERE provider_subject = $1',
        [injectedSubject],
      ),
    ).toBe(0);

    // A real constraint failure at the last insert (duplicate digest) must be equally atomic.
    const shared = newToken('rollback-duplicate');
    await signIn(subject('rollback-first'), shared);
    const duplicateSubject = subject('rollback-second');
    const beforeDuplicate = await graphCounts();
    await expect(signIn(duplicateSubject, shared)).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
    });
    expect(await graphCounts()).toEqual(beforeDuplicate);
    expect(
      await count(
        'SELECT count(*)::text AS total FROM consumer_identities WHERE provider_subject = $1',
        [duplicateSubject],
      ),
    ).toBe(0);
  });

  it('5. a valid digest resolves the correct Principal, Tenant and policyVersion', async () => {
    const token = newToken('resolve');
    const provisioned = await signIn(subject('resolve'), token);
    const found = await sessions.findActiveSession(token.digest);
    if (found === null) {
      throw new Error('expected an authenticated session');
    }

    const consumer = await db.pool.query<{ principal_id: string }>(
      'SELECT principal_id FROM consumers WHERE id = $1 AND tenant_id = $2',
      [provisioned.identity.consumerId, provisioned.identity.tenantId],
    );
    expect(found.session.sessionId).toBe(provisioned.session.sessionId);
    expect(found.session.tenantId).toBe(provisioned.identity.tenantId);
    expect(found.session.consumerId).toBe(provisioned.identity.consumerId);
    expect(found.principalId).toBe(consumer.rows[0]?.principal_id);
    expect(found.policyVersion).toBe(1);
  });

  it('6. expired, idle-expired and revoked tokens are rejected', async () => {
    const absoluteToken = newToken('expired-absolute');
    const absolute = await signIn(subject('expired-absolute'), absoluteToken);
    await db.pool.query(
      `UPDATE consumer_sessions
          SET issued_at = clock_timestamp() - interval '60 days',
              expires_at = clock_timestamp() - interval '1 day',
              idle_expires_at = clock_timestamp() - interval '1 day'
        WHERE id = $1`,
      [absolute.session.sessionId],
    );
    expect(await sessions.findActiveSession(absoluteToken.digest)).toBeNull();
    expect(
      (
        await sessions.rotateSession(
          rotationCommand(absoluteToken, newToken('expired-absolute-next'), ttlFromNow()),
        )
      ).kind,
    ).toBe('inactive');

    const idleToken = newToken('expired-idle');
    const idle = await signIn(subject('expired-idle'), idleToken);
    await db.pool.query(
      `UPDATE consumer_sessions
          SET issued_at = clock_timestamp() - interval '60 days',
              expires_at = clock_timestamp() + interval '1 day',
              idle_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [idle.session.sessionId],
    );
    expect(await sessions.findActiveSession(idleToken.digest)).toBeNull();
    expect(
      (
        await sessions.rotateSession(
          rotationCommand(idleToken, newToken('idle-next'), ttlFromNow()),
        )
      ).kind,
    ).toBe('inactive');

    const revokedToken = newToken('revoked');
    const revoked = await signIn(subject('revoked'), revokedToken);
    await sessions.revokeSession({
      sessionId: revoked.session.sessionId,
      tenantId: revoked.identity.tenantId,
    });
    expect(await sessions.findActiveSession(revokedToken.digest)).toBeNull();
    expect(
      (
        await sessions.rotateSession(
          rotationCommand(revokedToken, newToken('revoked-next'), ttlFromNow()),
        )
      ).kind,
    ).toBe('inactive');
  });

  it('7. rotation atomically invalidates the old token', async () => {
    const current = newToken('rotate-1');
    const next = newToken('rotate-2');
    const provisioned = await signIn(subject('rotate'), current);

    const result = await sessions.rotateSession(rotationCommand(current, next, ttlFromNow()));
    expect(result.kind).toBe('rotated');
    if (result.kind !== 'rotated') {
      throw new Error('expected a rotated session');
    }
    expect(result.session.sessionId).not.toBe(provisioned.session.sessionId);
    expect(result.session.tenantId).toBe(provisioned.identity.tenantId);

    expect(await sessions.findActiveSession(current.digest)).toBeNull();
    expect(await sessions.findActiveSession(next.digest)).not.toBeNull();

    const old = await sessionRow(provisioned.session.sessionId);
    const fresh = await sessionRow(result.session.sessionId);
    expect(old.revoked_at).not.toBeNull();
    expect(old.revocation_reason).toBe('rotated');
    expect(fresh.revoked_at).toBeNull();
    expect(fresh.rotated_from_session_id).toBe(provisioned.session.sessionId);
    expect(Buffer.compare(fresh.token_digest, next.digest)).toBe(0);
  });

  it('8. concurrent refresh and replay never leave unauthorized active sessions', async () => {
    // 8a: two refreshes of the SAME digest. One wins, the loser detects replay and kills all.
    const shared = newToken('race-shared');
    const branchA = newToken('race-branch-a');
    const branchB = newToken('race-branch-b');
    const provisioned = await signIn(subject('race-double'), shared);
    const repoA = new PostgresB1ConsumerSessionRepository(poolA);
    const repoB = new PostgresB1ConsumerSessionRepository(poolB);

    let releaseDouble: () => void = () => undefined;
    const doubleGate = new Promise<void>((resolve) => {
      releaseDouble = resolve;
    });
    const doubleA = doubleGate.then(() =>
      repoA.rotateSession(rotationCommand(shared, branchA, ttlFromNow())),
    );
    const doubleB = doubleGate.then(() =>
      repoB.rotateSession(rotationCommand(shared, branchB, ttlFromNow())),
    );
    releaseDouble();
    const [left, right] = await Promise.all([doubleA, doubleB]);
    expect([left.kind, right.kind].sort()).toEqual(['reuse_detected', 'rotated']);
    expect(await activeSessions(provisioned.identity.consumerId)).toBe(0);

    // 8b: replay of an already-rotated token racing a refresh of the successor token.
    const original = newToken('race-original');
    const successor = newToken('race-successor');
    const replayAttempt = newToken('race-replay');
    const refreshAttempt = newToken('race-refresh');
    const second = await signIn(subject('race-refresh-vs-replay'), original);
    const firstRotation = await sessions.rotateSession(
      rotationCommand(original, successor, ttlFromNow()),
    );
    expect(firstRotation.kind).toBe('rotated');

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replay = gate.then(() =>
      repoA.rotateSession(rotationCommand(original, replayAttempt, ttlFromNow())),
    );
    const refresh = gate.then(() =>
      repoB.rotateSession(rotationCommand(successor, refreshAttempt, ttlFromNow())),
    );
    release();
    const [replayResult, refreshResult] = await Promise.all([replay, refresh]);
    expect(replayResult.kind).toBe('reuse_detected');
    expect(await activeSessions(second.identity.consumerId)).toBe(0);
    if (refreshResult.kind === 'rotated') {
      const row = await sessionRow(refreshResult.session.sessionId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revocation_reason).toBe('reuse_detected');
    }
    for (const token of [replayAttempt, refreshAttempt, successor, original]) {
      expect(await sessions.findActiveSession(token.digest)).toBeNull();
    }
  });

  it('9. reuse of a rotated token revokes every session of that Consumer', async () => {
    const firstToken = newToken('reuse-1');
    const secondToken = newToken('reuse-2');
    const rotatedToken = newToken('reuse-3');
    const providerSubject = subject('reuse');
    const provisioned = await signIn(providerSubject, firstToken);
    await signIn(providerSubject, secondToken);
    const rotation = await sessions.rotateSession(
      rotationCommand(firstToken, rotatedToken, ttlFromNow()),
    );
    expect(rotation.kind).toBe('rotated');
    expect(await activeSessions(provisioned.identity.consumerId)).toBe(2);

    const replay = await sessions.rotateSession(
      rotationCommand(firstToken, newToken('reuse-4'), ttlFromNow()),
    );
    expect(replay.kind).toBe('reuse_detected');
    expect(await activeSessions(provisioned.identity.consumerId)).toBe(0);

    const reasons = await db.pool.query<{ revocation_reason: string | null }>(
      'SELECT revocation_reason FROM consumer_sessions WHERE consumer_id = $1',
      [provisioned.identity.consumerId],
    );
    expect(reasons.rows.filter((row) => row.revocation_reason === 'reuse_detected')).toHaveLength(
      2,
    );
    expect(reasons.rows.filter((row) => row.revocation_reason === 'rotated')).toHaveLength(1);
    expect(await sessions.findActiveSession(secondToken.digest)).toBeNull();
    expect(await sessions.findActiveSession(rotatedToken.digest)).toBeNull();
  });

  it('10. logout is idempotent and revokes only the presented Session', async () => {
    const firstToken = newToken('logout-1');
    const secondToken = newToken('logout-2');
    const providerSubject = subject('logout');
    const provisioned = await signIn(providerSubject, firstToken);
    await signIn(providerSubject, secondToken);
    const command = {
      sessionId: provisioned.session.sessionId,
      tenantId: provisioned.identity.tenantId,
    };

    await sessions.revokeSession(command);
    const once = await sessionRow(command.sessionId);
    expect(once.revocation_reason).toBe('logout');
    await sessions.revokeSession(command);
    const twice = await sessionRow(command.sessionId);
    expect(twice.revoked_at?.getTime()).toBe(once.revoked_at?.getTime());
    expect(twice.revocation_reason).toBe('logout');

    expect(await sessions.findActiveSession(firstToken.digest)).toBeNull();
    expect(await sessions.findActiveSession(secondToken.digest)).not.toBeNull();
    await sessions.revokeSession({ sessionId: randomUUID(), tenantId: command.tenantId });
    expect(await sessions.findActiveSession(secondToken.digest)).not.toBeNull();
    expect(await activeSessions(provisioned.identity.consumerId)).toBe(1);
  });

  it('11. cross-tenant access is rejected', async () => {
    const tokenA = newToken('tenant-a');
    const tokenB = newToken('tenant-b');
    const a = await signIn(subject('tenant-a'), tokenA);
    const b = await signIn(subject('tenant-b'), tokenB);
    expect(a.identity.tenantId).not.toBe(b.identity.tenantId);

    const foundA = await sessions.findActiveSession(tokenA.digest);
    expect(foundA?.session.tenantId).toBe(a.identity.tenantId);
    expect(foundA?.principalId).not.toBe(b.identity.principalId);
    const foundB = await sessions.findActiveSession(tokenB.digest);
    expect(foundB?.session.tenantId).toBe(b.identity.tenantId);

    // A wrong tenant id makes the revoke a silent no-op in both directions.
    await sessions.revokeSession({ sessionId: a.session.sessionId, tenantId: b.identity.tenantId });
    await sessions.revokeSession({ sessionId: b.session.sessionId, tenantId: a.identity.tenantId });
    await sessions.revokeSession({ sessionId: a.session.sessionId, tenantId: randomUUID() });
    expect(await sessions.findActiveSession(tokenA.digest)).not.toBeNull();
    expect(await sessions.findActiveSession(tokenB.digest)).not.toBeNull();

    // The composite foreign key, not the repository, rejects a cross-tenant session row.
    await expect(
      db.pool.query(
        `INSERT INTO consumer_sessions
           (id, tenant_id, consumer_id, token_digest, expires_at, idle_expires_at)
         VALUES ($1, $2, $3, $4, clock_timestamp() + interval '1 day',
                 clock_timestamp() + interval '1 day')`,
        [randomUUID(), b.identity.tenantId, a.identity.consumerId, newToken('cross-tenant').digest],
      ),
    ).rejects.toBeDefined();
  });

  it('12. no raw token appears in persisted data or diagnostics', async () => {
    const token = newToken('raw-token');
    const provisioned = await signIn(subject('raw-token'), token);

    const stored = await sessionRow(provisioned.session.sessionId);
    expect(Buffer.compare(stored.token_digest, token.digest)).toBe(0);
    expect(stored.token_digest.toString('utf8')).not.toContain(token.raw);

    const dumped = await db.pool.query<{ payload: string }>(
      `SELECT coalesce(json_agg(payload)::text, '[]') AS payload
         FROM (
           SELECT to_jsonb(s) AS payload FROM consumer_sessions s WHERE s.consumer_id = $1
           UNION ALL SELECT to_jsonb(c) FROM consumers c WHERE c.id = $1
           UNION ALL SELECT to_jsonb(i) FROM consumer_identities i WHERE i.consumer_id = $1
           UNION ALL SELECT to_jsonb(t) FROM tenants t WHERE t.id = $2
           UNION ALL SELECT to_jsonb(p) FROM principals p WHERE p.tenant_id = $2
           UNION ALL SELECT to_jsonb(a) FROM agents a WHERE a.tenant_id = $2
           UNION ALL SELECT to_jsonb(v) FROM conversations v WHERE v.tenant_id = $2
         ) dump`,
      [provisioned.identity.consumerId, provisioned.identity.tenantId],
    );
    expect(dumped.rows[0]?.payload ?? '').not.toContain(token.raw);

    // A forced unique violation must not echo the offending bytea into a diagnostic.
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };
    const captured: string[] = [];
    const capture = (...args: unknown[]): void => {
      captured.push(args.map((value) => String(value)).join(' '));
    };
    let failure: unknown;
    try {
      console.log = capture;
      console.warn = capture;
      console.error = capture;
      console.info = capture;
      console.debug = capture;
      await sessions.findActiveSession(token.digest);
      await signIn(subject('raw-token-diagnostic'), token);
    } catch (error) {
      failure = error;
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
      console.info = originals.info;
      console.debug = originals.debug;
    }

    expect(isDomainError(failure)).toBe(true);
    if (!isDomainError(failure)) {
      throw new Error('expected a DomainError');
    }
    expect(failure.code).toBe('DB_UNAVAILABLE');
    expect(failure.diagnostic).not.toContain(token.raw);
    expect(failure.diagnostic).not.toContain(token.digest.toString('hex'));
    expect(JSON.stringify(failure.toJSON())).not.toContain(token.raw);
    expect(captured.join('\n')).not.toContain(token.raw);

    // A raw token (not a 32-byte digest) is rejected before it becomes a SQL parameter.
    await expect(sessions.findActiveSession(Buffer.from(token.raw, 'utf8'))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('13. idle expiry slides at most once per hour and never past the absolute TTL', async () => {
    const token = newToken('idle-slide');
    const provisioned = await signIn(subject('idle-slide'), token, ttlFromNow(30, 1));
    const before = await sessionRow(provisioned.session.sessionId);

    const first = await sessions.findActiveSession(token.digest);
    expect(first).not.toBeNull();
    const slid = await sessionRow(provisioned.session.sessionId);
    expect(slid.idle_expires_at.getTime() - before.idle_expires_at.getTime()).toBeGreaterThan(
      12 * DAY_MS,
    );
    expect(slid.idle_expires_at.getTime()).toBeLessThanOrEqual(slid.expires_at.getTime());

    await sessions.findActiveSession(token.digest);
    const again = await sessionRow(provisioned.session.sessionId);
    expect(again.idle_expires_at.getTime()).toBe(slid.idle_expires_at.getTime());
  });

  it('14. caller-supplied TTLs are clamped to 30 days absolute / 14 days idle on the DB clock', async () => {
    const token = newToken('clamped');
    const provisioned = await signIn(subject('clamped'), token, ttlFromNow(90, 60));
    const row = await sessionRow(provisioned.session.sessionId);

    expect(row.expires_at.getTime() - row.issued_at.getTime()).toBeLessThanOrEqual(
      B1_SESSION_ABSOLUTE_TTL_DAYS * DAY_MS + 5_000,
    );
    expect(row.idle_expires_at.getTime() - row.issued_at.getTime()).toBeLessThanOrEqual(
      B1_SESSION_IDLE_TTL_DAYS * DAY_MS + 5_000,
    );
    expect(row.idle_expires_at.getTime()).toBeLessThanOrEqual(row.expires_at.getTime());
    expect(await sessions.findActiveSession(token.digest)).not.toBeNull();
  });
});
