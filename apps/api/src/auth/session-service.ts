import {
  B1SessionResponseSchema,
  type B1ConsumerProvisioningRepository,
  type B1ConsumerSessionRepository,
  type B1MeResponse,
  type B1SessionRecord,
  type B1SessionResponse,
} from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import type { VerifiedIdentity } from './identity-verifier.js';
import {
  digestSessionToken,
  generateSessionToken,
  SESSION_TOKEN_PATTERN,
} from './session-token.js';

/**
 * Session orchestration around the frozen B1 repository ports (ADR-0004 §5.1/§5.3).
 *
 * This module owns token generation, TTL arithmetic and DTO construction. It never knows
 * how a session is stored, never invents a tenant and never accepts a caller-supplied
 * `tenant_id`, `principal_id` or `policy_version`. Only SHA-256 digests are handed to a port.
 */

export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
export const MAX_SESSION_REQUEST_BYTES = 8 * 1_024;

/**
 * Injected read port for `GET /v1/me`. The projection is a pure read of an already
 * provisioned Consumer/Agent/Conversation, scoped by the server-derived tenant id.
 * The HTTP handler never constructs or creates one.
 */
export interface B1MeProjectionReader {
  getMeForTenant(tenantId: Id): Promise<B1MeResponse | null>;
}

export interface B1SessionPorts {
  readonly provisioning: B1ConsumerProvisioningRepository;
  readonly sessions: B1ConsumerSessionRepository;
  readonly me: B1MeProjectionReader;
}

export interface ResolvedSession {
  readonly session: B1SessionRecord;
  /** The unchanged AuthContext shape (I-9): identity work terminates here. */
  readonly auth: AuthContext;
}

export interface SessionService {
  /** 201: always mints a new session; provisioning is atomic inside the port. */
  createSession(identity: VerifiedIdentity): Promise<B1SessionResponse>;
  /** 200: rotates the presented token; `null` means reuse, revoked or expired (401). */
  refreshSession(rawToken: string): Promise<B1SessionResponse | null>;
  /** 204: idempotent, revokes only the presented session. */
  logout(rawToken: string): Promise<void>;
  /** Active-session resolution + AuthContext derivation for session-authenticated routes. */
  resolveActiveSession(rawToken: string): Promise<ResolvedSession | null>;
}

export interface CreateSessionServiceOptions {
  readonly ports: B1SessionPorts;
  readonly now?: () => Date;
}

interface SessionWindows {
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

export function createSessionService(options: CreateSessionServiceOptions): SessionService {
  const ports = options.ports;
  const now = options.now ?? (() => new Date());

  const windows = (): SessionWindows => {
    const current = now().getTime();
    return {
      expiresAt: new Date(current + SESSION_ABSOLUTE_TTL_MS).toISOString(),
      idleExpiresAt: new Date(current + SESSION_IDLE_TTL_MS).toISOString(),
    };
  };

  const resolveActiveSession = async (rawToken: string): Promise<ResolvedSession | null> => {
    if (!SESSION_TOKEN_PATTERN.test(rawToken)) {
      return null;
    }

    const found = await ports.sessions.findActiveSession(digestSessionToken(rawToken));

    if (found === null) {
      return null;
    }

    const auth: AuthContext = Object.freeze({
      tenantId: found.session.tenantId,
      principalId: found.principalId,
      policyVersion: found.policyVersion,
    });

    return Object.freeze({ session: found.session, auth });
  };

  return Object.freeze({
    async createSession(identity: VerifiedIdentity): Promise<B1SessionResponse> {
      const token = generateSessionToken();
      const ttl = windows();

      const provisioned = await ports.provisioning.provisionIdentityAndCreateSession({
        provider: identity.provider,
        providerSubject: identity.providerSubject,
        tokenDigest: digestSessionToken(token),
        expiresAt: ttl.expiresAt,
        idleExpiresAt: ttl.idleExpiresAt,
      });

      // Strict parse also proves that no tenant_id / principal_id / policy field leaked out.
      return B1SessionResponseSchema.parse({
        session_id: provisioned.session.sessionId,
        consumer_id: provisioned.identity.consumerId,
        access_token: token,
        expires_at: provisioned.session.expiresAt,
      });
    },

    async refreshSession(rawToken: string): Promise<B1SessionResponse | null> {
      if (!SESSION_TOKEN_PATTERN.test(rawToken)) {
        return null;
      }

      const token = generateSessionToken();
      const ttl = windows();

      const result = await ports.sessions.rotateSession({
        currentTokenDigest: digestSessionToken(rawToken),
        newTokenDigest: digestSessionToken(token),
        expiresAt: ttl.expiresAt,
        idleExpiresAt: ttl.idleExpiresAt,
      });

      if (result.kind !== 'rotated') {
        // `reuse_detected` already revoked every session of that consumer inside the port.
        return null;
      }

      return B1SessionResponseSchema.parse({
        session_id: result.session.sessionId,
        consumer_id: result.session.consumerId,
        access_token: token,
        expires_at: result.session.expiresAt,
      });
    },

    async logout(rawToken: string): Promise<void> {
      const resolved = await resolveActiveSession(rawToken);

      if (resolved === null) {
        // Preserve idempotent logout for ordinary expired/revoked tokens, but do not hide
        // rotated-token reuse behind the 204. `findActiveSession` has already revoked the
        // Consumer's active set when the token was rotated; this second call uses the existing
        // rotation result to distinguish replay from every other inactive token without
        // extending the approved repository interface. The candidate digest is never stored
        // because the presented session is no longer active.
        if (SESSION_TOKEN_PATTERN.test(rawToken)) {
          const candidateToken = generateSessionToken();
          const ttl = windows();
          const inactive = await ports.sessions.rotateSession({
            currentTokenDigest: digestSessionToken(rawToken),
            newTokenDigest: digestSessionToken(candidateToken),
            expiresAt: ttl.expiresAt,
            idleExpiresAt: ttl.idleExpiresAt,
          });

          if (inactive.kind === 'reuse_detected') {
            throw new DomainError('UNAUTHENTICATED', 'rotated B1 session token was reused');
          }
        }

        return;
      }

      await ports.sessions.revokeSession({
        sessionId: resolved.session.sessionId,
        tenantId: resolved.session.tenantId,
      });
    },

    resolveActiveSession,
  });
}

function unavailable(): never {
  throw new DomainError('DB_UNAVAILABLE', 'B1 session repository is not configured');
}

/**
 * Fail-closed ports for a process that registered the routes without wiring real
 * repositories. Every operation answers 503 `DB_UNAVAILABLE`; none grants a session.
 */
export function unconfiguredB1SessionPorts(): B1SessionPorts {
  return Object.freeze({
    provisioning: {
      provisionIdentityAndCreateSession: () => unavailable(),
    },
    sessions: {
      findActiveSession: () => unavailable(),
      rotateSession: () => unavailable(),
      revokeSession: () => unavailable(),
    },
    me: {
      getMeForTenant: () => unavailable(),
    },
  });
}
