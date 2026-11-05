import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { DomainError, isDomainError, type Id } from '@ember/domain';
import type pg from 'pg';
import type { B1AuthenticatedSession, B1SessionRecord } from './b1-interfaces.js';
import { toIsoTimestamp } from './support.js';

/**
 * Private infrastructure shared by the B1-2A session repositories.
 *
 * This module is deliberately not exported from `@ember/postgres`'s public barrel: the CTO
 * wires the package exports after the parallel B1-2 PRs land. It owns four things that must
 * never drift between provisioning and the session runtime:
 *
 * 1. **Validation at the persistence boundary.** Only a 32-byte SHA-256 digest may cross it.
 *    A raw bearer token is a string, so it is rejected before it can reach a SQL parameter.
 * 2. **Error hygiene (ADR-0004 §10.6, G-2/G-6).** Driver `message` and `detail` are *never*
 *    copied into a diagnostic: PostgreSQL's `detail` for a unique violation echoes the
 *    offending key, which here is a token-derived bytea. Diagnostics carry only SQLSTATE and
 *    the constraint name. No log statement exists anywhere in these repositories.
 * 3. **One transaction policy.** `READ COMMITTED` plus transaction-scoped advisory locks,
 *    `FOR UPDATE` row locks and bounded retry on deadlock. `READ COMMITTED` is deliberate: a
 *    transaction that waits on an advisory lock needs a *fresh statement snapshot* after the
 *    winner commits, otherwise it would re-read a stale "no identity yet" and collide with the
 *    unique constraint. Application-side preflight checks are never the concurrency guarantee.
 * 4. **One TTL policy.** Absolute 30 days, idle 14 days, idle sliding at most once per hour,
 *    all evaluated with `clock_timestamp()` (the database clock, never the host clock).
 */

/** Contract §5.3 / I-5. Exported for tests; the SQL intervals below are the authoritative copy. */
export const B1_SESSION_ABSOLUTE_TTL_DAYS = 30;
export const B1_SESSION_IDLE_TTL_DAYS = 14;
export const B1_SESSION_IDLE_SLIDE_HOURS = 1;

/** Default Ember Agent. `policy_version` matches the existing dev-auth default (I-9). */
export const B1_DEFAULT_AGENT_NAME = 'Ember';
export const B1_DEFAULT_AGENT_POLICY_VERSION = 1;
export const B1_MAIN_CONVERSATION_KIND = 'main';

const SHA256_DIGEST_BYTES = 32;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type B1Provider = 'apple' | 'dev';

/** Fixed, input-free diagnostic. Never derived from a caller value. */
function invalidArgument(field: string): DomainError {
  return new DomainError('INVALID_ARGUMENT', `b1 session ${field} is invalid`);
}

export function readProvider(value: unknown): B1Provider {
  if (value !== 'apple' && value !== 'dev') {
    throw invalidArgument('provider');
  }
  return value;
}

/** `provider_subject` is the Apple `sub`; display name and email are never accepted (I-3). */
export function readProviderSubject(value: unknown): string {
  const hasControlCharacter =
    typeof value === 'string' &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f;
    });

  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || hasControlCharacter) {
    throw invalidArgument('providerSubject');
  }
  return value;
}

export function readId(value: unknown, field: string): Id {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw invalidArgument(field);
  }
  return value;
}

/**
 * Copy the digest into a `Buffer` for `bytea`. `Buffer.from(Uint8Array)` copies, so a caller
 * mutating its array after the call cannot alter what was persisted.
 */
export function readDigest(value: unknown, field: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== SHA256_DIGEST_BYTES) {
    throw invalidArgument(field);
  }
  return Buffer.from(value);
}

export function readTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw invalidArgument(field);
  }
  return new Date(value).toISOString();
}

/**
 * Translate a driver failure without ever copying driver text. `asDomainError` from the shared
 * support module is intentionally NOT used here: it folds `error.message` into the diagnostic,
 * and a `bytea` unique-violation detail can carry token-derived bytes.
 */
export function toB1SessionError(error: unknown): DomainError {
  if (isDomainError(error)) {
    return error;
  }

  const details = error as {
    readonly code?: unknown;
    readonly constraint?: unknown;
  };
  const code = typeof details.code === 'string' ? details.code : 'unknown';
  const constraint = typeof details.constraint === 'string' ? details.constraint : 'unknown';

  return new DomainError(
    'DB_UNAVAILABLE',
    `b1 session persistence failed (code=${code}, constraint=${constraint})`,
  );
}

const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
const MAX_TRANSACTION_ATTEMPTS = 4;

function sqlStateOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'unknown';
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * Run one B1 session operation in a single transaction.
 *
 * `READ COMMITTED` is intentional. The advisory locks below are transaction-scoped, so a
 * waiter blocks *inside* its transaction; with a fixed `SERIALIZABLE` snapshot it would wake
 * up still seeing "no identity row" and duplicate the insert. A per-statement snapshot means
 * the post-lock read observes the winner's committed rows, and `FOR UPDATE` re-checks the
 * latest row version. Explicit locks plus the frozen unique constraints are the concurrency
 * guarantee; 40P01 (deadlock, e.g. when a lock order is inverted by a future caller) and
 * 40001 are retried as whole operations, never as half-written statements.
 */
export async function withB1SessionTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect().catch((error: unknown) => {
    throw toB1SessionError(error);
  });

  try {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      let outcome: T;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        outcome = await operation(client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);

        if (isDomainError(error)) {
          throw error;
        }
        if (attempt < MAX_TRANSACTION_ATTEMPTS && RETRYABLE_SQL_STATES.has(sqlStateOf(error))) {
          continue;
        }
        throw toB1SessionError(error);
      }
      return outcome;
    }
  } finally {
    client.release();
  }

  // Unreachable: every iteration either returns, throws, or continues.
  throw new DomainError('DB_UNAVAILABLE', 'b1 session transaction exhausted its retry budget');
}

/**
 * Transaction-scoped advisory locks. Both keys are namespaced and derived from server-owned
 * identifiers, so they cannot collide with the migrator's lock or with another test schema.
 *
 * - The **identity** lock serializes every sign-in for one `(provider, provider_subject)`,
 *   including the very first one where there is no row to `FOR UPDATE` yet.
 * - The **consumer** lock serializes rotation, replay-driven mass revocation and logout for
 *   one consumer. This is what makes "replay revokes *all* active sessions" a property of the
 *   committed state: a rotation that wins the lock first has its new session revoked by the
 *   replay that follows, and a rotation that loses the lock sees its token already revoked.
 */
const LOCK_IDENTITY_SQL = `SELECT pg_advisory_xact_lock(
  hashtextextended('ember:b1-2a:identity:' || $1::text || ':' || $2::text, 0)
)`;
const LOCK_CONSUMER_SQL = `SELECT pg_advisory_xact_lock(
  hashtextextended('ember:b1-2a:consumer:' || $1::text, 0)
)`;

export async function lockIdentity(
  client: pg.PoolClient,
  provider: B1Provider,
  providerSubject: string,
): Promise<void> {
  await client.query(LOCK_IDENTITY_SQL, [provider, providerSubject]);
}

export async function lockConsumer(client: pg.PoolClient, consumerId: Id): Promise<void> {
  await client.query(LOCK_CONSUMER_SQL, [consumerId]);
}

/**
 * `$5` = requested absolute expiry, `$6` = requested idle expiry.
 *
 * The caller (the API layer) may ask for a shorter deadline, e.g. a session-family cap, but
 * never a longer one than the contract allows. `clock_timestamp()` is the database clock, so a
 * skewed or malicious host clock cannot extend a session. `idle_expires_at` is additionally
 * capped by the clamped `expires_at`, so idle sliding can never outlive the absolute TTL.
 */
export const INSERT_EXPIRY_VALUES_SQL = `
  LEAST($5::timestamptz, clock_timestamp() + interval '30 days'),
  LEAST(
    $6::timestamptz,
    LEAST($5::timestamptz, clock_timestamp() + interval '30 days'),
    clock_timestamp() + interval '14 days'
  )`;

/** Candidate for the hourly idle slide; `GREATEST` makes the slide strictly monotonic. */
export const IDLE_SLIDE_CANDIDATE_SQL =
  "GREATEST(idle_expires_at, LEAST(clock_timestamp() + interval '14 days', expires_at))";

export interface B1SessionRow {
  id: string;
  tenant_id: string;
  consumer_id: string;
  expires_at: Date | string;
  idle_expires_at: Date | string;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
}

export const B1_SESSION_COLUMNS_SQL = `
  id, tenant_id, consumer_id, expires_at, idle_expires_at, revoked_at, revocation_reason`;

export function toSessionRecord(row: B1SessionRow): B1SessionRecord {
  return {
    sessionId: row.id,
    consumerId: row.consumer_id,
    tenantId: row.tenant_id,
    expiresAt: toIsoTimestamp(row.expires_at),
    idleExpiresAt: toIsoTimestamp(row.idle_expires_at),
    revokedAt: row.revoked_at === null ? null : toIsoTimestamp(row.revoked_at),
  };
}

export function newId(): Id {
  return randomUUID();
}

/** Insert one session row. Shared so provisioning and rotation cannot diverge on TTL clamping. */
export async function insertB1Session(
  client: pg.PoolClient,
  input: {
    readonly sessionId: Id;
    readonly tenantId: Id;
    readonly consumerId: Id;
    readonly digest: Buffer;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
    readonly rotatedFromSessionId: Id | null;
  },
): Promise<B1SessionRow> {
  const result = await client.query<B1SessionRow>(
    `INSERT INTO consumer_sessions
       (id, tenant_id, consumer_id, token_digest, expires_at, idle_expires_at,
        rotated_from_session_id)
     VALUES ($1, $2, $3, $4, ${INSERT_EXPIRY_VALUES_SQL}, $7)
     RETURNING ${B1_SESSION_COLUMNS_SQL}`,
    [
      input.sessionId,
      input.tenantId,
      input.consumerId,
      input.digest,
      input.expiresAt,
      input.idleExpiresAt,
      input.rotatedFromSessionId,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'b1 session insert returned no row');
  }
  return row;
}

/** Read the default Agent's policy version through the main Conversation (I-4 / I-9). */
export const SELECT_MAIN_CONVERSATION_SQL = `
SELECT conv.id AS conversation_id,
       conv.agent_id,
       a.policy_version
  FROM conversations conv
  JOIN agents a ON a.tenant_id = conv.tenant_id AND a.id = conv.agent_id
 WHERE conv.tenant_id = $1 AND conv.kind = 'main'
 ORDER BY conv.created_at, conv.id
 LIMIT 1
`;

export interface MainConversationRow {
  conversation_id: string;
  agent_id: string;
  policy_version: number;
}

export function requireMainConversation(row: MainConversationRow | undefined): MainConversationRow {
  if (row === undefined) {
    // I-4: a provisioned consumer always has a default Agent and a main Conversation. A
    // missing row is a store integrity failure, not an authentication failure.
    throw new DomainError(
      'DB_UNAVAILABLE',
      'b1 provisioned consumer is missing its main conversation',
    );
  }
  return row;
}

/** Tenant isolation: every projection is derived from the stored session row, never a caller. */
export function authenticatedSession(
  row: B1SessionRow,
  principalId: Id,
  policyVersion: number,
): B1AuthenticatedSession {
  return { session: toSessionRecord(row), principalId, policyVersion };
}
