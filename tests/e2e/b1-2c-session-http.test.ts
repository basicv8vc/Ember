import { createHash, randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { B1MeResponseSchema, B1SessionResponseSchema } from '@ember/contracts';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication, startApiServer } from '../../apps/api/src/index.js';
import { APPLE_ISSUER } from '../../apps/api/src/auth/apple-identity.js';
import { PostgresB1MeProjectionReader } from '../../apps/api/src/auth/b1-me-projection-reader.js';
import { loadApiConfig } from '../../apps/api/src/env.js';
import { createLogger, type Logger } from '../../apps/api/src/logger.js';
import { loadDatabaseConfig, type DatabaseConfig } from '../../packages/postgres/src/index.js';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';

const APPLE_BUNDLE_ID = 'com.ember.mobile';
const APPLE_KEY_ID = 'local-b1-2c-fixture';

interface SessionDto {
  readonly access_token: string;
  readonly session_id: string;
  readonly consumer_id: string;
  readonly expires_at: string;
}

interface HttpContext {
  readonly baseUrl: string;
  readonly logger: Logger;
  readonly logLines: string[];
  readonly databaseConfig: DatabaseConfig;
}

function assertAddress(server: ServerType): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an internet socket listener');
  }
  return address;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not reserve a loopback port');
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function waitForListening(server: ServerType): Promise<void> {
  if (!server.listening) {
    await once(server, 'listening');
  }
  assertAddress(server);
}

async function closeServer(server: ServerType | undefined): Promise<void> {
  if (server === undefined || !server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  (server as HttpServer).closeAllConnections();
  await closed;
}

function testEnvironment(databaseUrl: string, port: number): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    EMBER_ENV: 'test',
    EMBER_HOST: '127.0.0.1',
    EMBER_PORT: String(port),
    EMBER_ALLOW_NON_LOOPBACK_BIND: 'false',
    EMBER_DEV_PROVIDER_ENABLED: 'true',
    EMBER_DEV_PROVIDER_ISOLATED: 'true',
    EMBER_APPLE_BUNDLE_ID: APPLE_BUNDLE_ID,
    DATABASE_URL: databaseUrl,
  };
}

describe('B1-2C: real HTTP session runtime on PostgreSQL 17', () => {
  let db: TestDatabase;
  let databaseConfig: DatabaseConfig;
  let appleKeyResolver: ReturnType<typeof createLocalJWKSet>;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let server: ServerType | undefined;
  let context: HttpContext;
  const logLines: string[] = [];
  const secrets = new Set<string>();

  function parseSessionDto(value: unknown): SessionDto {
    const session = B1SessionResponseSchema.parse(value);
    secrets.add(session.access_token);
    return session;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (testDatabaseUrl === undefined || testDatabaseUrl.length === 0) {
      throw new Error('TEST_DATABASE_URL is required');
    }

    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const publicJwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: APPLE_KEY_ID,
      alg: 'RS256',
      use: 'sig',
    };
    appleKeyResolver = createLocalJWKSet({ keys: [publicJwk] });

    const port = await availablePort();
    const env = testEnvironment(testDatabaseUrl, port);
    const apiConfig = loadApiConfig(env);
    databaseConfig = loadDatabaseConfig(env);
    const logger = createLogger({ level: 'debug', sink: (_level, line) => logLines.push(line) });
    server = startApiServer({
      pool: db.pool,
      apiConfig,
      databaseConfig,
      env,
      logger,
      appleKeyResolver,
    });
    await waitForListening(server);
    const address = assertAddress(server);
    expect(address.address).toBe('127.0.0.1');
    context = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      logger,
      logLines,
      databaseConfig,
    };

    const version = await db.pool.query<{ version: string }>('SELECT version() AS version');
    expect(version.rows[0]?.version).toMatch(/^PostgreSQL 17\./);
  }, 60_000);

  afterAll(async () => {
    await closeServer(server);
    await db?.close();
  });

  async function postSession(
    baseUrl: string,
    provider: 'apple' | 'dev',
    identityToken: string,
    nonce = `nonce-${randomUUID()}`,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    secrets.add(identityToken);
    secrets.add(nonce);
    return fetch(`${baseUrl}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ provider, identity_token: identityToken, nonce }),
    });
  }

  async function devSignIn(
    baseUrl: string,
    assertion = `dev-${randomUUID()}`,
  ): Promise<SessionDto> {
    secrets.add(assertion);
    const nonce = `dev-nonce-${randomUUID()}`;
    const response = await postSession(baseUrl, 'dev', assertion, nonce);
    expect(response.status).toBe(201);
    return parseSessionDto(await response.json());
  }

  async function getMe(baseUrl: string, token: string, headers: Record<string, string> = {}) {
    secrets.add(token);
    return fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
  }

  async function countForTenant(table: string, tenantId: string): Promise<number> {
    const result = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(result.rows[0]?.total ?? '0');
  }

  async function appleAssertion(subject: string, nonce: string): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const nonceClaim = createHash('sha256').update(nonce, 'utf8').digest('hex');
    const token = await new SignJWT({ nonce: nonceClaim })
      .setProtectedHeader({ alg: 'RS256', kid: APPLE_KEY_ID })
      .setIssuer(APPLE_ISSUER)
      .setAudience(APPLE_BUNDLE_ID)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    secrets.add(token);
    secrets.add(nonce);
    secrets.add(subject);
    return token;
  }

  async function createDirectServer(env: NodeJS.ProcessEnv, bindHost: string): Promise<ServerType> {
    const apiConfig = loadApiConfig(env);
    const actualListener: { server?: ServerType } = {};
    const app = createApiApplication({
      pool: db.pool,
      apiConfig,
      databaseConfig: loadDatabaseConfig(env),
      env,
      logger: context.logger,
      actualListener: () => actualListener.server?.address() ?? null,
      appleKeyResolver,
    });
    const directServer = serve({
      fetch: app.fetch,
      hostname: bindHost,
      port: apiConfig.port,
    });
    actualListener.server = directServer;
    await waitForListening(directServer);
    return directServer;
  }

  it('provisions on real loopback HTTP, verifies local Apple JWT/JWKS and survives an API restart', async () => {
    const assertion = `dev-identity-${randomUUID()}`;
    const first = await devSignIn(context.baseUrl, assertion);
    const second = await devSignIn(context.baseUrl, assertion);
    expect(second.consumer_id).toBe(first.consumer_id);
    expect(second.session_id).not.toBe(first.session_id);
    expect(first.access_token).not.toBe(second.access_token);

    const graph = await db.pool.query<{
      tenant_id: string;
      principal_id: string;
      session_count: string;
    }>(
      `SELECT c.tenant_id,
              c.principal_id,
              (SELECT count(*)::text FROM consumer_sessions s WHERE s.consumer_id = c.id) AS session_count
         FROM consumers c
        WHERE c.id = $1`,
      [first.consumer_id],
    );
    expect(graph.rows).toHaveLength(1);
    const graphRow = graph.rows[0]!;
    expect(Number(graphRow.session_count)).toBe(2);
    const tenantCount = await db.pool.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM tenants WHERE id = $1',
      [graphRow.tenant_id],
    );
    expect(Number(tenantCount.rows[0]?.total)).toBe(1);
    for (const table of ['principals', 'consumers', 'agents', 'conversations']) {
      expect(await countForTenant(table, graphRow.tenant_id)).toBe(1);
    }

    const firstMeResponse = await getMe(context.baseUrl, first.access_token);
    expect(
      firstMeResponse.status,
      JSON.stringify({
        body: await firstMeResponse.clone().text(),
        recentLogs: logLines.slice(-8),
      }),
    ).toBe(200);
    const firstMe = B1MeResponseSchema.parse(await firstMeResponse.json());
    expect(firstMe.consumer_id).toBe(first.consumer_id);
    expect(firstMe.agent.display_name).toBe('Ember');
    expect(firstMe.conversation.transcript_epoch).toBe(0);
    expect(await new PostgresB1MeProjectionReader(db.pool).getMeForTenant(randomUUID())).toBeNull();

    const appleNonce = `apple-nonce-${randomUUID()}`;
    const appleSubject = `apple-subject-${randomUUID()}`;
    const appleToken = await appleAssertion(appleSubject, appleNonce);
    const appleResponse = await postSession(context.baseUrl, 'apple', appleToken, appleNonce);
    expect(appleResponse.status).toBe(201);
    const appleSession = parseSessionDto(await appleResponse.json());
    expect(appleSession.consumer_id).not.toBe(first.consumer_id);
    const appleMe = await getMe(context.baseUrl, appleSession.access_token);
    expect(appleMe.status).toBe(200);
    const appleProjection = B1MeResponseSchema.parse(await appleMe.json());
    expect(appleProjection.consumer_id).toBe(appleSession.consumer_id);
    expect(appleProjection.conversation.conversation_id).not.toBe(
      firstMe.conversation.conversation_id,
    );

    const wrongNonce = `wrong-nonce-${randomUUID()}`;
    const invalidAppleToken = await appleAssertion(
      `invalid-${randomUUID()}`,
      `right-${wrongNonce}`,
    );
    const invalidApple = await postSession(context.baseUrl, 'apple', invalidAppleToken, wrongNonce);
    expect(invalidApple.status).toBe(401);

    // No caller-supplied tenant scope can alter the identity selected by the session token.
    const crossTenantQuery = await getMe(context.baseUrl, first.access_token, {
      'x-tenant-id': graphRow.tenant_id,
    });
    expect(crossTenantQuery.status).toBe(400);
    const queryScope = await fetch(
      `${context.baseUrl}/v1/me?tenant_id=${encodeURIComponent(graphRow.tenant_id)}`,
      { headers: { authorization: `Bearer ${first.access_token}` } },
    );
    expect(queryScope.status).toBe(400);

    // Session credentials remain separate from legacy Task/Agent authentication.
    const legacyTask = await fetch(`${context.baseUrl}/v1/tasks/${randomUUID()}`, {
      headers: { authorization: `Bearer ${first.access_token}` },
    });
    expect(legacyTask.status).toBe(401);

    await closeServer(server);
    const newPort = await availablePort();
    const env = testEnvironment(process.env.TEST_DATABASE_URL!, newPort);
    const apiConfig = loadApiConfig(env);
    const logger = context.logger;
    server = startApiServer({
      pool: db.pool,
      apiConfig,
      databaseConfig,
      env,
      logger,
      appleKeyResolver,
    });
    await waitForListening(server);
    const address = assertAddress(server);
    context = { ...context, baseUrl: `http://127.0.0.1:${address.port}` };

    const afterRestart = await getMe(context.baseUrl, first.access_token);
    expect(afterRestart.status).toBe(200);
    expect(B1MeResponseSchema.parse(await afterRestart.json())).toEqual(firstMe);

    const malformed = await getMe(context.baseUrl, 'ems_bad');
    expect(malformed.status).toBe(401);
    const rawAppleSubject = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM consumer_identities
        WHERE provider = 'apple' AND provider_subject = $1`,
      [appleSubject],
    );
    expect(Number(rawAppleSubject.rows[0]?.total)).toBe(1);
  }, 60_000);

  it('rotated-token reuse on protected reads and refresh revokes every Consumer session', async () => {
    const readAssertion = `read-replay-${randomUUID()}`;
    const readFirst = await devSignIn(context.baseUrl, readAssertion);
    const readSecond = await devSignIn(context.baseUrl, readAssertion);
    const refreshed = await fetch(`${context.baseUrl}/v1/auth/session/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readFirst.access_token}` },
    });
    expect(refreshed.status).toBe(200);
    const readSuccessor = parseSessionDto(await refreshed.json());
    expect(readSuccessor.access_token).not.toBe(readFirst.access_token);

    expect((await getMe(context.baseUrl, readFirst.access_token)).status).toBe(401);
    expect((await getMe(context.baseUrl, readSecond.access_token)).status).toBe(401);
    expect((await getMe(context.baseUrl, readSuccessor.access_token)).status).toBe(401);

    const refreshAssertion = `refresh-replay-${randomUUID()}`;
    const refreshFirst = await devSignIn(context.baseUrl, refreshAssertion);
    const refreshSecond = await devSignIn(context.baseUrl, refreshAssertion);
    const firstRefresh = await fetch(`${context.baseUrl}/v1/auth/session/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${refreshFirst.access_token}` },
    });
    expect(firstRefresh.status).toBe(200);
    const refreshSuccessor = parseSessionDto(await firstRefresh.json());
    const replayRefresh = await fetch(`${context.baseUrl}/v1/auth/session/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${refreshFirst.access_token}` },
    });
    expect(replayRefresh.status).toBe(401);
    expect((await getMe(context.baseUrl, refreshSecond.access_token)).status).toBe(401);
    expect((await getMe(context.baseUrl, refreshSuccessor.access_token)).status).toBe(401);
  });

  it('returns no token and commits no identity graph when session persistence fails', async () => {
    const assertion = `rollback-${randomUUID()}`;
    const providerSubject = `dev:${createHash('sha256').update(assertion).digest('hex')}`;
    const before = await db.pool.query<{
      tenants: string;
      principals: string;
      consumers: string;
      identities: string;
      agents: string;
      conversations: string;
      sessions: string;
    }>(`SELECT
       (SELECT count(*)::text FROM tenants) AS tenants,
       (SELECT count(*)::text FROM principals) AS principals,
       (SELECT count(*)::text FROM consumers) AS consumers,
       (SELECT count(*)::text FROM consumer_identities) AS identities,
       (SELECT count(*)::text FROM agents) AS agents,
       (SELECT count(*)::text FROM conversations) AS conversations,
       (SELECT count(*)::text FROM consumer_sessions) AS sessions`);

    await db.pool.query(`
      CREATE FUNCTION b1_2c_fail_session_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected session insert failure';
      END;
      $$
    `);
    await db.pool.query(`
      CREATE TRIGGER b1_2c_fail_session_insert
      BEFORE INSERT ON consumer_sessions
      FOR EACH ROW EXECUTE FUNCTION b1_2c_fail_session_insert()
    `);

    try {
      const response = await postSession(context.baseUrl, 'dev', assertion);
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('access_token');
      expect(body).not.toHaveProperty('session_id');

      const identity = await db.pool.query(
        'SELECT id FROM consumer_identities WHERE provider = $1 AND provider_subject = $2',
        ['dev', providerSubject],
      );
      expect(identity.rows).toHaveLength(0);
      const after = await db.pool.query(`SELECT
         (SELECT count(*)::text FROM tenants) AS tenants,
         (SELECT count(*)::text FROM principals) AS principals,
         (SELECT count(*)::text FROM consumers) AS consumers,
         (SELECT count(*)::text FROM consumer_identities) AS identities,
         (SELECT count(*)::text FROM agents) AS agents,
         (SELECT count(*)::text FROM conversations) AS conversations,
         (SELECT count(*)::text FROM consumer_sessions) AS sessions`);
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      await db.pool.query('DROP TRIGGER b1_2c_fail_session_insert ON consumer_sessions');
      await db.pool.query('DROP FUNCTION b1_2c_fail_session_insert()');
    }
  });

  it('keeps logout idempotent while treating a rotated token as replay', async () => {
    const normalAssertion = `logout-normal-${randomUUID()}`;
    const normalFirst = await devSignIn(context.baseUrl, normalAssertion);
    const normalSecond = await devSignIn(context.baseUrl, normalAssertion);
    const firstLogout = await fetch(`${context.baseUrl}/v1/auth/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${normalFirst.access_token}` },
    });
    const repeatedLogout = await fetch(`${context.baseUrl}/v1/auth/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${normalFirst.access_token}` },
    });
    expect(firstLogout.status).toBe(204);
    expect(repeatedLogout.status).toBe(204);
    expect((await getMe(context.baseUrl, normalSecond.access_token)).status).toBe(200);

    const replayAssertion = `logout-replay-${randomUUID()}`;
    const replayFirst = await devSignIn(context.baseUrl, replayAssertion);
    const replaySecond = await devSignIn(context.baseUrl, replayAssertion);
    const rotate = await fetch(`${context.baseUrl}/v1/auth/session/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${replayFirst.access_token}` },
    });
    expect(rotate.status).toBe(200);
    const successor = parseSessionDto(await rotate.json());
    const replayLogout = await fetch(`${context.baseUrl}/v1/auth/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${replayFirst.access_token}` },
    });
    expect(replayLogout.status).toBe(401);
    expect((await getMe(context.baseUrl, replaySecond.access_token)).status).toBe(401);
    expect((await getMe(context.baseUrl, successor.access_token)).status).toBe(401);

    const missing = await fetch(`${context.baseUrl}/v1/auth/session/refresh`, { method: 'POST' });
    expect(missing.status).toBe(401);
  });

  it('requires every R-9 guard and ignores a forged Host on an actual non-loopback bind', async () => {
    const dbUrl = process.env.TEST_DATABASE_URL!;

    const noOptInPort = await availablePort();
    const noOptInEnv = testEnvironment(dbUrl, noOptInPort);
    noOptInEnv.EMBER_DEV_PROVIDER_ENABLED = 'false';
    const noOptInServer = await createDirectServer(noOptInEnv, '127.0.0.1');
    try {
      const noOptInAddress = assertAddress(noOptInServer);
      const denied = await postSession(
        `http://127.0.0.1:${noOptInAddress.port}`,
        'dev',
        `missing-opt-in-${randomUUID()}`,
      );
      expect(denied.status).toBe(404);
    } finally {
      await closeServer(noOptInServer);
    }

    const isolatedPort = await availablePort();
    const isolatedEnv = testEnvironment(dbUrl, isolatedPort);
    isolatedEnv.EMBER_DEV_PROVIDER_ISOLATED = 'false';
    const isolatedServer = await createDirectServer(isolatedEnv, '127.0.0.1');
    try {
      const isolatedAddress = assertAddress(isolatedServer);
      const denied = await postSession(
        `http://127.0.0.1:${isolatedAddress.port}`,
        'dev',
        `not-isolated-${randomUUID()}`,
      );
      expect(denied.status).toBe(404);
    } finally {
      await closeServer(isolatedServer);
    }

    const wildcardPort = await availablePort();
    const wildcardEnv = testEnvironment(dbUrl, wildcardPort);
    const wildcardServer = await createDirectServer(wildcardEnv, '0.0.0.0');
    try {
      const wildcardAddress = assertAddress(wildcardServer);
      expect(wildcardAddress.address).toBe('0.0.0.0');
      const denied = await postSession(
        `http://127.0.0.1:${wildcardAddress.port}`,
        'dev',
        `forged-host-${randomUUID()}`,
        `forged-nonce-${randomUUID()}`,
        { host: `localhost:${wildcardAddress.port}` },
      );
      expect(denied.status).toBe(404);
    } finally {
      await closeServer(wildcardServer);
    }
  });

  it('does not log credentials, provider assertions, nonce values or SQL input values', async () => {
    const assertion = `sensitive-provider-assertion-${randomUUID()}`;
    const nonce = `sensitive-nonce-${randomUUID()}`;
    const response = await postSession(context.baseUrl, 'dev', assertion, nonce);
    expect(response.status).toBe(201);
    parseSessionDto(await response.json());

    const appleNonce = `sensitive-apple-nonce-${randomUUID()}`;
    const appleSubject = `sensitive-apple-subject-${randomUUID()}`;
    const appleToken = await appleAssertion(appleSubject, appleNonce);
    expect((await postSession(context.baseUrl, 'apple', appleToken, appleNonce)).status).toBe(201);

    const serializedLogs = logLines.join('\n');
    for (const secret of secrets) {
      expect(serializedLogs).not.toContain(secret);
    }
    expect(serializedLogs).not.toContain('SELECT ');
    expect(serializedLogs).not.toContain('INSERT ');
    expect(serializedLogs).not.toContain('provider_subject');
  });
});
