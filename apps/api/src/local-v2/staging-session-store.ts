import { createHash } from 'node:crypto';
import type { B1SessionRecord } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { deterministicEdgeUuid, type D1DatabaseLike } from '@ember/runtime-v2';
import type { JWTVerifyGetKey } from 'jose';
import { createAppleIdentityVerifier } from '../auth/apple-identity.js';
import type { B1SessionRuntime } from '../auth/b1-auth-runtime.js';
import type { DevProviderPolicy } from '../auth/dev-provider-policy.js';
import {
  createSessionService,
  SESSION_IDLE_TTL_MS,
  type B1SessionPorts,
} from '../auth/session-service.js';
import {
  createCloudflareAppleNonceVerifier,
  type AppleNonceReplayStore,
} from '../cloudflare-apple-replay.js';
import {
  loadCloudflareAppleVerifierConfig,
  type CloudflareAppleVerifierBindings,
} from '../cloudflare-worker-apple-config.js';
import { parseAllowedSubjects } from './runtime-config.js';

interface SessionRow extends B1SessionRecord {
  readonly principalId: string;
  readonly agentId: string;
  readonly rotatedTo: string | null;
}

const ACTIVE_SESSION_PREDICATE = 'revokedAt IS NULL AND expiresAt > ? AND idleExpiresAt > ?';
const APPLE_NONCE_REPLAY_RETENTION_MS = 80 * 60 * 1000;

export const DENY_DEV_PROVIDER: DevProviderPolicy = Object.freeze({
  evaluate: () => ({
    enabled: false,
    deniedBy: Object.freeze([
      'production_environment',
      'opt_in_missing',
      'not_isolated_environment',
      'listener_not_loopback',
    ] as const),
  }),
});

function sessionDigest(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export interface StagingV2SessionStoreDeps {
  readonly db: D1DatabaseLike;
  readonly appleBindings: CloudflareAppleVerifierBindings;
  readonly appleKeyResolver: JWTVerifyGetKey;
  readonly allowedSubjectsRaw?: string;
  readonly allowedTenantIds?: ReadonlySet<string> | null;
  bootstrapHead(
    scope: { readonly tenantId: string; readonly agentId: string },
    conversationId: string,
  ): Promise<unknown>;
  projectConversation(scope: {
    readonly tenantId: string;
    readonly agentId: string;
  }): Promise<
    | NonNullable<Awaited<ReturnType<B1SessionRuntime['me']['getMeForTenant']>>>['conversation']
    | null
  >;
}

/**
 * Isolated V2 staging session runtime (Option A):
 * - Real Apple Sign In verification (RS256 JWKS + D1 SHA-256 nonce replay fence)
 * - Strictly denies the dev identity provider
 * - Optional EMBER_V2_STAGING_ALLOWED_SUBJECTS comma-separated allowlist
 * - Optional derived-tenant allowlist (enforced in G3 real mode via EMBER_MODEL_ALPHA_TENANT_IDS)
 * - Isolated D1 tables (v2_staging_sessions, v2_staging_apple_nonce_replays)
 */
export function createStagingV2SessionRuntime(deps: StagingV2SessionStoreDeps): B1SessionRuntime {
  const { db } = deps;
  const allowedSubjects = parseAllowedSubjects(deps.allowedSubjectsRaw);
  const allowedTenantIds =
    deps.allowedTenantIds === undefined || deps.allowedTenantIds === null
      ? null
      : new Set(Array.from(deps.allowedTenantIds, (id) => id.trim().toLowerCase()));
  if (allowedTenantIds !== null && allowedTenantIds.size === 0) {
    throw new Error('allowedTenantIds must not be empty when tenant allowlist guard is enabled');
  }

  function isTenantAllowed(tenantId: string): boolean {
    return allowedTenantIds === null || allowedTenantIds.has(tenantId.trim().toLowerCase());
  }

  let initialized: Promise<unknown> | undefined;
  function ensureTables() {
    initialized ??= db.batch([
      db.prepare(
        `CREATE TABLE IF NOT EXISTS v2_staging_sessions (
          digest TEXT PRIMARY KEY, sessionId TEXT NOT NULL UNIQUE, consumerId TEXT NOT NULL,
          tenantId TEXT NOT NULL, principalId TEXT NOT NULL, agentId TEXT NOT NULL,
          expiresAt TEXT NOT NULL, idleExpiresAt TEXT NOT NULL, revokedAt TEXT, rotatedTo TEXT
        )`,
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS v2_staging_apple_nonce_replays (
          nonceDigest TEXT PRIMARY KEY,
          expiresAtMs INTEGER NOT NULL
        )`,
      ),
    ]);
    return initialized;
  }

  const nonceStore: AppleNonceReplayStore = Object.freeze({
    async consume(rawNonce: string): Promise<boolean> {
      const digest = createHash('sha256').update(rawNonce, 'utf8').digest('hex');
      const nowMs = Date.now();
      const expiresAtMs = nowMs + APPLE_NONCE_REPLAY_RETENTION_MS;
      try {
        await ensureTables();
        await db
          .prepare('DELETE FROM v2_staging_apple_nonce_replays WHERE expiresAtMs <= ?')
          .bind(nowMs)
          .run();
        const inserted = await db
          .prepare(
            'INSERT OR IGNORE INTO v2_staging_apple_nonce_replays (nonceDigest, expiresAtMs) VALUES (?, ?)',
          )
          .bind(digest, expiresAtMs)
          .run();
        return (inserted.meta?.changes ?? 0) === 1;
      } catch {
        throw new DomainError('DB_UNAVAILABLE', 'Apple nonce replay check is unavailable');
      }
    },
  });

  const appleVerifier = createCloudflareAppleNonceVerifier(
    createAppleIdentityVerifier(
      loadCloudflareAppleVerifierConfig(deps.appleBindings, deps.appleKeyResolver),
    ),
    nonceStore,
  );

  async function revokeIfReused(digest: string, now: string) {
    const revoked = await db
      .prepare(
        `UPDATE v2_staging_sessions SET revokedAt = ?
         WHERE revokedAt IS NULL AND consumerId = (
           SELECT consumerId FROM v2_staging_sessions WHERE digest = ? AND rotatedTo IS NOT NULL
         )`,
      )
      .bind(now, digest)
      .run();
    if ((revoked.meta?.changes ?? 0) > 0) return true;
    return (
      (await db
        .prepare('SELECT rotatedTo FROM v2_staging_sessions WHERE digest = ?')
        .bind(digest)
        .first<string>('rotatedTo')) !== null
    );
  }

  const ports: B1SessionPorts = {
    provisioning: {
      async provisionIdentityAndCreateSession(command) {
        if (command.provider !== 'apple') throw new DomainError('POLICY_DENIED');
        if (allowedSubjects !== null && !allowedSubjects.has(command.providerSubject)) {
          throw new DomainError('POLICY_DENIED');
        }
        const tenantId = await deterministicEdgeUuid(
          `v2-staging:tenant:${command.providerSubject}`,
        );
        if (!isTenantAllowed(tenantId)) {
          throw new DomainError('POLICY_DENIED');
        }
        await ensureTables();
        const [consumerId, principalId, agentId, conversationId] = await Promise.all([
          deterministicEdgeUuid(`v2-staging:consumer:${command.providerSubject}`),
          deterministicEdgeUuid(`v2-staging:principal:${command.providerSubject}`),
          deterministicEdgeUuid(`v2-staging:agent:${command.providerSubject}`),
          deterministicEdgeUuid(`v2-staging:conversation:${command.providerSubject}`),
        ]);
        await deps.bootstrapHead({ tenantId, agentId }, conversationId);
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
            `INSERT INTO v2_staging_sessions
              (digest, sessionId, consumerId, tenantId, principalId, agentId, expiresAt, idleExpiresAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            sessionDigest(command.tokenDigest),
            session.sessionId,
            consumerId,
            tenantId,
            principalId,
            agentId,
            command.expiresAt,
            command.idleExpiresAt,
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
        await ensureTables();
        const digest = sessionDigest(tokenDigest);
        const now = new Date().toISOString();
        const session = await db
          .prepare(
            `SELECT * FROM v2_staging_sessions WHERE digest = ? AND ${ACTIVE_SESSION_PREDICATE}`,
          )
          .bind(digest, now, now)
          .first<SessionRow>();
        if (session === null) {
          await revokeIfReused(digest, now);
          return null;
        }
        if (!isTenantAllowed(session.tenantId)) {
          return null;
        }
        const idleExpiresAt = new Date(Date.now() + SESSION_IDLE_TTL_MS).toISOString();
        const nextIdle = idleExpiresAt < session.expiresAt ? idleExpiresAt : session.expiresAt;
        if (Date.parse(nextIdle) > Date.parse(session.idleExpiresAt) + 3_600_000) {
          const slid = await db
            .prepare(
              `UPDATE v2_staging_sessions SET idleExpiresAt = ?
               WHERE digest = ? AND ${ACTIVE_SESSION_PREDICATE} AND idleExpiresAt < ?`,
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
        await ensureTables();
        const current = sessionDigest(command.currentTokenDigest);
        if (allowedTenantIds !== null) {
          const existing = await db
            .prepare('SELECT tenantId FROM v2_staging_sessions WHERE digest = ?')
            .bind(current)
            .first<Pick<SessionRow, 'tenantId'>>();
          if (existing === null || !isTenantAllowed(existing.tenantId)) {
            return { kind: 'inactive' };
          }
        }
        const next = sessionDigest(command.newTokenDigest);
        const now = new Date().toISOString();
        const [, created] = await db.batch<SessionRow>([
          db
            .prepare(
              `UPDATE v2_staging_sessions SET revokedAt = ?, rotatedTo = ?
               WHERE digest = ? AND ${ACTIVE_SESSION_PREDICATE}`,
            )
            .bind(now, next, current, now, now),
          db
            .prepare(
              `INSERT INTO v2_staging_sessions
                (digest, sessionId, consumerId, tenantId, principalId, agentId, expiresAt, idleExpiresAt)
              SELECT ?, ?, consumerId, tenantId, principalId, agentId, ?, ?
              FROM v2_staging_sessions WHERE digest = ? AND rotatedTo = ?
              RETURNING *`,
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
        await ensureTables();
        await db
          .prepare(
            `UPDATE v2_staging_sessions SET revokedAt = ?
             WHERE sessionId = ? AND tenantId = ? AND revokedAt IS NULL`,
          )
          .bind(new Date().toISOString(), sessionId, tenantId)
          .run();
      },
    },
    me: {
      async getMeForTenant(tenantId) {
        if (!isTenantAllowed(tenantId)) return null;
        await ensureTables();
        const identity = await db
          .prepare('SELECT consumerId, agentId FROM v2_staging_sessions WHERE tenantId = ? LIMIT 1')
          .bind(tenantId)
          .first<Pick<SessionRow, 'consumerId' | 'agentId'>>();
        if (identity === null) return null;
        const conversation = await deps.projectConversation({
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
    appleVerifier,
    devVerifier: { provider: 'dev', verify: () => Promise.resolve(null) },
    devProvider: DENY_DEV_PROVIDER,
    me: ports.me,
  };
}
