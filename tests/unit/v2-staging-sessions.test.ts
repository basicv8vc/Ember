import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@ember/domain';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from '@ember/runtime-v2';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
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
) {
  const { d1 } = createNodeSqliteD1();
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

  const runtime = createStagingV2SessionRuntime({
    db: d1,
    appleBindings: { EMBER_APPLE_BUNDLE_ID: APPLE_BUNDLE_ID },
    appleKeyResolver: keyResolver,
    ...(allowedSubjectsRaw === undefined ? {} : { allowedSubjectsRaw }),
    bootstrapHead,
    projectConversation,
  });

  return { runtime, bootstrapHead, projectConversation };
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
});
