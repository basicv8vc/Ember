import { createHash, randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication, startApiServer } from '../../apps/api/src/index.js';
import { APPLE_ISSUER } from '../../apps/api/src/auth/apple-identity.js';
import { loadApiConfig } from '../../apps/api/src/env.js';
import { createLogger, type Logger } from '../../apps/api/src/logger.js';
import { loadDatabaseConfig } from '../../packages/postgres/src/index.js';
import { createTestDatabase, type TestDatabase } from '../integration/support/database.js';

/**
 * PostgreSQL 17 HTTP E2E for shared (staging / production) deployments.
 *
 * The b1-2c suite proves the auth stack works on a developer run; this suite proves the
 * *same stack refuses every development surface* once the deployment is shared:
 *
 * 1. the API boots under `EMBER_ENV=production` / `EMBER_ENV=staging` with a real database —
 *    including with developer credentials left in the environment (the old
 *    `loadDevAuthConfig()` threw unconditionally on `NODE_ENV=production`, so a shared boot
 *    was impossible);
 * 2. dev sign-in (`provider: "dev"`) is not advertised: one fixed 404, byte-identical to an
 *    unknown route;
 * 3. a legacy `EMBER_DEV_AUTH_TENANT_*` bearer token cannot authenticate anything;
 * 4. a forged Apple assertion is rejected with one fixed 401 that echoes nothing;
 * 5. no user-data route answers without a valid credential;
 * 6. a genuine assertion still works, so the refusals above are refusals and not breakage;
 * 7. no environment variable can re-open a development surface: a boot that enables the
 *    dev provider is refused outright.
 */

const APPLE_BUNDLE_ID = 'com.ember.mobile';
const APPLE_KEY_ID = 'local-shared-deployment-fixture';

/** Plausible legacy dev bearer tokens. They must never authenticate anywhere. */
const DEV_TOKEN_A = 'legacy-dev-bearer-token-A-0123456789abcd';
const DEV_TOKEN_B = 'legacy-dev-bearer-token-B-0123456789abcd';

interface BootedApi {
  readonly baseUrl: string;
  readonly server: ServerType;
  readonly logLines: string[];
}

interface DeploymentCase {
  readonly name: 'production' | 'staging';
  readonly env: (databaseUrl: string, port: number) => NodeJS.ProcessEnv;
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

/**
 * A shared-deployment environment. The developer bearer variables are deliberately present:
 * a shared boot must start anyway, ignore their *values*, and reject the tokens at runtime.
 */
function sharedEnvironment(
  deployment: 'production' | 'staging',
  databaseUrl: string,
  port: number,
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: deployment,
    EMBER_ENV: deployment,
    EMBER_HOST: '127.0.0.1',
    EMBER_PORT: String(port),
    EMBER_ALLOW_NON_LOOPBACK_BIND: 'false',
    EMBER_LOG_LEVEL: 'debug',
    EMBER_APPLE_BUNDLE_ID: APPLE_BUNDLE_ID,
    DATABASE_URL: databaseUrl,
    // Hostile leftovers from a developer machine: inert here, never loaded.
    EMBER_DEV_AUTH_TENANT_A_TOKEN: DEV_TOKEN_A,
    EMBER_DEV_AUTH_TENANT_A_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    EMBER_DEV_AUTH_TENANT_A_PRINCIPAL_ID: '22222222-2222-4222-8222-222222222222',
    EMBER_DEV_AUTH_TENANT_B_TOKEN: DEV_TOKEN_B,
    EMBER_DEV_AUTH_TENANT_B_TENANT_ID: '33333333-3333-4333-8333-333333333333',
    EMBER_DEV_AUTH_TENANT_B_PRINCIPAL_ID: '44444444-4444-4444-8444-444444444444',
  };
}

const DEPLOYMENT_CASES: readonly DeploymentCase[] = Object.freeze([
  { name: 'production', env: (url, port) => sharedEnvironment('production', url, port) },
  { name: 'staging', env: (url, port) => sharedEnvironment('staging', url, port) },
]);

describe('shared deployment security on PostgreSQL 17 (HTTP)', () => {
  let db: TestDatabase;
  let appleKeyResolver: ReturnType<typeof createLocalJWKSet>;
  let applePrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let attackerPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  const secrets = new Set<string>();

  function trackSecret(value: string): string {
    secrets.add(value);
    return value;
  }

  async function appleAssertion(
    subject: string,
    nonce: string,
    overrides: {
      key?: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
      issuer?: string;
      audience?: string;
      nonceClaim?: string;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const nonceClaim =
      overrides.nonceClaim ?? createHash('sha256').update(nonce, 'utf8').digest('hex');
    const token = await new SignJWT({ nonce: nonceClaim })
      .setProtectedHeader({ alg: 'RS256', kid: APPLE_KEY_ID })
      .setIssuer(overrides.issuer ?? APPLE_ISSUER)
      .setAudience(overrides.audience ?? APPLE_BUNDLE_ID)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(overrides.key ?? applePrivateKey);
    trackSecret(token);
    trackSecret(nonce);
    trackSecret(subject);
    return token;
  }

  async function postSession(
    baseUrl: string,
    provider: 'apple' | 'dev',
    identityToken: string,
    nonce: string,
  ): Promise<Response> {
    trackSecret(identityToken);
    trackSecret(nonce);
    return fetch(`${baseUrl}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, identity_token: identityToken, nonce }),
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (testDatabaseUrl === undefined || testDatabaseUrl.length === 0) {
      throw new Error('TEST_DATABASE_URL is required');
    }

    const version = await db.pool.query<{ version: string }>('SELECT version() AS version');
    expect(version.rows[0]?.version).toMatch(/^PostgreSQL 17\./);

    const keys = await generateKeyPair('RS256');
    applePrivateKey = keys.privateKey;
    attackerPrivateKey = (await generateKeyPair('RS256')).privateKey;
    const publicJwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: APPLE_KEY_ID,
      alg: 'RS256',
      use: 'sig',
    };
    appleKeyResolver = createLocalJWKSet({ keys: [publicJwk] });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  for (const deployment of DEPLOYMENT_CASES) {
    describe(`${deployment.name} deployment`, () => {
      let api: BootedApi;
      let databaseUrl: string;

      beforeAll(async () => {
        const url = process.env.TEST_DATABASE_URL;
        if (url === undefined || url.length === 0) {
          throw new Error('TEST_DATABASE_URL is required');
        }
        databaseUrl = url;

        const port = await availablePort();
        const env = deployment.env(databaseUrl, port);
        const apiConfig = loadApiConfig(env);
        const logLines: string[] = [];
        const logger: Logger = createLogger({
          level: 'debug',
          sink: (_level, line) => {
            logLines.push(line);
          },
        });
        const server = startApiServer({
          pool: db.pool,
          apiConfig,
          databaseConfig: loadDatabaseConfig(env),
          env,
          logger,
          appleKeyResolver,
        });
        await waitForListening(server);
        const address = assertAddress(server);
        api = {
          baseUrl: `http://127.0.0.1:${address.port}`,
          server,
          logLines,
        };
      }, 60_000);

      afterAll(async () => {
        await closeServer(api?.server);
      });

      it('boots against real PostgreSQL 17 and serves health and readiness', async () => {
        const health = await fetch(`${api.baseUrl}/healthz`);
        expect(health.status).toBe(200);
        expect(((await health.json()) as { status: string }).status).toBe('ok');

        const ready = await fetch(`${api.baseUrl}/readyz`);
        expect(ready.status).toBe(200);
        expect(((await ready.json()) as { status: string }).status).toBe('ready');
      });

      it('ignores developer bearer variables in the environment and logs names only', () => {
        const ignored = api.logLines.find((line) =>
          line.includes('ignoring dev tenant credential variables'),
        );
        expect(ignored).toBeDefined();
        // The names are operator guidance; the values are never printed.
        expect(ignored).toContain('EMBER_DEV_AUTH_TENANT_A_TOKEN');
        expect(ignored).toContain('EMBER_DEV_AUTH_TENANT_B_TOKEN');
        expect(ignored).not.toContain(DEV_TOKEN_A);
        expect(ignored).not.toContain(DEV_TOKEN_B);
      });

      it('does not advertise dev sign-in: one fixed 404, identical to an unknown route', async () => {
        const unknown = await fetch(`${api.baseUrl}/v1/definitely-not-a-route`);
        expect(unknown.status).toBe(404);
        const unknownBody = (await unknown.json()) as { error: { code: string; message: string } };

        const response = await postSession(
          api.baseUrl,
          'dev',
          trackSecret(`dev-identity-${randomUUID()}`),
          trackSecret(`dev-nonce-${randomUUID()}`),
        );
        expect(response.status).toBe(404);
        const body = (await response.json()) as { error: { code: string; message: string } };

        expect(body.error.code).toBe('NOT_FOUND');
        expect(body.error.code).toBe(unknownBody.error.code);
        expect(body.error.message).toBe(unknownBody.error.message);
      });

      it('rejects every legacy dev bearer token on session and tenant routes', async () => {
        for (const token of [DEV_TOKEN_A, DEV_TOKEN_B]) {
          trackSecret(token);

          // Session surface: a dev bearer token is not an `ems_` session credential.
          const me = await fetch(`${api.baseUrl}/v1/me`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(me.status).toBe(401);

          // Legacy tenant surface: the digest map is empty, so nothing resolves.
          const agent = await fetch(`${api.baseUrl}/v1/agents/${trackSecret(randomUUID())}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(agent.status).toBe(401);
        }
      });

      it('rejects forged Apple assertions with one fixed 401 that echoes nothing', async () => {
        const nonce = trackSecret(`nonce-${randomUUID()}`);
        const forgeries: readonly { name: string; token: string }[] = [
          {
            name: 'not a JWS at all',
            token: trackSecret('this-is-not-a-jwt'),
          },
          {
            name: 'signed by an attacker key but tagged with the trusted kid',
            token: await appleAssertion(trackSecret(`sub-${randomUUID()}`), nonce, {
              key: attackerPrivateKey,
            }),
          },
          {
            name: 'signed by the trusted key with the wrong issuer',
            token: await appleAssertion(trackSecret(`sub-${randomUUID()}`), nonce, {
              issuer: 'https://attacker.example',
            }),
          },
          {
            name: 'signed by the trusted key with the wrong audience',
            token: await appleAssertion(trackSecret(`sub-${randomUUID()}`), nonce, {
              audience: 'com.attacker.app',
            }),
          },
          {
            name: 'signed by the trusted key with a mismatched nonce claim',
            token: await appleAssertion(trackSecret(`sub-${randomUUID()}`), nonce, {
              nonceClaim: createHash('sha256')
                .update(trackSecret(`other-nonce-${randomUUID()}`), 'utf8')
                .digest('hex'),
            }),
          },
        ];

        for (const forgery of forgeries) {
          const response = await postSession(api.baseUrl, 'apple', forgery.token, nonce);
          expect(response.status, forgery.name).toBe(401);
          const raw = await response.text();
          expect(raw, forgery.name).not.toContain(forgery.token);
          expect(raw, forgery.name).toContain('"UNAUTHENTICATED"');
        }
      });

      it('answers 401 on every user-data route without a valid credential', async () => {
        const conversationId = trackSecret(randomUUID());
        const submissionId = trackSecret(randomUUID());
        const turnId = trackSecret(randomUUID());

        const routes: readonly { method: string; path: string; body?: string }[] = [
          { method: 'GET', path: '/v1/me' },
          { method: 'GET', path: `/v1/conversations/${conversationId}/messages` },
          {
            method: 'POST',
            path: `/v1/conversations/${conversationId}/messages`,
            body: JSON.stringify({ content: trackSecret('hidden user content') }),
          },
          { method: 'GET', path: `/v1/message-submissions/${submissionId}` },
          { method: 'GET', path: `/v1/conversations/${conversationId}/turns/${turnId}` },
          {
            method: 'POST',
            path: `/v1/conversations/${conversationId}/turns/${turnId}/cancel`,
          },
        ];

        for (const route of routes) {
          // (a) no credential at all
          const anonymous = await fetch(`${api.baseUrl}${route.path}`, {
            method: route.method,
            ...(route.body === undefined
              ? {}
              : {
                  headers: { 'content-type': 'application/json' },
                  body: route.body,
                }),
          });
          expect(anonymous.status, `${route.method} ${route.path} anonymous`).toBe(401);

          // (b) a well-formed but unknown session token
          const unknownSession = await fetch(`${api.baseUrl}${route.path}`, {
            method: route.method,
            headers: {
              authorization: `Bearer ${trackSecret(`ems_${'A'.repeat(43)}`)}`,
              ...(route.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(route.body === undefined ? {} : { body: route.body }),
          });
          expect(unknownSession.status, `${route.method} ${route.path} unknown token`).toBe(401);
        }
      });

      it('still serves a genuine Apple session end to end (the refusals are refusals, not breakage)', async () => {
        const subject = trackSecret(`apple-sub-${randomUUID()}`);
        const nonce = trackSecret(`nonce-${randomUUID()}`);
        const identityToken = await appleAssertion(subject, nonce);

        const response = await postSession(api.baseUrl, 'apple', identityToken, nonce);
        expect(response.status).toBe(201);
        const session = (await response.json()) as { access_token: string; session_id: string };
        trackSecret(session.access_token);
        trackSecret(session.session_id);

        const me = await fetch(`${api.baseUrl}/v1/me`, {
          headers: { authorization: `Bearer ${session.access_token}` },
        });
        expect(me.status).toBe(200);

        // The genuine session token is never written to the process log.
        for (const line of api.logLines) {
          expect(line).not.toContain(session.access_token);
          expect(line).not.toContain(identityToken);
        }
      });
    });
  }

  describe('no environment variable can re-open a development surface', () => {
    function sharedBootEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
      return {
        EMBER_HOST: '127.0.0.1',
        EMBER_PORT: String(1 + Math.floor(Math.random() * 1000) + 20_000),
        EMBER_ALLOW_NON_LOOPBACK_BIND: 'false',
        EMBER_APPLE_BUNDLE_ID: APPLE_BUNDLE_ID,
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
        ...overrides,
      };
    }

    function expectBootRefusal(overrides: Record<string, string>): void {
      const env = sharedBootEnv(overrides);
      const logLines: string[] = [];
      const logger = createLogger({
        level: 'debug',
        sink: (_level, line) => {
          logLines.push(line);
        },
      });

      expect(
        () =>
          createApiApplication({
            pool: db.pool,
            apiConfig: loadApiConfig(env),
            databaseConfig: loadDatabaseConfig(env),
            env,
            logger,
            actualListener: () => null,
            appleKeyResolver,
          }),
        JSON.stringify(overrides),
      ).toThrow(/refusing to start/);
    }

    it('refuses to boot when the dev provider opt-in is combined with any shared marker', () => {
      expectBootRefusal({
        NODE_ENV: 'production',
        EMBER_ENV: 'production',
        EMBER_DEV_PROVIDER_ENABLED: 'true',
        EMBER_DEV_PROVIDER_ISOLATED: 'true',
      });
      expectBootRefusal({
        NODE_ENV: 'staging',
        EMBER_ENV: 'staging',
        EMBER_DEV_PROVIDER_ENABLED: 'true',
        EMBER_DEV_PROVIDER_ISOLATED: 'true',
      });
      // A marker that lies about the run cannot downgrade the classification.
      expectBootRefusal({
        NODE_ENV: 'development',
        EMBER_ENV: 'production',
        EMBER_DEV_PROVIDER_ENABLED: 'true',
      });
      expectBootRefusal({
        NODE_ENV: 'test',
        EMBER_ENV: 'staging',
        EMBER_DEV_PROVIDER_ENABLED: 'true',
      });
    });

    it('boots a shared deployment that leaves the dev provider off', () => {
      const env = sharedBootEnv({ NODE_ENV: 'production', EMBER_ENV: 'production' });
      const logger = createLogger({ level: 'error', sink: () => undefined });
      const app = createApiApplication({
        pool: db.pool,
        apiConfig: loadApiConfig(env),
        databaseConfig: loadDatabaseConfig(env),
        env,
        logger,
        actualListener: () => null,
        appleKeyResolver,
      });
      expect(app).toBeDefined();
    });
  });
});
