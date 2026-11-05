import { DomainError } from '@ember/domain';
import type pg from 'pg';
import type {
  B1AuthenticatedSession,
  B1ConsumerSessionRepository,
  B1SessionRotationResult,
} from './b1-interfaces.js';
import {
  B1_SESSION_COLUMNS_SQL,
  IDLE_SLIDE_CANDIDATE_SQL,
  SELECT_MAIN_CONVERSATION_SQL,
  authenticatedSession,
  insertB1Session,
  lockConsumer,
  newId,
  readDigest,
  readId,
  readTimestamp,
  requireMainConversation,
  toSessionRecord,
  withB1SessionTransaction,
  type B1SessionRow,
  type MainConversationRow,
} from './b1-session-support.js';

/**
 * B1-2A: durable Consumer Session runtime (contract §5.3, ADR-0004 I-4/I-5/I-8/I-9).
 *
 * Every method runs in one `READ COMMITTED` transaction on the database clock. Only SHA-256
 * digests cross this boundary; no token is ever stored, logged, echoed into a diagnostic or
 * used to build a SQL string. Tenant identity is always derived from the persisted session row
 * (or, for logout, from the trusted server-side `tenantId` + `sessionId` pair).
 *
 * **Replay defence.** All mutations for one consumer take the same transaction-scoped advisory
 * lock. A replay of an already-`rotated` digest revokes *every* active session of that consumer
 * and returns `reuse_detected`. Because rotation and replay serialize on that lock, a rotation
 * that commits first has its fresh session revoked by the replay that follows, and a rotation
 * that commits second finds its token already revoked and returns `inactive`. No race can leave
 * an unauthorized active session behind. A concurrently revoked session is never reopened.
 */
const QUALIFIED_SESSION_COLUMNS_SQL = `
  s.id, s.tenant_id, s.consumer_id, s.expires_at, s.idle_expires_at,
  s.revoked_at, s.revocation_reason`;

/** Digest lookup is global (a token itself identifies its tenant); ownership is read, not trusted. */
const SELECT_SESSION_OWNER_SQL = `
SELECT tenant_id, consumer_id
  FROM consumer_sessions
 WHERE token_digest = $1
`;

const SELECT_SESSION_FOR_UPDATE_SQL = `
SELECT ${B1_SESSION_COLUMNS_SQL},
       (revoked_at IS NULL
        AND expires_at > clock_timestamp()
        AND idle_expires_at > clock_timestamp()) AS is_live
  FROM consumer_sessions
 WHERE token_digest = $1
   FOR UPDATE
`;

const FIND_ACTIVE_SQL = `
SELECT ${QUALIFIED_SESSION_COLUMNS_SQL},
       c.principal_id,
       (s.revoked_at IS NULL
        AND s.expires_at > clock_timestamp()
        AND s.idle_expires_at > clock_timestamp()) AS is_live
  FROM consumer_sessions s
  JOIN consumers c ON c.tenant_id = s.tenant_id AND c.id = s.consumer_id
  JOIN principals p
    ON p.tenant_id = c.tenant_id AND p.id = c.principal_id AND p.role = 'owner'
 WHERE s.token_digest = $1
   FOR UPDATE OF s
`;

/**
 * Sliding idle expiry, at most once per hour.
 *
 * The candidate is `GREATEST(idle_expires_at, LEAST(now + 14d, expires_at))`: strictly
 * monotonic, capped by the absolute expiry, and computed entirely on the database clock. The
 * `> idle_expires_at + 1 hour` predicate is the rate limiter - after one slide the slack is
 * zero, so a second call within the hour cannot write again.
 */
const SLIDE_IDLE_SQL = `
UPDATE consumer_sessions
   SET idle_expires_at = ${IDLE_SLIDE_CANDIDATE_SQL}
 WHERE tenant_id = $1 AND id = $2
   AND ${IDLE_SLIDE_CANDIDATE_SQL} > idle_expires_at + interval '1 hour'
 RETURNING ${B1_SESSION_COLUMNS_SQL}
`;

/** The old token dies in the same transaction that mints the new one. */
const ROTATE_OUT_SQL = `
UPDATE consumer_sessions
   SET revoked_at = clock_timestamp(),
       revocation_reason = 'rotated'
 WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
   AND expires_at > clock_timestamp()
   AND idle_expires_at > clock_timestamp()
RETURNING id
`;

/** Reason is a fixed internal literal, never caller input. */
const REVOKE_ALL_ACTIVE_SQL = `
UPDATE consumer_sessions
   SET revoked_at = clock_timestamp(),
       revocation_reason = $3
 WHERE tenant_id = $1 AND consumer_id = $2 AND revoked_at IS NULL
`;

const SELECT_CONSUMER_BY_SESSION_SQL = `
SELECT consumer_id
  FROM consumer_sessions
 WHERE tenant_id = $1 AND id = $2
`;

/** Logout: idempotent, tenant-qualified, and scoped to exactly the presented session. */
const REVOKE_SESSION_SQL = `
UPDATE consumer_sessions
   SET revoked_at = clock_timestamp(),
       revocation_reason = 'logout'
 WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
`;

interface SessionOwnerRow {
  tenant_id: string;
  consumer_id: string;
}

interface LockedSessionRow extends B1SessionRow {
  is_live: boolean;
}

interface ActiveSessionRow extends B1SessionRow {
  is_live: boolean;
  principal_id: string;
}

interface IdRow {
  id: string;
}

interface ConsumerIdRow {
  consumer_id: string;
}

export class PostgresB1ConsumerSessionRepository implements B1ConsumerSessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Resolve `{tenantId, principalId, policyVersion}` from a token digest alone (I-9), with
   * DB-clock absolute/idle expiry and revocation checks, plus the hourly idle slide. Reading a
   * `rotated` token is itself replay: revoke the Consumer's whole active set before returning
   * null. The HTTP/session layer maps that to 401 while preserving this approved port shape.
   */
  async findActiveSession(tokenDigest: Uint8Array): Promise<B1AuthenticatedSession | null> {
    const digest = readDigest(tokenDigest, 'tokenDigest');

    const outcome = await withB1SessionTransaction(this.pool, async (client) => {
      // Follow the same lock order as rotation/logout. The digest lookup is only a hint; the
      // row is re-read under the Consumer lock before any authorization or replay decision.
      const ownerResult = await client.query<SessionOwnerRow>(SELECT_SESSION_OWNER_SQL, [digest]);
      const owner = ownerResult.rows[0];
      if (owner === undefined) {
        return { kind: 'inactive' as const };
      }

      await lockConsumer(client, owner.consumer_id);

      const found = await client.query<ActiveSessionRow>(FIND_ACTIVE_SQL, [digest]);
      const row = found.rows[0];
      if (
        row === undefined ||
        row.tenant_id !== owner.tenant_id ||
        row.consumer_id !== owner.consumer_id
      ) {
        return { kind: 'inactive' as const };
      }

      if (row.revoked_at !== null) {
        if (row.revocation_reason === 'rotated') {
          await client.query(REVOKE_ALL_ACTIVE_SQL, [
            row.tenant_id,
            row.consumer_id,
            'reuse_detected',
          ]);
          return { kind: 'reuse_detected' as const };
        }
        return { kind: 'inactive' as const };
      }

      if (!row.is_live) {
        return { kind: 'inactive' as const };
      }

      // I-4: a live token implies the default Agent and main Conversation. `policyVersion`
      // comes from that Agent row, exactly like dev auth, and never from the caller.
      const main = await client.query<MainConversationRow>(SELECT_MAIN_CONVERSATION_SQL, [
        row.tenant_id,
      ]);
      const conversation = requireMainConversation(main.rows[0]);

      const slid = await client.query<B1SessionRow>(SLIDE_IDLE_SQL, [row.tenant_id, row.id]);
      const effective: B1SessionRow = slid.rows[0] ?? row;

      return {
        kind: 'active' as const,
        session: authenticatedSession(effective, row.principal_id, conversation.policy_version),
      };
    });

    return outcome.kind === 'active' ? outcome.session : null;
  }

  /**
   * Atomically rotate one session. `reuse_detected` revokes the whole consumer's active set;
   * `inactive` covers every other missing, expired or revoked digest, so the two are
   * indistinguishable to a caller that is not entitled to a distinction.
   */
  async rotateSession(command: {
    readonly currentTokenDigest: Uint8Array;
    readonly newTokenDigest: Uint8Array;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  }): Promise<B1SessionRotationResult> {
    const currentDigest = readDigest(command.currentTokenDigest, 'currentTokenDigest');
    const newDigest = readDigest(command.newTokenDigest, 'newTokenDigest');
    if (currentDigest.equals(newDigest)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'b1 session newTokenDigest must differ from currentTokenDigest',
      );
    }
    const expiresAt = readTimestamp(command.expiresAt, 'expiresAt');
    const idleExpiresAt = readTimestamp(command.idleExpiresAt, 'idleExpiresAt');

    return withB1SessionTransaction(this.pool, async (client) => {
      // The hint read only discovers which consumer's lock to take; every decision below is
      // made against the row re-read under that lock and `FOR UPDATE`.
      const ownerResult = await client.query<SessionOwnerRow>(SELECT_SESSION_OWNER_SQL, [
        currentDigest,
      ]);
      const owner = ownerResult.rows[0];
      if (owner === undefined) {
        return { kind: 'inactive' };
      }

      await lockConsumer(client, owner.consumer_id);

      const locked = await client.query<LockedSessionRow>(SELECT_SESSION_FOR_UPDATE_SQL, [
        currentDigest,
      ]);
      const session = locked.rows[0];
      if (session === undefined) {
        return { kind: 'inactive' };
      }

      // Tenant isolation: the owner hint must agree with the row that was actually locked.
      if (owner.tenant_id !== session.tenant_id || owner.consumer_id !== session.consumer_id) {
        return { kind: 'inactive' };
      }

      if (session.revoked_at !== null) {
        if (session.revocation_reason === 'rotated') {
          await client.query(REVOKE_ALL_ACTIVE_SQL, [
            session.tenant_id,
            session.consumer_id,
            'reuse_detected',
          ]);
          return { kind: 'reuse_detected' };
        }
        return { kind: 'inactive' };
      }

      if (!session.is_live) {
        return { kind: 'inactive' };
      }

      const rotatedOut = await client.query<IdRow>(ROTATE_OUT_SQL, [session.tenant_id, session.id]);
      if (rotatedOut.rows[0] === undefined) {
        return { kind: 'inactive' };
      }

      const inserted = await insertB1Session(client, {
        sessionId: newId(),
        tenantId: session.tenant_id,
        consumerId: session.consumer_id,
        digest: newDigest,
        expiresAt,
        idleExpiresAt,
        rotatedFromSessionId: session.id,
      });

      return { kind: 'rotated', session: toSessionRecord(inserted) };
    });
  }

  /** Idempotent logout. A foreign tenant's session id matches no row and is a silent no-op. */
  async revokeSession(command: {
    readonly sessionId: string;
    readonly tenantId: string;
  }): Promise<void> {
    const sessionId = readId(command.sessionId, 'sessionId');
    const tenantId = readId(command.tenantId, 'tenantId');

    await withB1SessionTransaction(this.pool, async (client) => {
      const owner = await client.query<ConsumerIdRow>(SELECT_CONSUMER_BY_SESSION_SQL, [
        tenantId,
        sessionId,
      ]);
      const consumerId = owner.rows[0]?.consumer_id;
      if (consumerId !== undefined) {
        await lockConsumer(client, consumerId);
      }
      await client.query(REVOKE_SESSION_SQL, [tenantId, sessionId]);
    });
  }
}
