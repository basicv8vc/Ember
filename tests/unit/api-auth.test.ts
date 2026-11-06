import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import {
  AUTH_FAILURE_REASONS,
  createDevTokenAuthenticator,
  parseBearerToken,
} from '../../apps/api/src/auth/bearer-authenticator.js';
import { DevAuthConfigError, loadDevAuthConfig } from '../../apps/api/src/auth/dev-auth-config.js';

/**
 * P0B-07a authentication boundary: configuration parsing, token verification and the
 * `/v1`-scoped middleware that ties them to the app.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const PRINCIPAL_A = randomUUID();
const PRINCIPAL_B = randomUUID();
const TOKEN_A = `token-a-${randomUUID()}`;
const TOKEN_B = `token-b-${randomUUID()}`;

type Env = Record<string, string | undefined>;

function slotEnv(
  slot: 'A' | 'B',
  fields: { token?: string; tenantId?: string; principalId?: string; policyVersion?: string },
): Env {
  const prefix = `EMBER_DEV_AUTH_TENANT_${slot}_`;
  const env: Env = {};

  if (fields.token !== undefined) {
    env[`${prefix}TOKEN`] = fields.token;
  }
  if (fields.tenantId !== undefined) {
    env[`${prefix}TENANT_ID`] = fields.tenantId;
  }
  if (fields.principalId !== undefined) {
    env[`${prefix}PRINCIPAL_ID`] = fields.principalId;
  }
  if (fields.policyVersion !== undefined) {
    env[`${prefix}POLICY_VERSION`] = fields.policyVersion;
  }

  return env;
}

function twoTenants(): Env {
  return {
    ...slotEnv('A', { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A }),
    ...slotEnv('B', { token: TOKEN_B, tenantId: TENANT_B, principalId: PRINCIPAL_B }),
  };
}

/** A development run with no slot configured: valid, and every request fails closed. */
const EMPTY_DEV_AUTH = {
  tenants: [],
  disabled: false,
  disabledBy: null,
  ignoredVariables: [],
} as const;

function catchConfigError(env: Env): DevAuthConfigError {
  try {
    loadDevAuthConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(DevAuthConfigError);
    return error as DevAuthConfigError;
  }

  throw new Error('expected loadDevAuthConfig to reject this environment');
}

describe('loadDevAuthConfig', () => {
  it('parses independent tenant slots and defaults the policy version', () => {
    const config = loadDevAuthConfig(twoTenants());

    expect(config.tenants).toHaveLength(2);
    expect(config.tenants[0]).toMatchObject({
      token: TOKEN_A,
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      policyVersion: 1,
    });
    expect(config.tenants[1]).toMatchObject({ token: TOKEN_B, tenantId: TENANT_B });
  });

  it('honours an explicit policy version', () => {
    const config = loadDevAuthConfig(
      slotEnv('A', {
        token: TOKEN_A,
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        policyVersion: '7',
      }),
    );

    expect(config.tenants[0]?.policyVersion).toBe(7);
  });

  it('treats a fully unconfigured environment as valid and empty (fail closed)', () => {
    expect(loadDevAuthConfig({})).toEqual(EMPTY_DEV_AUTH);
    expect(loadDevAuthConfig({ UNRELATED: 'value' })).toEqual(EMPTY_DEV_AUTH);
  });

  it('treats blank values as unset', () => {
    expect(loadDevAuthConfig(slotEnv('A', { token: '   ' }))).toEqual(EMPTY_DEV_AUTH);
  });

  it('keeps dev tokens inert instead of failing to start in staging and production', () => {
    // The previous behaviour was an unconditional throw on `NODE_ENV=production`, which made a
    // production boot impossible even with no dev credentials at all. The refusal is now scoped
    // to the credential material: a shared deployment starts, parses nothing and reports the
    // *names* it refused.
    for (const [env, disabledBy] of [
      [{ NODE_ENV: 'production' }, 'NODE_ENV=production'],
      [{ NODE_ENV: 'staging' }, 'NODE_ENV=staging'],
      [{ EMBER_ENV: 'production' }, 'EMBER_ENV=production'],
      [{ EMBER_ENV: 'staging' }, 'EMBER_ENV=staging'],
      // The outer marker wins on a conflict, so `EMBER_ENV=local` cannot downgrade the process.
      [{ EMBER_ENV: 'local', NODE_ENV: 'production' }, 'NODE_ENV=production'],
    ] as const) {
      const config = loadDevAuthConfig({ ...env, ...twoTenants() });

      expect(config.disabled, JSON.stringify(env)).toBe(true);
      expect(config.disabledBy).toBe(disabledBy);
      expect(config.tenants).toEqual([]);
      expect(config.ignoredVariables).toEqual([
        'EMBER_DEV_AUTH_TENANT_A_PRINCIPAL_ID',
        'EMBER_DEV_AUTH_TENANT_A_TENANT_ID',
        'EMBER_DEV_AUTH_TENANT_A_TOKEN',
        'EMBER_DEV_AUTH_TENANT_B_PRINCIPAL_ID',
        'EMBER_DEV_AUTH_TENANT_B_TENANT_ID',
        'EMBER_DEV_AUTH_TENANT_B_TOKEN',
      ]);
      // Not even the names may be mistaken for values.
      expect(JSON.stringify(config)).not.toContain(TOKEN_A);
      expect(JSON.stringify(config)).not.toContain(TOKEN_B);
    }
  });

  it('starts a shared deployment that has no dev credentials at all', () => {
    expect(loadDevAuthConfig({ NODE_ENV: 'production' })).toEqual({
      tenants: [],
      disabled: true,
      disabledBy: 'NODE_ENV=production',
      ignoredVariables: [],
    });
  });

  it('does not let a development marker re-enable tokens in a shared deployment', () => {
    // `EMBER_ENV=local` next to `NODE_ENV=staging` must not be read as a development run.
    const config = loadDevAuthConfig({
      EMBER_ENV: 'local',
      NODE_ENV: 'staging',
      ...slotEnv('A', { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A }),
    });

    expect(config.tenants).toEqual([]);
    expect(config.disabled).toBe(true);
  });

  it('rejects a partially configured slot and names only the missing variables', () => {
    const error = catchConfigError({
      ...slotEnv('A', { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A }),
      ...slotEnv('B', { tenantId: TENANT_B }),
    });

    expect(error.message).toContain('EMBER_DEV_AUTH_TENANT_B_TOKEN');
    expect(error.message).toContain('EMBER_DEV_AUTH_TENANT_B_PRINCIPAL_ID');
    expect(error.message).not.toContain(TOKEN_A);
    expect(error.message).not.toContain(TENANT_B);
  });

  it('rejects two slots that share one token', () => {
    const error = catchConfigError({
      ...slotEnv('A', { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A }),
      ...slotEnv('B', { token: TOKEN_A, tenantId: TENANT_B, principalId: PRINCIPAL_B }),
    });

    expect(error.message).toContain('duplicates');
    expect(error.message).not.toContain(TOKEN_A);
  });

  it('rejects tokens that are too short or not header-safe', () => {
    expect(() =>
      loadDevAuthConfig(
        slotEnv('A', { token: 'short', tenantId: TENANT_A, principalId: PRINCIPAL_A }),
      ),
    ).toThrow(DevAuthConfigError);

    const error = catchConfigError(
      slotEnv('A', {
        token: `${TOKEN_A} with space`,
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
      }),
    );
    expect(error.message).toContain('EMBER_DEV_AUTH_TENANT_A_TOKEN');
    expect(error.message).not.toContain(TOKEN_A);
  });

  it('rejects identifiers that are not UUIDs', () => {
    const error = catchConfigError(
      slotEnv('A', { token: TOKEN_A, tenantId: 'not-a-uuid', principalId: PRINCIPAL_A }),
    );

    expect(error.message).toContain('EMBER_DEV_AUTH_TENANT_A_TENANT_ID');
    expect(error.message).not.toContain(TOKEN_A);
  });
});

describe('parseBearerToken', () => {
  it('classifies header problems with a closed reason set', () => {
    expect(parseBearerToken(undefined)).toEqual({ ok: false, reason: 'missing_authorization' });
    expect(parseBearerToken('')).toEqual({ ok: false, reason: 'missing_authorization' });
    expect(parseBearerToken('   ')).toEqual({ ok: false, reason: 'missing_authorization' });
    expect(parseBearerToken('Basic abc')).toEqual({ ok: false, reason: 'malformed_authorization' });
    expect(parseBearerToken('Bearer')).toEqual({ ok: false, reason: 'malformed_authorization' });
    expect(parseBearerToken('Bearer    ')).toEqual({
      ok: false,
      reason: 'malformed_authorization',
    });
    expect(parseBearerToken('Bearer a b')).toEqual({
      ok: false,
      reason: 'malformed_authorization',
    });
    expect([...AUTH_FAILURE_REASONS]).toEqual([
      'missing_authorization',
      'malformed_authorization',
      'unknown_token',
    ]);
  });

  it('accepts a case-insensitive scheme with extra spaces', () => {
    expect(parseBearerToken('bearer abc123')).toEqual({ ok: true, token: 'abc123' });
    expect(parseBearerToken('Bearer   abc123')).toEqual({ ok: true, token: 'abc123' });
  });
});

describe('createDevTokenAuthenticator', () => {
  const credentials = loadDevAuthConfig(twoTenants()).tenants;

  it('maps each configured token to exactly its own tenant context', () => {
    const authenticator = createDevTokenAuthenticator(credentials);

    const a = authenticator.authenticate(`Bearer ${TOKEN_A}`);
    const b = authenticator.authenticate(`Bearer ${TOKEN_B}`);

    expect(a).toEqual({
      ok: true,
      context: { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 },
    });
    expect(b).toEqual({
      ok: true,
      context: { tenantId: TENANT_B, principalId: PRINCIPAL_B, policyVersion: 1 },
    });
    // The raw credential never leaves the authenticator.
    expect(JSON.stringify(a)).not.toContain(TOKEN_A);
  });

  it('rejects an unknown token without echoing it', () => {
    const authenticator = createDevTokenAuthenticator(credentials);
    const presented = `Bearer ${TOKEN_A}x`;

    const result = authenticator.authenticate(presented);

    expect(result).toEqual({ ok: false, reason: 'unknown_token' });
    expect(JSON.stringify(result)).not.toContain(TOKEN_A);
  });

  it('is fail-closed when no credential is configured', () => {
    const authenticator = createDevTokenAuthenticator([]);

    expect(authenticator.authenticate(`Bearer ${TOKEN_A}`)).toEqual({
      ok: false,
      reason: 'unknown_token',
    });
    expect(authenticator.authenticate(undefined)).toEqual({
      ok: false,
      reason: 'missing_authorization',
    });
  });
});

const FIXED_REQUEST_ID = 'req-fixed-0001';

describe('/v1 authentication at the app boundary', () => {
  const credentials = loadDevAuthConfig(twoTenants()).tenants;

  function buildApp(createCalls: string[]): ReturnType<typeof createApp> {
    return createApp({
      authenticator: createDevTokenAuthenticator(credentials),
      requestIdGenerator: () => FIXED_REQUEST_ID,
      taskStore: {
        create: (ctx) => {
          createCalls.push(ctx.tenantId);
          return Promise.reject(new Error('store must not be reached'));
        },
        get: () => Promise.resolve(null),
        listEvents: () => Promise.resolve([]),
      },
    });
  }

  it('rejects a request with no credential before the handler runs', async () => {
    const createCalls: string[] = [];
    const response = await buildApp(createCalls).request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('x-request-id')).toBe(FIXED_REQUEST_ID);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
        request_id: FIXED_REQUEST_ID,
      },
    });
    expect(createCalls).toEqual([]);
  });

  it('rejects an unknown token without disclosing it', async () => {
    const createCalls: string[] = [];
    const response = await buildApp(createCalls).request('/v1/tasks', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}-wrong`, 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toContain('UNAUTHENTICATED');
    expect(text).not.toContain(TOKEN_A);
    expect(createCalls).toEqual([]);
  });

  it('guards the collection route as well as the item routes', async () => {
    const app = buildApp([]);

    for (const path of ['/v1/tasks', '/v1/tasks/', `/v1/tasks/${TENANT_A}`]) {
      const response = await app.request(path, { method: 'POST' });
      expect(response.status, path).toBe(401);
    }
  });

  it('reaches the handler with a valid token and reports an unavailable store as 503', async () => {
    const app = createApp({
      authenticator: createDevTokenAuthenticator(credentials),
      requestIdGenerator: () => FIXED_REQUEST_ID,
    });

    const response = await app.request(`/v1/tasks/${TENANT_A}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'DB_UNAVAILABLE', request_id: FIXED_REQUEST_ID },
    });
  });

  it('leaves the health endpoints unauthenticated', async () => {
    const app = buildApp([]);

    expect((await app.request('/healthz')).status).toBe(200);
    // Readiness is 503 only because no probe is wired, never because of a 401.
    expect((await app.request('/readyz')).status).toBe(503);
  });
});
