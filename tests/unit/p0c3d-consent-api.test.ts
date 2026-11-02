import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CONSENT_OPERATIONS,
  type ConsentOperation,
  type ConsentRepository,
  type PersistedConsentGrant,
  type GrantConsentCommand,
  type RevokeConsentOptions,
  type SourceProfileId,
} from '@ember/contracts';
import { DomainError, type AuthContext } from '@ember/domain';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { CONSENTS_PATH, MAX_CONSENT_BODY_BYTES } from '../../apps/api/src/consents/constants.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_A = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL_B = '44444444-4444-4444-8444-444444444444';

const TOKEN_A = 'test-token-tenant-a-consent-secret';
const TOKEN_B = 'test-token-tenant-b-consent-secret';

const PROFILE = 'fixture.github-release';

/**
 * In-memory stand-in for `PostgresConsentRepository`.
 *
 * It reproduces only the semantics the HTTP layer relies on: tenant scoping from `AuthContext`,
 * replay of an identical grant, and a compare-and-set revocation. The authoritative
 * transactional behaviour is covered by the PostgreSQL integration suite.
 */
class FakeConsentStore implements ConsentRepository {
  readonly grants = new Map<string, PersistedConsentGrant>();
  readonly grantRequests: { readonly tenantId: string; readonly cmd: GrantConsentCommand }[] = [];
  readonly revokeRequests: {
    readonly tenantId: string;
    readonly sourceProfileId: string;
    readonly options?: RevokeConsentOptions;
  }[] = [];

  private tick = 0;

  private nextTimestamp(): string {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick));
    this.tick += 1;
    return at.toISOString();
  }

  private keyOf(tenantId: string, sourceProfileId: string): string {
    return `${tenantId}:${sourceProfileId}`;
  }

  seed(
    tenantId: string,
    sourceProfileId: string,
    overrides: Partial<PersistedConsentGrant> = {},
  ): PersistedConsentGrant {
    const now = this.nextTimestamp();
    const grant: PersistedConsentGrant = {
      grantId: randomUUID(),
      tenantId,
      sourceProfileId,
      status: 'active',
      allowedOperations: [...DEFAULT_CONSENT_OPERATIONS],
      scopes: [],
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };

    this.grants.set(this.keyOf(tenantId, sourceProfileId), grant);
    return grant;
  }

  private sameOperations(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((operation) => right.includes(operation));
  }

  async grant(
    ctx: AuthContext,
    cmd: GrantConsentCommand,
  ): Promise<{ readonly consent: PersistedConsentGrant; readonly replayed: boolean }> {
    await Promise.resolve();
    this.grantRequests.push({ tenantId: ctx.tenantId, cmd });

    const key = this.keyOf(ctx.tenantId, cmd.sourceProfileId);
    const existing = this.grants.get(key);
    const operations: readonly string[] = cmd.allowedOperations ?? DEFAULT_CONSENT_OPERATIONS;
    const scopes = cmd.scopes ?? [];
    const expiresAt = cmd.expiresAt ?? null;

    if (
      existing !== undefined &&
      existing.status === 'active' &&
      existing.expiresAt === expiresAt &&
      this.sameOperations(existing.allowedOperations, operations) &&
      existing.scopes.length === scopes.length &&
      existing.scopes.every((scope) => scopes.includes(scope))
    ) {
      return { consent: existing, replayed: true };
    }

    const now = this.nextTimestamp();
    const grant: PersistedConsentGrant = {
      grantId: existing?.grantId ?? randomUUID(),
      tenantId: ctx.tenantId,
      sourceProfileId: cmd.sourceProfileId,
      status: 'active',
      allowedOperations: [...operations],
      scopes: [...scopes],
      grantedAt: now,
      expiresAt,
      revokedAt: null,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.grants.set(key, grant);
    return { consent: grant, replayed: false };
  }

  async revoke(
    ctx: AuthContext,
    sourceProfileId: SourceProfileId,
    options?: RevokeConsentOptions,
  ): Promise<PersistedConsentGrant> {
    await Promise.resolve();
    this.revokeRequests.push({ tenantId: ctx.tenantId, sourceProfileId, options });

    const existing = this.grants.get(this.keyOf(ctx.tenantId, sourceProfileId));

    if (existing === undefined) {
      throw new DomainError('NOT_FOUND', 'consent grant not found');
    }

    if (options?.expectedVersion !== undefined && existing.version !== options.expectedVersion) {
      throw new DomainError('INVALID_STATE_TRANSITION', 'consent version does not match');
    }

    if (existing.status === 'revoked') {
      return existing;
    }

    const now = this.nextTimestamp();
    const revoked: PersistedConsentGrant = {
      ...existing,
      status: 'revoked',
      revokedAt: now,
      updatedAt: now,
      version: existing.version + 1,
    };
    this.grants.set(this.keyOf(ctx.tenantId, sourceProfileId), revoked);

    return revoked;
  }

  async get(
    ctx: AuthContext,
    sourceProfileId: SourceProfileId,
  ): Promise<PersistedConsentGrant | null> {
    await Promise.resolve();
    return this.grants.get(this.keyOf(ctx.tenantId, sourceProfileId)) ?? null;
  }

  async list(ctx: AuthContext): Promise<readonly PersistedConsentGrant[]> {
    await Promise.resolve();
    return [...this.grants.values()]
      .filter((grant) => grant.tenantId === ctx.tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

function setupTestApp(options: { readonly withStore?: boolean } = {}) {
  const store = new FakeConsentStore();
  const authenticator = createDevTokenAuthenticator([
    { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 },
    { token: TOKEN_B, tenantId: TENANT_B, principalId: PRINCIPAL_B, policyVersion: 1 },
  ]);

  const app =
    options.withStore === false
      ? createApp({ authenticator })
      : createApp({ authenticator, consentStore: store });

  return { app, store };
}

function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

describe('P0-C3D Consent HTTP API', () => {
  describe('authentication', () => {
    it('rejects every consent route without a bearer token', async () => {
      const { app } = setupTestApp();

      const responses = await Promise.all([
        app.request(CONSENTS_PATH, { method: 'GET' }),
        app.request(CONSENTS_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_profile_id: PROFILE }),
        }),
        app.request(`${CONSENTS_PATH}/${PROFILE}`, { method: 'GET' }),
        app.request(`${CONSENTS_PATH}/${PROFILE}/revoke`, { method: 'POST' }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(((await response.json()) as ErrorBody).error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('rejects an unknown token without touching the store', async () => {
      const { app, store } = setupTestApp();

      const response = await app.request(CONSENTS_PATH, {
        headers: bearer('not-a-issued-token'),
      });

      expect(response.status).toBe(401);
      expect(store.grantRequests).toHaveLength(0);
    });

    it('answers 503 DB_UNAVAILABLE when the process has no consent store', async () => {
      const { app } = setupTestApp({ withStore: false });

      const response = await app.request(CONSENTS_PATH, { headers: bearer(TOKEN_A) });

      expect(response.status).toBe(503);
      expect(((await response.json()) as ErrorBody).error.code).toBe('DB_UNAVAILABLE');
    });
  });

  describe('POST /v1/consents (grant)', () => {
    it('creates a grant with 201 Created and a Location header', async () => {
      const { app, store } = setupTestApp();

      const response = await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ source_profile_id: PROFILE }),
      });

      expect(response.status).toBe(201);
      expect(response.headers.get('Location')).toBe(`${CONSENTS_PATH}/${PROFILE}`);

      const body = (await response.json()) as {
        consent: { source_profile_id: string; tenant_id: string; version: number };
        replayed: boolean;
      };
      expect(body.replayed).toBe(false);
      // The tenant comes from the credential, never from the request body.
      expect(body.consent.tenant_id).toBe(TENANT_A);
      expect(body.consent.source_profile_id).toBe(PROFILE);
      expect(body.consent.version).toBe(1);
      expect(store.grants.size).toBe(1);
    });

    it('leaves the default operation list to the server', async () => {
      const { app, store } = setupTestApp();

      const response = await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ source_profile_id: PROFILE }),
      });

      expect(response.status).toBe(201);
      expect(store.grantRequests[0]?.cmd.allowedOperations).toBeUndefined();

      const body = (await response.json()) as { consent: { allowed_operations: string[] } };
      expect(body.consent.allowed_operations).toStrictEqual(['read_snapshot']);
    });

    it('replays an identical grant as 200 without advancing the version', async () => {
      const { app } = setupTestApp();
      const send = () =>
        app.request(CONSENTS_PATH, {
          method: 'POST',
          headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ source_profile_id: PROFILE, scopes: ['repo:read'] }),
        });

      const first = await send();
      const second = await send();

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);

      const body = (await second.json()) as { consent: { version: number }; replayed: boolean };
      expect(body.replayed).toBe(true);
      expect(body.consent.version).toBe(1);
    });

    it('bumps the version when the grant is widened', async () => {
      const { app } = setupTestApp();

      await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ source_profile_id: PROFILE }),
      });

      // Widening the SCOPE set is a new authorization, not a reaffirmation.
      const widened = await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          source_profile_id: PROFILE,
          scopes: ['source.readonly', 'source.metadata'],
        }),
      });

      expect(widened.status).toBe(201);
      const body = (await widened.json()) as { consent: { version: number }; replayed: boolean };
      expect(body.replayed).toBe(false);
      expect(body.consent.version).toBe(2);
    });
  });

  describe('GET /v1/consents (read)', () => {
    it('lists only the authenticated tenant’s grants', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_A, PROFILE);
      store.seed(TENANT_A, 'fixture.linear-issues');
      store.seed(TENANT_B, PROFILE);

      const response = await app.request(CONSENTS_PATH, { headers: bearer(TOKEN_A) });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        consents: { tenant_id: string; source_profile_id: string }[];
      };
      expect(body.consents).toHaveLength(2);
      expect(body.consents.every((grant) => grant.tenant_id === TENANT_A)).toBe(true);
      expect(body.consents.map((grant) => grant.source_profile_id)).toStrictEqual([
        'fixture.linear-issues',
        PROFILE,
      ]);
    });

    it('returns an empty list rather than another tenant’s grants', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_B, PROFILE);

      const response = await app.request(CONSENTS_PATH, { headers: bearer(TOKEN_B) });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { consents: unknown[] }).consents).toHaveLength(1);

      const other = await app.request(CONSENTS_PATH, { headers: bearer(TOKEN_A) });
      expect(((await other.json()) as { consents: unknown[] }).consents).toHaveLength(0);
    });

    it('reads one grant for the owning tenant', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_A, PROFILE, { version: 4, scopes: ['repo:read'] });

      const response = await app.request(`${CONSENTS_PATH}/${PROFILE}`, {
        headers: bearer(TOKEN_A),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        consent: { source_profile_id: string; version: number; scopes: string[] };
      };
      expect(body.consent.source_profile_id).toBe(PROFILE);
      expect(body.consent.version).toBe(4);
      expect(body.consent.scopes).toStrictEqual(['repo:read']);
    });

    it('answers 404 for a grant owned by another tenant, identically to a missing one', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_B, PROFILE);

      const crossTenant = await app.request(`${CONSENTS_PATH}/${PROFILE}`, {
        headers: bearer(TOKEN_A),
      });
      const missing = await app.request(`${CONSENTS_PATH}/fixture.never-granted`, {
        headers: bearer(TOKEN_A),
      });

      expect(crossTenant.status).toBe(404);
      expect(missing.status).toBe(404);

      const crossBody = (await crossTenant.json()) as ErrorBody;
      const missingBody = (await missing.json()) as ErrorBody;
      expect(crossBody.error.code).toBe('NOT_FOUND');
      // The body must not confirm that the identifier exists in another tenant.
      expect({ code: crossBody.error.code, message: crossBody.error.message }).toStrictEqual({
        code: missingBody.error.code,
        message: missingBody.error.message,
      });
    });

    it('rejects a malformed source profile id in the path', async () => {
      const { app } = setupTestApp();

      const response = await app.request(`${CONSENTS_PATH}/GH%20Release`, {
        headers: bearer(TOKEN_A),
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).error.code).toBe('INVALID_ARGUMENT');
    });
  });

  describe('POST /v1/consents/:sourceProfileId/revoke', () => {
    it('revokes without a body', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_A, PROFILE);

      const response = await app.request(`${CONSENTS_PATH}/${PROFILE}/revoke`, {
        method: 'POST',
        headers: bearer(TOKEN_A),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        consent: { status: string; revoked_at: string | null; version: number };
      };
      expect(body.consent.status).toBe('revoked');
      expect(body.consent.revoked_at).not.toBeNull();
      expect(body.consent.version).toBe(2);
      expect(store.revokeRequests[0]?.options).toStrictEqual({ expectedVersion: undefined });
    });

    it('forwards expected_version as a compare-and-set', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_A, PROFILE);

      const response = await app.request(`${CONSENTS_PATH}/${PROFILE}/revoke`, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expected_version: 1 }),
      });

      expect(response.status).toBe(200);
      expect(store.revokeRequests[0]?.options).toStrictEqual({ expectedVersion: 1 });
    });

    it('answers 409 for a stale expected_version', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_A, PROFILE, { version: 3 });

      const response = await app.request(`${CONSENTS_PATH}/${PROFILE}/revoke`, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expected_version: 1 }),
      });

      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorBody).error.code).toBe('INVALID_STATE_TRANSITION');
      // A rejected compare-and-set must not have revoked anything.
      expect(store.grants.get(`${TENANT_A}:${PROFILE}`)?.status).toBe('active');
    });

    it('is idempotent: revoking twice keeps the version the first revocation produced', async () => {
      const { app } = setupTestApp();
      const revoke = () =>
        app.request(`${CONSENTS_PATH}/${PROFILE}/revoke`, {
          method: 'POST',
          headers: bearer(TOKEN_A),
        });

      await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ source_profile_id: PROFILE }),
      });

      const first = (await (await revoke()).json()) as { consent: { version: number } };
      const second = await revoke();
      const secondBody = (await second.json()) as { consent: { version: number } };

      expect(second.status).toBe(200);
      expect(secondBody.consent.version).toBe(first.consent.version);
    });

    it('answers 404 for another tenant’s grant', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_B, PROFILE);

      const response = await app.request(`${CONSENTS_PATH}/${PROFILE}/revoke`, {
        method: 'POST',
        headers: bearer(TOKEN_A),
      });

      expect(response.status).toBe(404);
      expect(store.grants.get(`${TENANT_B}:${PROFILE}`)?.status).toBe('active');
    });

    it('rejects an unlabelled body instead of ignoring a compare-and-set', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_A, PROFILE);

      const request = new Request(`http://localhost${CONSENTS_PATH}/${PROFILE}/revoke`, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Length': '20' }),
        body: JSON.stringify({ expected_version: 1 }),
      });
      const response = await app.request(request);

      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).error.code).toBe('INVALID_ARGUMENT');
      expect(store.revokeRequests).toHaveLength(0);
    });

    it('rejects a malformed revoke body', async () => {
      const { app, store } = setupTestApp();
      store.seed(TENANT_A, PROFILE);

      for (const body of ['not json', JSON.stringify({ expected_version: 0 })]) {
        const response = await app.request(`${CONSENTS_PATH}/${PROFILE}/revoke`, {
          method: 'POST',
          headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
          body,
        });

        expect(response.status).toBe(400);
      }

      expect(store.revokeRequests).toHaveLength(0);
      expect(store.grants.get(`${TENANT_A}:${PROFILE}`)?.status).toBe('active');
    });
  });
  describe('POST /v1/consents (body validation)', () => {
    it('rejects a body without a JSON content type', async () => {
      const { app, store } = setupTestApp();

      const response = await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A),
        body: JSON.stringify({ source_profile_id: PROFILE }),
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).error.code).toBe('INVALID_ARGUMENT');
      expect(store.grantRequests).toHaveLength(0);
    });

    it('rejects malformed JSON without echoing it', async () => {
      const { app } = setupTestApp();

      const response = await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: '{"source_profile_id":',
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorBody;
      expect(body.error.code).toBe('INVALID_ARGUMENT');
      expect(body.error.message).toBe('Invalid request input');
    });

    it('rejects a declared body above the byte cap before parsing it', async () => {
      const { app, store } = setupTestApp();

      const response = await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A, {
          'Content-Type': 'application/json',
          'Content-Length': String(MAX_CONSENT_BODY_BYTES + 1),
        }),
        body: JSON.stringify({ source_profile_id: PROFILE }),
      });

      expect(response.status).toBe(400);
      expect(store.grantRequests).toHaveLength(0);
    });

    it('rejects an unknown field such as tenant_id and never reaches the store', async () => {
      const { app, store } = setupTestApp();

      const response = await app.request(CONSENTS_PATH, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ source_profile_id: PROFILE, tenant_id: TENANT_B }),
      });

      expect(response.status).toBe(400);
      expect(store.grantRequests).toHaveLength(0);
      expect(store.grants.size).toBe(0);
    });

    it('rejects a missing or malformed source_profile_id', async () => {
      const { app, store } = setupTestApp();

      for (const payload of [{}, { source_profile_id: 'GH Release' }]) {
        const response = await app.request(CONSENTS_PATH, {
          method: 'POST',
          headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(400);
      }

      expect(store.grantRequests).toHaveLength(0);
    });

    it('ignores a tenant query parameter: the credential decides the tenant', async () => {
      const { app, store } = setupTestApp();

      const response = await app.request(`${CONSENTS_PATH}?tenant_id=${TENANT_B}`, {
        method: 'POST',
        headers: bearer(TOKEN_A, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ source_profile_id: PROFILE }),
      });

      expect(response.status).toBe(201);
      expect(store.grantRequests[0]?.tenantId).toBe(TENANT_A);
      expect(store.grants.has(`${TENANT_B}:${PROFILE}`)).toBe(false);
    });
  });
});
