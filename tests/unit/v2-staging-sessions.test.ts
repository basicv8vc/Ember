import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, isDomainError } from '@ember/domain';
import {
  deterministicEdgeUuid,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from '@ember/runtime-v2';
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createB1SessionRoutes } from '../../apps/api/src/auth/session-routes.js';
import {
  generateRequestId,
  requestIdMiddleware,
  type AppBindings,
} from '../../apps/api/src/http/app-context.js';
import { respondWithDomainError } from '../../apps/api/src/http/error-mapping.js';
import {
  resolveV2AlphaTenantAllowlist,
  resolveV2StagingSessionAllowedTenants,
} from '../../apps/api/src/local-v2/runtime-config.js';
import { createStagingV2SessionRuntime } from '../../apps/api/src/local-v2/staging-session-store.js';

const APPLE_BUNDLE_ID = 'com.basicv8vc.ember';

function createNodeSqliteD1(): { db: DatabaseSync; d1: D1DatabaseLike } {
  const db = new DatabaseSync(':memory:');

  const makeStatement = (query: string, bound: unknown[] = []): D1PreparedStatementLike => ({
    bind: (...values: unknown[]) => makeStatement(query, values),
    first: <T = Record<string, unknown>>(colName?: string): Promise<T | null> => {
      const row = db
        .prepare(query)
        .get(...(bound as Array<string | number | Uint8Array | null>)) as
        Record<string, unknown> | undefined;
      if (!row) return Promise.resolve(null);
      if (colName !== undefined) {
        return Promise.resolve((row[colName] as T | undefined) ?? null);
      }
      return Promise.resolve(row as T);
    },
    run: <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => {
      const info = db.prepare(query).run(...(bound as Array<string | number | Uint8Array | null>));
      return Promise.resolve({
        results: [],
        success: true,
        meta: { changes: Number(info.changes) },
      });
    },
    all: <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => {
      const rows = db
        .prepare(query)
        .all(...(bound as Array<string | number | Uint8Array | null>)) as T[];
      return Promise.resolve({ results: rows, success: true });
    },
  });

  const d1: D1DatabaseLike = {
    prepare: (query: string) => makeStatement(query),
    batch: async <T = Record<string, unknown>>(statements: D1PreparedStatementLike[]) => {
      const results: Array<D1ResultLike<T>> = [];
      for (const stmt of statements) {
        results.push(await stmt.all<T>());
      }
      return results;
    },
  };

  return { db, d1 };
}

async function createAppleTestSigner() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = 'test-apple-key-1';
  const keyResolver = createLocalJWKSet({
    keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }],
  });

  async function signIdentityToken(subject: string, rawNonce: string): Promise<string> {
    const hashedNonce = createHash('sha256').update(rawNonce, 'utf8').digest('hex');
    return new SignJWT({ nonce: hashedNonce })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://appleid.apple.com')
      .setAudience(APPLE_BUNDLE_ID)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  return { keyResolver, signIdentityToken };
}

function createFixture(
  keyResolver: ReturnType<typeof createLocalJWKSet>,
  allowedSubjectsRaw?: string,
  allowedTenantIds?: ReadonlySet<string> | null,
) {
  const { db, d1 } = createNodeSqliteD1();
  const conversations = new Map<string, string>();
  const bootstrapHead = vi.fn(
    (scope: { readonly tenantId: string; readonly agentId: string }, conversationId: string) => {
      conversations.set(`${scope.tenantId}:${scope.agentId}`, conversationId);
      return Promise.resolve();
    },
  );
  const projectConversation = vi.fn(
    (scope: { readonly tenantId: string; readonly agentId: string }) => {
      const conversationId = conversations.get(`${scope.tenantId}:${scope.agentId}`);
      if (conversationId === undefined) return Promise.resolve(null);
      return Promise.resolve({
        conversation_id: conversationId,
        transcript_epoch: 0,
        created_at: '2026-11-20T12:00:00.000Z',
        updated_at: '2026-11-20T12:00:00.000Z',
      });
    },
  );

  const buildRuntime = (opts?: {
    readonly allowedSubjectsRaw?: string;
    readonly allowedTenantIds?: ReadonlySet<string> | null;
  }) =>
    createStagingV2SessionRuntime({
      db: d1,
      appleBindings: { EMBER_APPLE_BUNDLE_ID: APPLE_BUNDLE_ID },
      appleKeyResolver: keyResolver,
      ...(opts?.allowedSubjectsRaw === undefined
        ? {}
        : { allowedSubjectsRaw: opts.allowedSubjectsRaw }),
      ...(opts?.allowedTenantIds === undefined ? {} : { allowedTenantIds: opts.allowedTenantIds }),
      bootstrapHead,
      projectConversation,
    });

  const buildApp = (runtime: ReturnType<typeof createStagingV2SessionRuntime>) => {
    const app = new Hono<AppBindings>();
    app.use('*', requestIdMiddleware(generateRequestId));
    app.onError((error, c) =>
      isDomainError(error) ? respondWithDomainError(c, error) : c.json({ error }, 500),
    );
    app.route('/v1', createB1SessionRoutes({ runtime }));
    return app;
  };

  const runtime = buildRuntime({
    ...(allowedSubjectsRaw === undefined ? {} : { allowedSubjectsRaw }),
    ...(allowedTenantIds === undefined ? {} : { allowedTenantIds }),
  });

  return { db, d1, runtime, buildRuntime, buildApp, bootstrapHead, projectConversation };
}

describe('V2 staging D1 session runtime (Apple Sign In, rotation, replay, tenant isolation)', () => {
  it('verifies Apple Sign In, enforces single-use D1 nonce replay fence, and denies dev provider', async () => {
    const { keyResolver, signIdentityToken } = await createAppleTestSigner();
    const { runtime, bootstrapHead } = createFixture(keyResolver);

    expect(runtime.devProvider.evaluate().enabled).toBe(false);

    const rawNonce = 'nonce-login-0001-0000000000000000';
    const token = await signIdentityToken('apple-user-alpha', rawNonce);

    const verified = await runtime.appleVerifier.verify({
      identityToken: token,
      nonce: rawNonce,
    });
    expect(verified).toEqual({ provider: 'apple', providerSubject: 'apple-user-alpha' });

    // Replaying the exact same Apple JWT + nonce must be rejected by D1 nonce fence.
    const replayed = await runtime.appleVerifier.verify({
      identityToken: token,
      nonce: rawNonce,
    });
    expect(replayed).toBeNull();

    // Provisioning a session for the verified Apple identity works and bootstraps the head.
    const created = await runtime.service.createSession({
      provider: 'apple',
      providerSubject: 'apple-user-alpha',
    });
    expect(bootstrapHead).toHaveBeenCalledTimes(1);
    const active = await runtime.service.resolveActiveSession(created.access_token);
    expect(active).not.toBeNull();
    expect(active?.session.consumerId).toBe(created.consumer_id);

    // Direct dev provider provisioning must fail closed with POLICY_DENIED.
    await expect(
      runtime.service.createSession({ provider: 'dev', providerSubject: 'should-fail' }),
    ).rejects.toThrow(DomainError);
  });

  it('enforces optional EMBER_V2_STAGING_ALLOWED_SUBJECTS allowlist', async () => {
    const { keyResolver } = await createAppleTestSigner();
    const { runtime } = createFixture(keyResolver, 'founder-sub-1, qa-sub-2');

    const allowed = await runtime.service.createSession({
      provider: 'apple',
      providerSubject: 'founder-sub-1',
    });
    expect(allowed.access_token.length).toBeGreaterThan(20);

    await expect(
      runtime.service.createSession({ provider: 'apple', providerSubject: 'unlisted-sub' }),
    ).rejects.toThrow(DomainError);
  });

  it('rotates tokens and revokes the entire consumer session chain on old-token replay', async () => {
    const { keyResolver } = await createAppleTestSigner();
    const { runtime } = createFixture(keyResolver);

    const initial = await runtime.service.createSession({
      provider: 'apple',
      providerSubject: 'apple-user-rotate',
    });
    const rotated = await runtime.service.refreshSession(initial.access_token);
    expect(rotated).not.toBeNull();
    if (rotated === null) throw new Error('expected rotated session');
    expect(rotated.access_token).not.toBe(initial.access_token);

    // New rotated token is active.
    const activeAfterRotate = await runtime.service.resolveActiveSession(rotated.access_token);
    expect(activeAfterRotate?.session.consumerId).toBe(initial.consumer_id);

    // Presenting the old rotated-out token on refresh must be rejected AND revoke the new token.
    expect(await runtime.service.refreshSession(initial.access_token)).toBeNull();
    expect(await runtime.service.resolveActiveSession(rotated.access_token)).toBeNull();
  });

  it('also revokes active sessions if a rotated-out token is presented to resolveActiveSession', async () => {
    const { keyResolver } = await createAppleTestSigner();
    const { runtime } = createFixture(keyResolver);

    const initial = await runtime.service.createSession({
      provider: 'apple',
      providerSubject: 'apple-user-replay-resolve',
    });
    const rotated = await runtime.service.refreshSession(initial.access_token);
    expect(rotated).not.toBeNull();
    if (rotated === null) throw new Error('expected rotated session');

    // Old token returns null and triggers consumer-wide revocation.
    expect(await runtime.service.resolveActiveSession(initial.access_token)).toBeNull();
    expect(await runtime.service.resolveActiveSession(rotated.access_token)).toBeNull();
  });

  it('isolates tenants across distinct Apple subjects for sessions, /me projection, and logout', async () => {
    const { keyResolver } = await createAppleTestSigner();
    const { runtime } = createFixture(keyResolver);

    const sessionA = await runtime.service.createSession({
      provider: 'apple',
      providerSubject: 'apple-tenant-a',
    });
    const sessionB = await runtime.service.createSession({
      provider: 'apple',
      providerSubject: 'apple-tenant-b',
    });

    const resolvedA = await runtime.service.resolveActiveSession(sessionA.access_token);
    const resolvedB = await runtime.service.resolveActiveSession(sessionB.access_token);
    expect(resolvedA).not.toBeNull();
    expect(resolvedB).not.toBeNull();

    const tenantA = resolvedA!.auth.tenantId;
    const tenantB = resolvedB!.auth.tenantId;
    expect(tenantA).not.toBe(tenantB);
    expect(sessionA.consumer_id).not.toBe(sessionB.consumer_id);

    const meA = await runtime.me.getMeForTenant(tenantA);
    const meB = await runtime.me.getMeForTenant(tenantB);
    expect(meA?.consumer_id).toBe(sessionA.consumer_id);
    expect(meB?.consumer_id).toBe(sessionB.consumer_id);
    expect(meA?.conversation.conversation_id).not.toBe(meB?.conversation.conversation_id);

    // Logging out tenant A must not revoke tenant B.
    await runtime.service.logout(sessionA.access_token);
    expect(await runtime.service.resolveActiveSession(sessionA.access_token)).toBeNull();
    expect((await runtime.service.resolveActiveSession(sessionB.access_token))?.auth.tenantId).toBe(
      tenantB,
    );
  });

  it('enforces derived-tenant login guard in G3 real allowlist mode without requiring EMBER_V2_STAGING_ALLOWED_SUBJECTS', async () => {
    const { keyResolver, signIdentityToken } = await createAppleTestSigner();
    const founderSub = 'founder-apple-sub-001';
    const otherSub = 'other-apple-sub-002';
    const founderTenantId = await deterministicEdgeUuid(`v2-staging:tenant:${founderSub}`);
    const allowlist = resolveV2AlphaTenantAllowlist(
      {
        EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
        EMBER_MODEL_ALPHA_TENANT_IDS: founderTenantId,
      },
      { maxTenants: 1 },
    );

    const { db, buildRuntime, buildApp, bootstrapHead } = createFixture(
      keyResolver,
      undefined,
      allowlist.tenantIds,
    );
    const app = buildApp(buildRuntime({ allowedTenantIds: allowlist.tenantIds }));

    const postAppleLogin = async (subject: string, nonce: string) =>
      app.request('/v1/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'apple',
          identity_token: await signIdentityToken(subject, nonce),
          nonce,
        }),
      });

    // Allowed Apple JWT succeeds (201) -> creates one session and bootstraps one head for derived tenant.
    const allowedResp = await postAppleLogin(founderSub, 'nonce-allow-0001-0000000000000000');
    expect(allowedResp.status).toBe(201);
    const allowedDto = (await allowedResp.json()) as { access_token: string; consumer_id: string };
    expect(bootstrapHead).toHaveBeenCalledTimes(1);
    expect(bootstrapHead.mock.calls[0]?.[0].tenantId).toBe(founderTenantId);

    const meResp = await app.request('/v1/me', {
      headers: { authorization: `Bearer ${allowedDto.access_token}` },
    });
    expect(meResp.status).toBe(200);

    // Other valid Apple JWT is rejected (403 POLICY_DENIED) with no session or AgentHead created.
    const deniedResp = await postAppleLogin(otherSub, 'nonce-deny-0002-0000000000000000');
    expect(deniedResp.status).toBe(403);
    const deniedBody = (await deniedResp.json()) as { error: { code: string } };
    expect(deniedBody.error.code).toBe('POLICY_DENIED');
    expect(bootstrapHead).toHaveBeenCalledTimes(1);

    const sessionRows = db.prepare('SELECT tenantId FROM v2_staging_sessions').all() as Array<{
      tenantId: string;
    }>;
    expect(sessionRows).toEqual([{ tenantId: founderTenantId }]);
  });

  it('blocks pre-existing Fake-mode non-allowlisted sessions on Real read and refresh without mutating idle TTL or creating successor sessions', async () => {
    const { keyResolver, signIdentityToken } = await createAppleTestSigner();
    const founderSub = 'founder-fake-to-real';
    const otherSub = 'other-fake-to-real';
    const founderTenantId = await deterministicEdgeUuid(`v2-staging:tenant:${founderSub}`);
    const otherTenantId = await deterministicEdgeUuid(`v2-staging:tenant:${otherSub}`);

    const { db, buildRuntime, buildApp } = createFixture(keyResolver);

    // 1. In Fake mode (no tenant allowlist), both users log in and obtain bearer sessions.
    const fakeApp = buildApp(buildRuntime());
    const login = async (app: Hono<AppBindings>, subject: string, nonce: string) => {
      const res = await app.request('/v1/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'apple',
          identity_token: await signIdentityToken(subject, nonce),
          nonce,
        }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { access_token: string; session_id: string };
    };
    const founderFake = await login(fakeApp, founderSub, 'nonce-f1-00000000000000000000');
    const otherFake = await login(fakeApp, otherSub, 'nonce-f2-00000000000000000000');

    // Backdate otherFake's idleExpiresAt by 2 hours (still active) so a leaky findActiveSession would slide it.
    const staleIdle = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE v2_staging_sessions SET idleExpiresAt = ? WHERE sessionId = ?').run(
      staleIdle,
      otherFake.session_id,
    );

    // 2. Switch to Real allowlist mode sharing the same D1 database.
    const realApp = buildApp(buildRuntime({ allowedTenantIds: new Set([founderTenantId]) }));

    // Pre-existing unauthorized bearer session is rejected (401) on GET /v1/me with zero idle update.
    const otherMe = await realApp.request('/v1/me', {
      headers: { authorization: `Bearer ${otherFake.access_token}` },
    });
    expect(otherMe.status).toBe(401);
    const afterMeRow = db
      .prepare(
        'SELECT idleExpiresAt, revokedAt, rotatedTo FROM v2_staging_sessions WHERE sessionId = ?',
      )
      .get(otherFake.session_id) as {
      idleExpiresAt: string;
      revokedAt: string | null;
      rotatedTo: string | null;
    };
    expect(afterMeRow.idleExpiresAt).toBe(staleIdle);
    expect(afterMeRow.revokedAt).toBeNull();
    expect(afterMeRow.rotatedTo).toBeNull();

    // Pre-existing unauthorized bearer session is rejected (401) on refresh with zero rotation/successor.
    const otherRefresh = await realApp.request('/v1/auth/session/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${otherFake.access_token}` },
    });
    expect(otherRefresh.status).toBe(401);
    const otherRowsAfterRefresh = db
      .prepare('SELECT sessionId, rotatedTo FROM v2_staging_sessions WHERE tenantId = ?')
      .all(otherTenantId) as Array<{ sessionId: string; rotatedTo: string | null }>;
    expect(otherRowsAfterRefresh).toEqual([{ sessionId: otherFake.session_id, rotatedTo: null }]);

    // Pre-existing Founder bearer session continues working on read and refresh in Real mode.
    const founderMe = await realApp.request('/v1/me', {
      headers: { authorization: `Bearer ${founderFake.access_token}` },
    });
    expect(founderMe.status).toBe(200);
    const founderRefresh = await realApp.request('/v1/auth/session/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${founderFake.access_token}` },
    });
    expect(founderRefresh.status).toBe(200);
  });

  it('requires intersection when both EMBER_V2_STAGING_ALLOWED_SUBJECTS and derived-tenant allowlist are configured', async () => {
    const { keyResolver } = await createAppleTestSigner();
    const founderSub = 'founder-intersection';
    const subjectOnlySub = 'subject-only-sub';
    const founderTenantId = await deterministicEdgeUuid(`v2-staging:tenant:${founderSub}`);

    const { runtime, bootstrapHead } = createFixture(
      keyResolver,
      `${founderSub}, ${subjectOnlySub}`,
      new Set([founderTenantId]),
    );

    // Subject allowed, derived tenant NOT allowed -> POLICY_DENIED.
    await expect(
      runtime.service.createSession({ provider: 'apple', providerSubject: subjectOnlySub }),
    ).rejects.toThrow(DomainError);

    // Derived tenant allowed, subject NOT allowed -> POLICY_DENIED.
    const { runtime: tenantOnlyMatch } = createFixture(
      keyResolver,
      subjectOnlySub,
      new Set([founderTenantId]),
    );
    await expect(
      tenantOnlyMatch.service.createSession({ provider: 'apple', providerSubject: founderSub }),
    ).rejects.toThrow(DomainError);

    // Intersection passes when both match.
    const allowed = await runtime.service.createSession({
      provider: 'apple',
      providerSubject: founderSub,
    });
    expect(allowed.access_token.length).toBeGreaterThan(20);
    expect(bootstrapHead).toHaveBeenCalledTimes(1);
  });

  it('fails closed in resolveV2StagingSessionAllowedTenants on invalid/missing/multi-tenant allowlists in real mode while preserving fake mode', () => {
    // Fake mode preserves multi-tenant staging even without EMBER_MODEL_ALPHA_TENANT_IDS.
    expect(resolveV2StagingSessionAllowedTenants({ EMBER_MODEL_MODE: 'fake' })).toBeUndefined();

    const validTenant = '11111111-1111-4111-8111-111111111111';
    const secondTenant = '22222222-2222-4222-8222-222222222222';

    expect(
      resolveV2StagingSessionAllowedTenants({
        EMBER_MODEL_MODE: 'real',
        EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
        EMBER_MODEL_ALPHA_TENANT_IDS: validTenant,
      }),
    ).toEqual(new Set([validTenant]));

    expect(() =>
      resolveV2StagingSessionAllowedTenants({
        EMBER_MODEL_MODE: 'real',
        EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
      }),
    ).toThrow(/EMBER_MODEL_ALPHA_TENANT_IDS/);

    expect(() =>
      resolveV2StagingSessionAllowedTenants({
        EMBER_MODEL_MODE: 'real',
        EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
        EMBER_MODEL_ALPHA_TENANT_IDS: 'not-a-uuid',
      }),
    ).toThrow(/Invalid UUID/);

    expect(() =>
      resolveV2StagingSessionAllowedTenants({
        EMBER_MODEL_MODE: 'real',
        EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
        EMBER_MODEL_ALPHA_TENANT_IDS: `${validTenant},${secondTenant}`,
      }),
    ).toThrow(/at most 1 tenant/);

    expect(() =>
      resolveV2StagingSessionAllowedTenants({
        EMBER_MODEL_MODE: 'real',
        EMBER_MODEL_ALPHA_SCOPE: 'authenticated_tenants',
        EMBER_MODEL_ALPHA_TENANT_IDS: validTenant,
      }),
    ).toThrow(/allowlist/);
  });
});
