import { createHash, randomUUID } from 'node:crypto';
import {
  B1MeResponseSchema,
  B1SessionResponseSchema,
  ErrorResponseSchema,
  type B1MeResponse,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import type {
  B1AuthenticatedSession,
  B1ProvisionedIdentity,
  B1SessionRecord,
  B1SessionRotationResult,
} from '@ember/postgres';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import type { B1SessionRuntime } from '../../apps/api/src/auth/b1-auth-runtime.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { createDevIdentityVerifier } from '../../apps/api/src/auth/identity-verifier.js';
import {
  createSessionService,
  MAX_SESSION_REQUEST_BYTES,
  unconfiguredB1SessionPorts,
  type B1SessionPorts,
} from '../../apps/api/src/auth/session-service.js';
import { generateSessionToken, parseSessionBearer } from '../../apps/api/src/auth/session-token.js';
import {
  ME_PATH,
  SESSION_PATH,
  SESSION_REFRESH_PATH,
} from '../../apps/api/src/auth/session-routes.js';
import type { Logger } from '../../apps/api/src/logger.js';

/**
 * B1-2B HTTP runtime tests. Every repository is an in-memory fake declared in THIS file;
 * no PostgreSQL, no external provider and no Agent A implementation is involved.
 */

const FIXED_NOW = new Date('2026-11-05T02:00:00.000Z');
const REQUEST_ID = 'req-b1-2b-http';
const DEV_TOKEN = 'legacy-dev-token-abcdefghijklmnop';
const LEGACY_TENANT = randomUUID();
const LEGACY_PRINCIPAL = randomUUID();
const CREATED_AT = '2026-11-01T00:00:00.000Z';

interface ProvisionCommand {
  readonly provider: 'apple' | 'dev';
  readonly providerSubject: string;
  readonly tokenDigest: Uint8Array;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

interface RotateCommand {
  readonly currentTokenDigest: Uint8Array;
  readonly newTokenDigest: Uint8Array;
}

interface RevokeCommand {
  readonly sessionId: Id;
  readonly tenantId: Id;
}

interface FakeRow {
  session: B1SessionRecord;
  readonly principalId: Id;
  readonly policyVersion: number;
  readonly consumerKey: string;
  readonly identity: B1ProvisionedIdentity;
  revoked: boolean;
}

interface FakePorts extends B1SessionPorts {
  readonly provisions: ProvisionCommand[];
  readonly rotations: RotateCommand[];
  readonly revokes: RevokeCommand[];
  readonly meCalls: Id[];
  readonly identities: Map<string, B1ProvisionedIdentity>;
  readonly digests: Map<string, FakeRow>;
  readonly rows: Map<string, FakeRow>;
  setMeProjection(value: B1MeResponse | null): void;
  expire(sessionId: Id): void;
}

function hexOf(digest: Uint8Array): string {
  return Buffer.from(digest).toString('hex');
}

function digestHexOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function fakePorts(): FakePorts {
  const provisions: ProvisionCommand[] = [];
  const rotations: RotateCommand[] = [];
  const revokes: RevokeCommand[] = [];
  const meCalls: Id[] = [];
  const identities = new Map<string, B1ProvisionedIdentity>();
  const byTenant = new Map<Id, B1ProvisionedIdentity>();
  const digests = new Map<string, FakeRow>();
  const rows = new Map<string, FakeRow>();
  const rotatedDigests = new Map<string, string>();
  let meProjection: B1MeResponse | null = null;

  const isLive = (row: FakeRow): boolean => {
    const now = FIXED_NOW.getTime();
    return (
      !row.revoked &&
      Date.parse(row.session.expiresAt) > now &&
      Date.parse(row.session.idleExpiresAt) > now
    );
  };

  const projectionFor = (identity: B1ProvisionedIdentity): B1MeResponse => ({
    consumer_id: identity.consumerId,
    agent: { agent_id: identity.agentId, display_name: 'Ember' },
    conversation: {
      conversation_id: identity.conversationId,
      transcript_epoch: 0,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
  });

  const ports: FakePorts = {
    provisions,
    rotations,
    revokes,
    meCalls,
    identities,
    digests,
    rows,
    setMeProjection(value: B1MeResponse | null): void {
      meProjection = value;
    },
    expire(sessionId: Id): void {
      const row = rows.get(sessionId);
      if (row !== undefined) {
        row.session = { ...row.session, expiresAt: '2020-01-01T00:00:00.000Z' };
      }
    },
    provisioning: {
      provisionIdentityAndCreateSession(command) {
        provisions.push(command);
        const consumerKey = `${command.provider}:${command.providerSubject}`;
        let identity = identities.get(consumerKey);

        if (identity === undefined) {
          identity = {
            consumerId: randomUUID(),
            tenantId: randomUUID(),
            principalId: randomUUID(),
            agentId: randomUUID(),
            conversationId: randomUUID(),
          };
          identities.set(consumerKey, identity);
          byTenant.set(identity.tenantId, identity);
        }

        const session: B1SessionRecord = {
          sessionId: randomUUID(),
          consumerId: identity.consumerId,
          tenantId: identity.tenantId,
          expiresAt: command.expiresAt,
          idleExpiresAt: command.idleExpiresAt,
          revokedAt: null,
        };
        const row: FakeRow = {
          session,
          principalId: identity.principalId,
          policyVersion: 1,
          consumerKey,
          identity,
          revoked: false,
        };
        digests.set(hexOf(command.tokenDigest), row);
        rows.set(session.sessionId, row);

        return Promise.resolve({ identity, session });
      },
    },
    sessions: {
      findActiveSession(tokenDigest): Promise<B1AuthenticatedSession | null> {
        const row = digests.get(hexOf(tokenDigest));

        if (row === undefined || !isLive(row)) {
          return Promise.resolve(null);
        }

        return Promise.resolve({
          session: row.session,
          principalId: row.principalId,
          policyVersion: row.policyVersion,
        });
      },
      rotateSession(command): Promise<B1SessionRotationResult> {
        rotations.push(command);
        const currentHex = hexOf(command.currentTokenDigest);
        const row = digests.get(currentHex);

        if (row === undefined || !isLive(row)) {
          const previousConsumer = rotatedDigests.get(currentHex);

          if (previousConsumer !== undefined) {
            for (const candidate of rows.values()) {
              if (candidate.consumerKey === previousConsumer) {
                candidate.revoked = true;
              }
            }
            return Promise.resolve({ kind: 'reuse_detected' });
          }

          return Promise.resolve({ kind: 'inactive' });
        }

        row.revoked = true;
        rotatedDigests.set(currentHex, row.consumerKey);

        const newSession: B1SessionRecord = {
          sessionId: randomUUID(),
          consumerId: row.session.consumerId,
          tenantId: row.session.tenantId,
          expiresAt: command.expiresAt,
          idleExpiresAt: command.idleExpiresAt,
          revokedAt: null,
        };
        const newRow: FakeRow = {
          session: newSession,
          principalId: row.principalId,
          policyVersion: row.policyVersion,
          consumerKey: row.consumerKey,
          identity: row.identity,
          revoked: false,
        };
        digests.set(hexOf(command.newTokenDigest), newRow);
        rows.set(newSession.sessionId, newRow);

        return Promise.resolve({ kind: 'rotated', session: newSession });
      },
      revokeSession(command): Promise<void> {
        revokes.push(command);
        const row = rows.get(command.sessionId);

        if (row !== undefined && row.session.tenantId === command.tenantId) {
          row.revoked = true;
        }

        return Promise.resolve();
      },
    },
    me: {
      getMeForTenant(tenantId): Promise<B1MeResponse | null> {
        meCalls.push(tenantId);
        const identity = byTenant.get(tenantId);

        if (identity === undefined) {
          return Promise.resolve(null);
        }

        return Promise.resolve(meProjection ?? projectionFor(identity));
      },
    },
  };

  return ports;
}

function runtimeFor(ports: B1SessionPorts): B1SessionRuntime {
  return {
    service: createSessionService({ ports, now: () => FIXED_NOW }),
    appleVerifier: {
      provider: 'apple',
      verify: () => Promise.resolve(null),
    },
    devVerifier: createDevIdentityVerifier(),
    devProvider: { evaluate: () => ({ enabled: true, deniedBy: [] }) },
    me: ports.me,
  };
}

type RecordedLog = Record<string, unknown>;

function harness(ports: FakePorts = fakePorts(), runtime?: B1SessionRuntime) {
  const logs: RecordedLog[] = [];
  const logger: Logger = {
    debug: (message, fields) => logs.push({ level: 'debug', message, ...fields }),
    info: (message, fields) => logs.push({ level: 'info', message, ...fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, ...fields }),
    error: (message, fields) => logs.push({ level: 'error', message, ...fields }),
  };
  const app = createApp({
    b1Session: runtime ?? runtimeFor(ports),
    logger,
    requestIdGenerator: () => REQUEST_ID,
    authenticator: createDevTokenAuthenticator([
      {
        token: DEV_TOKEN,
        tenantId: LEGACY_TENANT,
        principalId: LEGACY_PRINCIPAL,
        policyVersion: 1,
      },
    ]),
  });

  return { app, ports, logs };
}

function jsonHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function postSession(
  app: ReturnType<typeof createApp>,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await app.request(SESSION_PATH, {
    method: 'POST',
    headers: { ...jsonHeaders(), ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function devRequest(identityToken = 'dev-subject-a'): {
  provider: 'dev';
  identity_token: string;
  nonce: string;
} {
  return { provider: 'dev', identity_token: identityToken, nonce: 'dev-nonce' };
}

async function signIn(
  app: ReturnType<typeof createApp>,
  subject = 'dev-subject-a',
): Promise<string> {
  const response = await postSession(app, devRequest(subject));
  expect(response.status).toBe(201);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function errorBody(response: Response): Promise<unknown> {
  return await response.json();
}

describe('POST /v1/auth/session (201, strict DTO)', () => {
  it('creates a session and returns exactly the frozen DTO', async () => {
    const { app, ports } = harness();
    const response = await postSession(app, devRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(B1SessionResponseSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      ['access_token', 'consumer_id', 'expires_at', 'session_id'].sort(),
    );
    expect(body).not.toHaveProperty('tenant_id');
    expect(body).not.toHaveProperty('principal_id');
    expect(body).not.toHaveProperty('policy_version');

    const token = body.access_token;
    expect(typeof token).toBe('string');
    expect(token).toMatch(/^ems_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(String(token).slice(4), 'base64url')).toHaveLength(32);

    const command = ports.provisions[0];
    expect(command?.tokenDigest).toBeInstanceOf(Uint8Array);
    expect(command?.tokenDigest).toHaveLength(32);
    expect(hexOf(command?.tokenDigest ?? new Uint8Array())).toBe(digestHexOf(String(token)));
    expect(JSON.stringify(ports.provisions)).not.toContain(String(token));
    expect(command?.providerSubject).toMatch(/^dev:[a-f0-9]{64}$/);
  });

  it('is always 201 and never provisions a second tenant, Agent or Conversation', async () => {
    const { app, ports } = harness();
    const first = await postSession(app, devRequest());
    const second = await postSession(app, devRequest());
    const firstBody = (await first.json()) as Record<string, unknown>;
    const secondBody = (await second.json()) as Record<string, unknown>;

    expect(second.status).toBe(201);
    expect(firstBody.consumer_id).toBe(secondBody.consumer_id);
    expect(firstBody.session_id).not.toBe(secondBody.session_id);
    expect(firstBody.access_token).not.toBe(secondBody.access_token);
    expect(ports.identities.size).toBe(1);
  });

  it('rejects caller-supplied tenant/principal/policy fields and every malformed body', async () => {
    const { app, ports } = harness();
    const invalid: unknown[] = [
      { ...devRequest(), tenant_id: randomUUID() },
      { ...devRequest(), principal_id: randomUUID() },
      { ...devRequest(), policy_version: 7 },
      { provider: 'other', identity_token: 'x', nonce: 'n' },
      { provider: 'dev', identity_token: '', nonce: 'n' },
      { provider: 'dev', identity_token: 'x' },
      { provider: 'dev', identity_token: 'x', nonce: 'n', extra: true },
    ];

    for (const body of invalid) {
      const response = await postSession(app, body);
      expect(response.status).toBe(400);
      expect(ErrorResponseSchema.safeParse(await errorBody(response)).success).toBe(true);
    }

    const tooLarge = await postSession(app, 'x'.repeat(MAX_SESSION_REQUEST_BYTES + 1));
    expect(tooLarge.status).toBe(400);
    expect(JSON.stringify(await errorBody(tooLarge))).not.toContain('xxxx');

    const wrongContentType = await app.request(SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongContentType.status).toBe(400);
    expect(ports.provisions).toHaveLength(0);
  });

  it('answers every Apple verification failure with one indistinguishable 401', async () => {
    const { app, ports } = harness();
    const rejected = await postSession(app, {
      provider: 'apple',
      identity_token: 'bad-jwt',
      nonce: 'bad-nonce',
    });
    const missingCredential = await app.request(ME_PATH, { method: 'GET' });

    expect(rejected.status).toBe(401);
    expect(await errorBody(rejected)).toEqual(await errorBody(missingCredential));
    expect(ports.provisions).toHaveLength(0);
  });

  it('uses the same provisioning path for a verified Apple identity', async () => {
    const ports = fakePorts();
    const runtime: B1SessionRuntime = {
      ...runtimeFor(ports),
      appleVerifier: {
        provider: 'apple',
        verify: () => Promise.resolve({ provider: 'apple', providerSubject: 'apple-stable-sub' }),
      },
    };
    const { app } = harness(ports, runtime);
    const response = await postSession(app, {
      provider: 'apple',
      identity_token: 'signed-jwt',
      nonce: 'nonce',
    });

    expect(response.status).toBe(201);
    expect(ports.provisions[0]?.provider).toBe('apple');
    expect(ports.provisions[0]?.providerSubject).toBe('apple-stable-sub');
  });
});

describe('refresh rotation, logout and active-session resolution', () => {
  it('rotates with 200 and revokes every session of the consumer on token replay', async () => {
    const { app, ports } = harness();
    const token = await signIn(app);
    const refreshed = await app.request(SESSION_REFRESH_PATH, {
      method: 'POST',
      headers: jsonHeaders(token),
    });
    const refreshedBody = (await refreshed.json()) as Record<string, unknown>;

    expect(refreshed.status).toBe(200);
    expect(B1SessionResponseSchema.safeParse(refreshedBody).success).toBe(true);
    expect(refreshedBody.access_token).not.toBe(token);
    expect(ports.rotations[0]?.currentTokenDigest).toEqual(
      new Uint8Array(Buffer.from(digestHexOf(token), 'hex')),
    );
    expect(hexOf(ports.rotations[0]?.newTokenDigest ?? new Uint8Array())).toBe(
      digestHexOf(String(refreshedBody.access_token)),
    );

    // The rotated token is no longer an active session.
    expect((await app.request(ME_PATH, { headers: jsonHeaders(token) })).status).toBe(401);

    // Replaying it revokes ALL sessions of that consumer, including the fresh token.
    expect(
      (await app.request(SESSION_REFRESH_PATH, { method: 'POST', headers: jsonHeaders(token) }))
        .status,
    ).toBe(401);
    expect(
      (await app.request(ME_PATH, { headers: jsonHeaders(String(refreshedBody.access_token)) }))
        .status,
    ).toBe(401);
  });

  it('rejects refresh without a session credential', async () => {
    const { app } = harness();

    for (const token of [undefined, DEV_TOKEN, 'not-a-token', generateSessionToken()]) {
      const response = await app.request(SESSION_REFRESH_PATH, {
        method: 'POST',
        headers: token === undefined ? {} : jsonHeaders(token),
      });
      expect(response.status).toBe(401);
    }
  });

  it('answers logout with 204, is idempotent, and revokes only the presented session', async () => {
    const { app, ports } = harness();
    const token = await signIn(app);
    const other = await signIn(app, 'dev-subject-b');
    const headers = jsonHeaders(token);

    const spoofed = await app.request(SESSION_PATH, {
      method: 'DELETE',
      headers: { ...headers, 'x-tenant-id': LEGACY_TENANT },
    });
    expect(spoofed.status).toBe(400);
    expect(ports.revokes).toHaveLength(0);

    const first = await app.request(SESSION_PATH, { method: 'DELETE', headers });
    expect(first.status).toBe(204);
    expect(await first.text()).toBe('');

    const second = await app.request(SESSION_PATH, { method: 'DELETE', headers });
    expect(second.status).toBe(204);

    expect(ports.revokes).toHaveLength(1);
    expect(ports.revokes[0]?.tenantId).not.toBe(LEGACY_TENANT);
    expect((await app.request(ME_PATH, { headers: jsonHeaders(token) })).status).toBe(401);
    expect((await app.request(ME_PATH, { headers: jsonHeaders(other) })).status).toBe(200);

    expect((await app.request(SESSION_PATH, { method: 'DELETE' })).status).toBe(401);
  });

  it('rejects revoked, replayed, expired and forged tokens', async () => {
    const { app, ports } = harness();
    const token = await signIn(app);
    const parsed = parseSessionBearer(`Bearer ${token}`);
    expect(parsed.ok).toBe(true);

    const active = parsed.ok ? ports.digests.get(hexOf(parsed.digest)) : undefined;
    expect(active).toBeDefined();
    ports.expire(String(active?.session.sessionId));
    expect((await app.request(ME_PATH, { headers: jsonHeaders(token) })).status).toBe(401);

    const forged = generateSessionToken();
    expect((await app.request(ME_PATH, { headers: jsonHeaders(forged) })).status).toBe(401);
  });
});

describe('GET /v1/me and tenant isolation', () => {
  it('returns the frozen bootstrap DTO', async () => {
    const { app } = harness();
    const token = await signIn(app);
    const response = await app.request(ME_PATH, { headers: jsonHeaders(token) });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(B1MeResponseSchema.safeParse(body).success).toBe(true);
    const agent = body.agent as Record<string, unknown>;
    const conversation = body.conversation as Record<string, unknown>;
    expect(agent.display_name).toBe('Ember');
    expect(conversation.transcript_epoch).toBe(0);
    expect(conversation.created_at).toBe(CREATED_AT);
    expect(conversation.updated_at).toBe(CREATED_AT);
    expect(body).not.toHaveProperty('tenant_id');
  });

  it('never derives scope from a path, query, header or body field', async () => {
    const { app, ports } = harness();
    const tokenA = await signIn(app, 'dev-subject-a');
    const tokenB = await signIn(app, 'dev-subject-b');
    const meA = (await (
      await app.request(ME_PATH, { headers: jsonHeaders(tokenA) })
    ).json()) as Record<string, unknown>;
    const meB = (await (
      await app.request(ME_PATH, { headers: jsonHeaders(tokenB) })
    ).json()) as Record<string, unknown>;

    expect(meA.consumer_id).not.toBe(meB.consumer_id);

    // I-1: arriving scope fields are rejected, never ignored. Neither a query parameter,
    // nor a header, nor a request body may attempt to select another tenant.
    const clean = await app.request(ME_PATH, { headers: jsonHeaders(tokenA) });
    expect(clean.status).toBe(200);
    expect(await errorBody(clean)).toEqual(meA);

    for (const query of [
      `?tenant_id=${String(meB.consumer_id)}`,
      `?principal_id=${String(meB.consumer_id)}`,
      '?policy_version=99',
      `?consumer_id=${String(meB.consumer_id)}&tenantId=${String(meB.consumer_id)}`,
    ]) {
      expect(
        (await app.request(`${ME_PATH}${query}`, { headers: jsonHeaders(tokenA) })).status,
      ).toBe(400);
    }

    for (const header of ['x-tenant-id', 'x-principal-id', 'x-policy-version']) {
      const response = await app.request(ME_PATH, {
        headers: { ...jsonHeaders(tokenA), [header]: String(meB.consumer_id) },
      });
      expect(response.status).toBe(400);
    }

    const withBody = await app.request(SESSION_REFRESH_PATH, {
      method: 'POST',
      headers: jsonHeaders(tokenA),
      body: JSON.stringify({ tenant_id: String(meB.consumer_id) }),
    });
    expect(withBody.status).toBe(400);

    expect(ports.meCalls.every((tenantId) => tenantId !== String(meB.consumer_id))).toBe(true);

    // A valid session token cannot be used as a legacy dev credential.
    expect((await app.request('/v1/agents', { headers: jsonHeaders(tokenA) })).status).toBe(401);
  });

  it('answers a missing projection with the same 404 as an unknown resource and no create branch', async () => {
    const ports = fakePorts();
    ports.setMeProjection(null);
    const { app } = harness(ports);
    const token = await signIn(app);
    // Replace the reader with one that reports "not visible", as a cross-tenant read would.
    const missingRuntime: B1SessionRuntime = {
      ...runtimeFor(ports),
      me: { getMeForTenant: () => Promise.resolve(null) },
    };
    const isolated = harness(ports, missingRuntime);
    const missing = await isolated.app.request(ME_PATH, { headers: jsonHeaders(token) });
    const unknown = await isolated.app.request('/v1/no-such-resource', { method: 'GET' });

    expect(missing.status).toBe(404);
    expect(await errorBody(missing)).toEqual(await errorBody(unknown));
    expect(isolated.ports.identities.size).toBe(1);
  });
});

describe('unauthorized, unknown route and legacy non-regression', () => {
  it('keeps the legacy dev-token authentication untouched', async () => {
    const { app } = harness();

    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/v1/agents', { method: 'POST' })).status).toBe(401);
    expect(
      (await app.request('/v1/agents', { method: 'POST', headers: jsonHeaders(DEV_TOKEN) })).status,
    ).not.toBe(401);
    expect((await app.request('/v1/tasks', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/v1/artifacts', { method: 'GET' })).status).toBe(401);
  });

  it('rejects legacy credentials and absent credentials on every new protected route', async () => {
    const { app } = harness();

    for (const [path, method] of [
      [ME_PATH, 'GET'],
      [SESSION_REFRESH_PATH, 'POST'],
      [SESSION_PATH, 'DELETE'],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(401);
      expect((await app.request(path, { method, headers: jsonHeaders(DEV_TOKEN) })).status).toBe(
        401,
      );
    }
  });

  it('uses the public ErrorResponse vocabulary for unknown routes', async () => {
    const { app } = harness();
    const response = await app.request('/v1/not-a-route', { method: 'GET' });

    expect(response.status).toBe(404);
    expect(ErrorResponseSchema.safeParse(await errorBody(response)).success).toBe(true);
  });
});

describe('missing repository configuration (fail closed)', () => {
  it('registers no new route without an injected runtime', async () => {
    const app = createApp();

    for (const [path, method] of [
      [SESSION_PATH, 'POST'],
      [SESSION_REFRESH_PATH, 'POST'],
      [SESSION_PATH, 'DELETE'],
      [ME_PATH, 'GET'],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(404);
    }
  });

  it('answers 503 DB_UNAVAILABLE for every operation when ports are unconfigured', async () => {
    const ports = unconfiguredB1SessionPorts();
    const { app } = harness(fakePorts(), {
      ...runtimeFor(ports),
      service: createSessionService({ ports, now: () => FIXED_NOW }),
    });
    const token = generateSessionToken();

    for (const response of [
      await postSession(app, devRequest()),
      await app.request(SESSION_REFRESH_PATH, { method: 'POST', headers: jsonHeaders(token) }),
      await app.request(SESSION_PATH, { method: 'DELETE', headers: jsonHeaders(token) }),
      await app.request(ME_PATH, { headers: jsonHeaders(token) }),
    ]) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
      expect((body.error as Record<string, unknown>).code).toBe('DB_UNAVAILABLE');
    }
  });
});

describe('content-safe logging', () => {
  it('never logs tokens, provider assertions, nonces, headers or payloads', async () => {
    const { app, logs } = harness();
    const secretAssertion = 'identity-token-SUPERSECRETVALUE';
    const secretNonce = 'nonce-SUPERSECRETVALUE';
    const created = await postSession(app, {
      provider: 'dev',
      identity_token: secretAssertion,
      nonce: secretNonce,
    });
    const token = ((await created.json()) as { access_token: string }).access_token;

    await app.request(`${ME_PATH}?leak=QUERYSECRETVALUE`, { headers: jsonHeaders(token) });
    await app.request(ME_PATH, { headers: jsonHeaders('ems_forged-secret-value') });
    await app.request(SESSION_PATH, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        provider: 'apple',
        identity_token: secretAssertion,
        nonce: secretNonce,
      }),
    });
    await postSession(app, devRequest('BODYSECRETVALUE'));

    const serialized = JSON.stringify(logs);

    for (const secret of [
      token,
      secretAssertion,
      secretNonce,
      'BODYSECRETVALUE',
      'QUERYSECRETVALUE',
      'ems_forged-secret-value',
      'Bearer',
      'authorization',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(serialized).toContain(REQUEST_ID);
    expect(serialized).toContain(ME_PATH);
  });
});
