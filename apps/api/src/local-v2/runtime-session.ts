import type { B1SessionRecord } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { deterministicEdgeUuid } from '@ember/runtime-v2';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import {
  APPLE_DEFAULT_JWKS_CACHE_MAX_AGE_MS,
  APPLE_DEFAULT_JWKS_COOLDOWN_MS,
  APPLE_DEFAULT_JWKS_TIMEOUT_MS,
  APPLE_JWKS_URL,
} from '../auth/apple-identity.js';
import type { B1SessionRuntime } from '../auth/b1-auth-runtime.js';
import { createDevIdentityVerifier } from '../auth/identity-verifier.js';
import {
  createSessionService,
  SESSION_IDLE_TTL_MS,
  type B1SessionPorts,
} from '../auth/session-service.js';
import { resolveV2StagingSessionAllowedTenants } from './runtime-config.js';
import { getHead, type LocalRuntimeEnv } from './runtime-head.js';
import { createStagingV2SessionRuntime } from './staging-session-store.js';

const APPLE_KEY_RESOLVER: JWTVerifyGetKey = createRemoteJWKSet(new URL(APPLE_JWKS_URL), {
  timeoutDuration: APPLE_DEFAULT_JWKS_TIMEOUT_MS,
  cooldownDuration: APPLE_DEFAULT_JWKS_COOLDOWN_MS,
  cacheMaxAge: APPLE_DEFAULT_JWKS_CACHE_MAX_AGE_MS,
});

interface SessionRow extends B1SessionRecord {
  readonly principalId: string;
  readonly agentId: string;
  readonly rotatedTo: string | null;
}

const active = 'revokedAt IS NULL AND expiresAt > ? AND idleExpiresAt > ?';

function sessionDigest(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function createLocalSessions(env: LocalRuntimeEnv): B1SessionRuntime {
  const db = env.D1_RECOVERY;
  let initialized: Promise<unknown> | undefined;
  function ensureSessions() {
    // The local dev identity adapter shares the loopback D1 binding.
    initialized ??= db
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS local_v2_sessions (
        digest TEXT PRIMARY KEY, sessionId TEXT NOT NULL UNIQUE, consumerId TEXT NOT NULL,
        tenantId TEXT NOT NULL, principalId TEXT NOT NULL, agentId TEXT NOT NULL,
        expiresAt TEXT NOT NULL, idleExpiresAt TEXT NOT NULL, revokedAt TEXT, rotatedTo TEXT
      )
    `,
      )
      .run();
    return initialized;
  }

  async function revokeIfReused(digest: string, now: string) {
    const revoked = await db
      .prepare(
        `
      UPDATE local_v2_sessions SET revokedAt = ?
       WHERE revokedAt IS NULL AND consumerId = (
         SELECT consumerId FROM local_v2_sessions WHERE digest = ? AND rotatedTo IS NOT NULL
       )
    `,
      )
      .bind(now, digest)
      .run();
    if ((revoked.meta?.changes ?? 0) > 0) return true;
    return (
      (await db
        .prepare('SELECT rotatedTo FROM local_v2_sessions WHERE digest = ?')
        .bind(digest)
        .first<string>('rotatedTo')) !== null
    );
  }

  const ports: B1SessionPorts = {
    provisioning: {
      async provisionIdentityAndCreateSession(command) {
        if (command.provider !== 'dev') throw new DomainError('POLICY_DENIED');
        await ensureSessions();
        const [consumerId, tenantId, principalId, agentId, conversationId] = await Promise.all([
          deterministicEdgeUuid(`local-v2:consumer:${command.providerSubject}`),
          deterministicEdgeUuid(`local-v2:tenant:${command.providerSubject}`),
          deterministicEdgeUuid(`local-v2:principal:${command.providerSubject}`),
          deterministicEdgeUuid(`local-v2:agent:${command.providerSubject}`),
          deterministicEdgeUuid(`local-v2:conversation:${command.providerSubject}`),
        ]);
        await getHead(env, tenantId, agentId).bootstrap({ tenantId, agentId }, conversationId);
        const session = {
          sessionId: crypto.randomUUID(),
          consumerId,
          tenantId,
          expiresAt: command.expiresAt,
          idleExpiresAt: command.idleExpiresAt,
          revokedAt: null,
        };
        await db
          .prepare(
            `
          INSERT INTO local_v2_sessions
            (digest, sessionId, consumerId, tenantId, principalId, agentId, expiresAt, idleExpiresAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .bind(
            sessionDigest(command.tokenDigest),
            session.sessionId,
            consumerId,
            tenantId,
            principalId,
            agentId,
            session.expiresAt,
            session.idleExpiresAt,
          )
          .run();
        return {
          identity: { consumerId, tenantId, principalId, agentId, conversationId },
          session,
        };
      },
    },
    sessions: {
      async findActiveSession(tokenDigest) {
        await ensureSessions();
        const digest = sessionDigest(tokenDigest);
        const now = new Date().toISOString();
        const session = await db
          .prepare(`SELECT * FROM local_v2_sessions WHERE digest = ? AND ${active}`)
          .bind(digest, now, now)
          .first<SessionRow>();
        if (session === null) {
          await revokeIfReused(digest, now);
          return null;
        }
        const idleExpiresAt = new Date(Date.now() + SESSION_IDLE_TTL_MS).toISOString();
        const nextIdle = idleExpiresAt < session.expiresAt ? idleExpiresAt : session.expiresAt;
        if (Date.parse(nextIdle) > Date.parse(session.idleExpiresAt) + 3_600_000) {
          const slid = await db
            .prepare(
              `UPDATE local_v2_sessions SET idleExpiresAt = ?
              WHERE digest = ? AND ${active} AND idleExpiresAt < ?`,
            )
            .bind(nextIdle, digest, now, now, nextIdle)
            .run();
          if ((slid.meta?.changes ?? 0) > 0) {
            return {
              session: { ...session, idleExpiresAt: nextIdle },
              principalId: session.principalId,
              policyVersion: 1,
            };
          }
        }
        return { session, principalId: session.principalId, policyVersion: 1 };
      },
      async rotateSession(command) {
        await ensureSessions();
        const current = sessionDigest(command.currentTokenDigest);
        const next = sessionDigest(command.newTokenDigest);
        const now = new Date().toISOString();
        const [, created] = await db.batch<SessionRow>([
          db
            .prepare(
              `UPDATE local_v2_sessions SET revokedAt = ?, rotatedTo = ?
            WHERE digest = ? AND ${active}`,
            )
            .bind(now, next, current, now, now),
          db
            .prepare(
              `
            INSERT INTO local_v2_sessions
              (digest, sessionId, consumerId, tenantId, principalId, agentId, expiresAt, idleExpiresAt)
              SELECT ?, ?, consumerId, tenantId, principalId, agentId, ?, ?
              FROM local_v2_sessions WHERE digest = ? AND rotatedTo = ?
            RETURNING *
          `,
            )
            .bind(
              next,
              crypto.randomUUID(),
              command.expiresAt,
              command.idleExpiresAt,
              current,
              next,
            ),
        ]);
        const session = created?.results[0];
        if (session !== undefined) return { kind: 'rotated', session };
        return { kind: (await revokeIfReused(current, now)) ? 'reuse_detected' : 'inactive' };
      },
      async revokeSession({ sessionId, tenantId }) {
        await db
          .prepare(
            `UPDATE local_v2_sessions SET revokedAt = ?
          WHERE sessionId = ? AND tenantId = ? AND revokedAt IS NULL`,
          )
          .bind(new Date().toISOString(), sessionId, tenantId)
          .run();
      },
    },
    me: {
      async getMeForTenant(tenantId) {
        const identity = await db
          .prepare('SELECT consumerId, agentId FROM local_v2_sessions WHERE tenantId = ? LIMIT 1')
          .bind(tenantId)
          .first<Pick<SessionRow, 'consumerId' | 'agentId'>>();
        if (identity === null) return null;
        const conversation = await getHead(env, tenantId, identity.agentId).projectConversation({
          tenantId,
          agentId: identity.agentId,
        });
        if (conversation === null) return null;
        return {
          consumer_id: identity.consumerId,
          agent: { agent_id: identity.agentId, display_name: 'Ember' },
          conversation,
        };
      },
    },
  };
  return {
    service: createSessionService({ ports }),
    appleVerifier: { provider: 'apple', verify: () => Promise.resolve(null) },
    devVerifier: createDevIdentityVerifier(),
    devProvider: { evaluate: () => ({ enabled: true, deniedBy: [] }) },
    me: ports.me,
  };
}

export function createStagingV2Sessions(env: LocalRuntimeEnv): B1SessionRuntime {
  const bundleId = env.EMBER_APPLE_BUNDLE_ID?.trim() ?? '';
  if (bundleId.length === 0) {
    throw new Error('EMBER_APPLE_BUNDLE_ID is required in v2-staging');
  }
  const allowedTenantIds = resolveV2StagingSessionAllowedTenants(env);
  return createStagingV2SessionRuntime({
    db: env.D1_RECOVERY,
    appleBindings: {
      EMBER_APPLE_BUNDLE_ID: bundleId,
      ...(env.EMBER_APPLE_CLOCK_SKEW_SECONDS === undefined
        ? {}
        : { EMBER_APPLE_CLOCK_SKEW_SECONDS: env.EMBER_APPLE_CLOCK_SKEW_SECONDS }),
      ...(env.EMBER_APPLE_MAX_TOKEN_AGE_SECONDS === undefined
        ? {}
        : { EMBER_APPLE_MAX_TOKEN_AGE_SECONDS: env.EMBER_APPLE_MAX_TOKEN_AGE_SECONDS }),
      ...(env.EMBER_APPLE_JWKS_TIMEOUT_MS === undefined
        ? {}
        : { EMBER_APPLE_JWKS_TIMEOUT_MS: env.EMBER_APPLE_JWKS_TIMEOUT_MS }),
      ...(env.EMBER_APPLE_JWKS_COOLDOWN_MS === undefined
        ? {}
        : { EMBER_APPLE_JWKS_COOLDOWN_MS: env.EMBER_APPLE_JWKS_COOLDOWN_MS }),
      ...(env.EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS === undefined
        ? {}
        : { EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS: env.EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS }),
    },
    appleKeyResolver: APPLE_KEY_RESOLVER,
    ...(env.EMBER_V2_STAGING_ALLOWED_SUBJECTS === undefined
      ? {}
      : { allowedSubjectsRaw: env.EMBER_V2_STAGING_ALLOWED_SUBJECTS }),
    ...(allowedTenantIds === undefined ? {} : { allowedTenantIds }),
    bootstrapHead: (scope, conversationId) =>
      getHead(env, scope.tenantId, scope.agentId).bootstrap(scope, conversationId),
    projectConversation: (scope) =>
      getHead(env, scope.tenantId, scope.agentId).projectConversation(scope),
  });
}
