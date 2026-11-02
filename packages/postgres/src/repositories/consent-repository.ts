import { randomUUID } from 'node:crypto';
import {
  AuthContextSchema,
  CONSENT_OPERATIONS,
  DEFAULT_CONSENT_OPERATIONS,
  type ConsentDecision,
  type ConsentEvaluator,
  type ConsentGrant,
  type ConsentOperation,
  type ConsentRepository,
  type ConsentStatus,
  type GrantConsentCommand,
  type RevokeConsentOptions,
  type SourceProfileId,
  SourceProfileIdSchema,
  toInvalidArgumentError,
} from '@ember/contracts';
import { DomainError, InvalidArgumentError, type AuthContext, type Id } from '@ember/domain';
import type pg from 'pg';
import {
  CONSENT_COLUMNS_SQL,
  SELECT_CONSENT_FOR_UPDATE_SQL,
  SELECT_CONSENT_SQL,
  evaluateConsentRow,
  type ConsentGrantRow,
} from './consent-fence.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

/**
 * Authoritative PostgreSQL consent persistence (P0-C3D).
 *
 * Guarantees this class is responsible for:
 *
 * - **Tenant isolation twice over.** Every statement is scoped by `tenant_id` from the verified
 *   `AuthContext`, and the table itself is keyed by `(tenant_id, source_profile_id)`. Another
 *   tenant's grant is reported exactly like a missing one.
 * - **No credentials.** Only authorization facts are written. There is no column, parameter or
 *   log line for a token, cookie or key.
 * - **Versioned fence.** `version` advances on every effective mutation. Callers that observed
 *   an older version fail rather than silently overwriting newer authorization
 *   (`INVALID_STATE_TRANSITION`), and publication compares the dispatched version with the
 *   current one.
 * - **Database-clock expiry.** `expires_at` is validated and evaluated with
 *   `clock_timestamp()`, so host clock skew cannot extend a grant.
 */

const PRINCIPAL_EXISTS_SQL = `
SELECT 1
  FROM principals
 WHERE tenant_id = $1 AND id = $2
`;

const INSERT_CONSENT_SQL = `
  INSERT INTO consent_grants (
    id, tenant_id, source_profile_id, status, allowed_operations, scopes,
    granted_by_principal_id, granted_at, expires_at, version, created_at, updated_at
  )
  VALUES ($1, $2, $3, 'active', $4::text[], $5::text[], $6, clock_timestamp(),
          $7::timestamptz, 1, clock_timestamp(), clock_timestamp())
  RETURNING ${CONSENT_COLUMNS_SQL}
`;

/**
 * Re-grant / mutation. Revocation is cleared because an effective grant is being restored, and
 * `version` advances so every fence comparing against the previous version becomes stale.
 */
const UPDATE_CONSENT_SQL = `
  UPDATE consent_grants
     SET status = 'active',
         allowed_operations = $3::text[],
         scopes = $4::text[],
         granted_by_principal_id = $5,
         granted_at = clock_timestamp(),
         expires_at = $6::timestamptz,
         revoked_at = NULL,
         revoked_by_principal_id = NULL,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE tenant_id = $1 AND source_profile_id = $2
  RETURNING ${CONSENT_COLUMNS_SQL}
`;

const REVOKE_CONSENT_SQL = `
  UPDATE consent_grants
     SET status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_principal_id = $3,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE tenant_id = $1 AND source_profile_id = $2
  RETURNING ${CONSENT_COLUMNS_SQL}
`;

const SELECT_CONSENT_LIST_SQL = `
  SELECT ${CONSENT_COLUMNS_SQL}
  FROM consent_grants
  WHERE tenant_id = $1
  ORDER BY created_at DESC, id DESC
`;

function toPersistedConsentStatus(value: string): ConsentStatus {
  if (value === 'active' || value === 'revoked' || value === 'expired') {
    return value;
  }

  throw new DomainError('DB_UNAVAILABLE', 'persisted consent status is invalid');
}

function toConsentOperation(value: string): ConsentOperation {
  const match = CONSENT_OPERATIONS.find((operation) => operation === value);

  if (match === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted consent operation is invalid');
  }

  return match;
}

function toConsentGrant(row: ConsentGrantRow): ConsentGrant {
  return {
    consentId: row.id,
    tenantId: row.tenant_id,
    sourceProfileId: row.source_profile_id,
    status: toPersistedConsentStatus(row.effective_status),
    allowedOperations: row.allowed_operations.map(toConsentOperation),
    scopes: [...row.scopes],
    grantedAt: toIsoTimestamp(row.granted_at),
    expiresAt: row.expires_at === null ? null : toIsoTimestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : toIsoTimestamp(row.revoked_at),
    version: row.version,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

function parseAuthContext(ctx: AuthContext): AuthContext {
  const parsed = AuthContextSchema.safeParse(ctx);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

/** Canonical, duplicate-free operation list so an identical re-grant replays instead of bumping. */
function normalizeOperations(
  operations: readonly ConsentOperation[] | undefined,
): readonly ConsentOperation[] {
  const requested = operations ?? DEFAULT_CONSENT_OPERATIONS;

  return CONSENT_OPERATIONS.filter((operation) => requested.includes(operation));
}

function normalizeScopes(scopes: readonly string[] | undefined): readonly string[] {
  return scopes === undefined ? [] : [...new Set(scopes)].sort();
}

function sameTimestamp(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return Date.parse(left) === Date.parse(right);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Parse a caller-supplied source profile id into the closed grant vocabulary. */
function parseSourceProfileId(value: SourceProfileId): SourceProfileId {
  const parsed = SourceProfileIdSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidArgumentError([
      { path: 'source_profile_id', code: 'invalid_source_profile_id' },
    ]);
  }

  return parsed.data;
}

function randomConsentId(): Id {
  return randomUUID();
}

function requireRow(row: ConsentGrantRow | undefined): ConsentGrantRow {
  if (row === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'consent write returned no row');
  }

  return row;
}

export class PostgresConsentRepository implements ConsentRepository, ConsentEvaluator {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Grant or re-grant consent for one source profile.
   *
   * The whole operation runs in one transaction holding the grant row lock, so two concurrent
   * grants serialise and cannot both start from the same `version`. Re-granting an identical,
   * still-effective grant replays (`replayed: true`, version unchanged); anything else — a
   * changed operation set, changed scopes, changed expiry, or restoring a revoked/expired
   * grant — advances `version`.
   */
  async grant(
    ctx: AuthContext,
    cmd: GrantConsentCommand,
  ): Promise<{ readonly consent: ConsentGrant; readonly replayed: boolean }> {
    const scoped = parseAuthContext(ctx);
    const sourceProfileId = parseSourceProfileId(cmd.sourceProfileId);
    const operations = normalizeOperations(cmd.allowedOperations);
    const scopes = normalizeScopes(cmd.scopes);
    const expiresAt = cmd.expiresAt ?? null;

    return withTransaction(this.pool, async (client) => {
      // The principal must exist inside this tenant before it can authorise anything, so a
      // forged or stale credential can never create an orphan grant.
      const principal = await client.query(PRINCIPAL_EXISTS_SQL, [
        scoped.tenantId,
        scoped.principalId,
      ]);

      if ((principal.rowCount ?? 0) === 0) {
        throw new DomainError('UNAUTHENTICATED', 'principal is not provisioned in this tenant');
      }

      if (expiresAt !== null) {
        // Expiry sanity is decided by the database clock inside the same transaction that
        // writes it; the application clock is never trusted for an authorization boundary.
        const now = await client.query<{ now: Date | string }>('SELECT clock_timestamp() AS now');
        const nowMs = new Date(now.rows[0]?.now ?? Number.NaN).getTime();

        if (!(Date.parse(expiresAt) > nowMs)) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'expires_at must be in the future according to the database clock',
          );
        }
      }

      const existing = await client.query<ConsentGrantRow>(SELECT_CONSENT_FOR_UPDATE_SQL, [
        scoped.tenantId,
        sourceProfileId,
      ]);
      const row = existing.rows[0];

      if (row === undefined) {
        const inserted = await client.query<ConsentGrantRow>(INSERT_CONSENT_SQL, [
          randomConsentId(),
          scoped.tenantId,
          sourceProfileId,
          operations,
          scopes,
          scoped.principalId,
          expiresAt,
        ]);

        return { consent: toConsentGrant(requireRow(inserted.rows[0])), replayed: false };
      }

      const isIdentical =
        row.effective_status === 'active' &&
        row.is_effective &&
        sameList(row.allowed_operations, operations) &&
        sameList(row.scopes, scopes) &&
        sameTimestamp(row.expires_at === null ? null : toIsoTimestamp(row.expires_at), expiresAt);

      if (isIdentical) {
        return { consent: toConsentGrant(row), replayed: true };
      }

      const updated = await client.query<ConsentGrantRow>(UPDATE_CONSENT_SQL, [
        scoped.tenantId,
        sourceProfileId,
        operations,
        scopes,
        scoped.principalId,
        expiresAt,
      ]);

      return { consent: toConsentGrant(requireRow(updated.rows[0])), replayed: false };
    });
  }

  /**
   * Revoke one grant.
   *
   * Revocation is idempotent for an already-revoked grant (no version bump, so a retried
   * revocation cannot invalidate fences a second time), but honours `expectedVersion` when the
   * caller supplied it: a stale compare-and-set fails instead of revoking newer authorization.
   */
  async revoke(
    ctx: AuthContext,
    sourceProfileId: SourceProfileId,
    options?: RevokeConsentOptions,
  ): Promise<ConsentGrant> {
    const scoped = parseAuthContext(ctx);
    const profileId = parseSourceProfileId(sourceProfileId);

    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<ConsentGrantRow>(SELECT_CONSENT_FOR_UPDATE_SQL, [
        scoped.tenantId,
        profileId,
      ]);
      const row = existing.rows[0];

      if (row === undefined) {
        // Cross-tenant and missing are deliberately indistinguishable.
        throw new DomainError('NOT_FOUND', 'consent grant not found');
      }

      if (options?.expectedVersion !== undefined && row.version !== options.expectedVersion) {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `consent version ${row.version} does not match expected version ${options.expectedVersion}`,
        );
      }

      if (row.status === 'revoked') {
        return toConsentGrant(row);
      }

      const revoked = await client.query<ConsentGrantRow>(REVOKE_CONSENT_SQL, [
        scoped.tenantId,
        profileId,
        scoped.principalId,
      ]);

      return toConsentGrant(requireRow(revoked.rows[0]));
    });
  }

  /** Read one grant; `null` covers both "missing" and "owned by another tenant". */
  async get(ctx: AuthContext, sourceProfileId: SourceProfileId): Promise<ConsentGrant | null> {
    const scoped = parseAuthContext(ctx);
    const profileId = parseSourceProfileId(sourceProfileId);

    try {
      const result = await this.pool.query<ConsentGrantRow>(SELECT_CONSENT_SQL, [
        scoped.tenantId,
        profileId,
      ]);
      const row = result.rows[0];

      return row === undefined ? null : toConsentGrant(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** Tenant-scoped listing, newest first. */
  async list(ctx: AuthContext): Promise<readonly ConsentGrant[]> {
    const scoped = parseAuthContext(ctx);

    try {
      const result = await this.pool.query<ConsentGrantRow>(SELECT_CONSENT_LIST_SQL, [
        scoped.tenantId,
      ]);

      return result.rows.map(toConsentGrant);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Server-side consent evaluation for the worker path.
   *
   * The worker's tenant comes from the persisted Run, so this takes a `tenantId` rather than an
   * `AuthContext`. Read-only: the publication guard performs its own `FOR UPDATE` read inside
   * the publishing transaction and evaluates it with `evaluateConsentRow`.
   */
  async evaluateConsent(
    tenantId: string,
    sourceProfileId: SourceProfileId,
    operation: ConsentOperation,
    requiredVersion?: number | null,
  ): Promise<ConsentDecision> {
    const profileId = parseSourceProfileId(sourceProfileId);

    try {
      const result = await this.pool.query<ConsentGrantRow>(SELECT_CONSENT_SQL, [
        tenantId,
        profileId,
      ]);

      return evaluateConsentRow(result.rows[0], operation, requiredVersion ?? null);
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
