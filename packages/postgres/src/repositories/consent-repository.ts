import { randomUUID } from 'node:crypto';
import {
  AuthContextSchema,
  DEFAULT_CONSENT_OPERATIONS,
  DEFAULT_CONSENT_SCOPES,
  SOURCE_READ_OPERATION,
  SourceProfileIdSchema,
  deriveConsentStatus,
  toInvalidArgumentError,
  type AuthorizedConsentGeneration,
  type ConsentAuthority,
  type ConsentDecision,
  type ConsentEvaluator,
  type ConsentGeneration,
  type ConsentOperation,
  type ConsentRepository,
  type GrantConsentCommand,
  type GrantConsentParams,
  type PersistedConsentGrant,
  type RevokeConsentOptions,
  type SourceProfileId,
} from '@ember/contracts';
import { DomainError, InvalidArgumentError, type AuthContext, type Id } from '@ember/domain';
import type pg from 'pg';
import {
  CONSENT_COLUMNS_SQL,
  READ_SNAPSHOT_REQUIREMENTS,
  SELECT_CONSENT_FOR_UPDATE_SQL,
  SELECT_CONSENT_SQL,
  assertKnownStatus,
  deriveRowStatus,
  evaluateConsentRow,
  type ConsentGrantRow,
} from './consent-fence.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

/**
 * Authoritative PostgreSQL consent persistence (P0-C3D).
 *
 * The durable store implements BOTH faces of the frozen contract:
 *
 * - {@link ConsentAuthority} (`resolveGeneration`) for the Worker and the dispatch/publication
 *   gates, which only ever need the current generation of one lineage;
 * - {@link ConsentRepository} (tenant-scoped admin port) for the HTTP surface, where the tenant
 *   always comes from the verified `AuthContext`.
 *
 * Guarantees this class is responsible for:
 *
 * - **Tenant isolation twice over.** Every statement is scoped by `tenant_id`, and the table is
 *   keyed by `(tenant_id, source_profile_id)`. Another tenant's grant is reported exactly like a
 *   missing one.
 * - **No credentials.** Only authorization facts are written. There is no column, parameter or log
 *   line for a token, cookie or key.
 * - **Generations, not just versions.** Every explicit re-grant mints a NEW `grantId` and a strictly
 *   greater `version` (P0-C3C C-06). Only an identical reaffirmation of a still-effective grant
 *   replays without a new generation (C-09), and only revocation advances the version in place
 *   (C-02). Publication therefore compares BOTH identity and version.
 * - **Database-clock expiry.** `expires_at` is evaluated with `clock_timestamp()` in SQL, so host
 *   clock skew cannot extend a grant.
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
  VALUES ($1, $2, $3, 'active', $4::text[], $5::text[], $6,
          COALESCE($8::timestamptz, clock_timestamp()), $7::timestamptz, 1,
          clock_timestamp(), clock_timestamp())
  RETURNING ${CONSENT_COLUMNS_SQL}
`;

/**
 * Explicit re-grant: mints a NEW generation.
 *
 * `id` is regenerated because the previous generation is dead (revoked, expired or superseded).
 * Keeping the old id while bumping only `version` would let a caller that compares grant identity
 * (P0-C3C C-06) believe a dead generation came back to life. `version` still increases monotonically
 * across the lineage (C-08), and the row keeps its lineage key `(tenant_id, source_profile_id)`.
 */
const UPDATE_CONSENT_SQL = `
  UPDATE consent_grants
     SET id = $3,
         status = 'active',
         allowed_operations = $4::text[],
         scopes = $5::text[],
         granted_by_principal_id = $6,
         granted_at = COALESCE($8::timestamptz, clock_timestamp()),
         expires_at = $7::timestamptz,
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
         revoked_at = COALESCE($4::timestamptz, clock_timestamp()),
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
  ORDER BY source_profile_id ASC
`;

function toPersistedGrant(row: ConsentGrantRow, now?: Date | null): PersistedConsentGrant {
  return {
    grantId: row.id,
    tenantId: row.tenant_id,
    sourceProfileId: row.source_profile_id,
    status: assertKnownStatus(deriveRowStatus(row, now)),
    allowedOperations: [...row.allowed_operations],
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

/**
 * Canonical, duplicate-free operation list so an identical re-grant replays instead of bumping.
 *
 * A caller MAY name an operation Ember does not implement (the contract requires such a grant to
 * exist and to deny a read), so labels are validated and bounded rather than filtered against a
 * closed set. Filtering would turn "grant for something else" into "grant for everything".
 */
function normalizeOperations(operations: readonly string[] | undefined): readonly string[] {
  const requested = operations ?? DEFAULT_CONSENT_OPERATIONS;

  if (requested.length === 0 || requested.length > 4) {
    throw new InvalidArgumentError([{ path: 'allowed_operations', code: 'invalid_length' }]);
  }

  for (const operation of requested) {
    if (typeof operation !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(operation)) {
      throw new InvalidArgumentError([
        { path: 'allowed_operations', code: 'invalid_operation_label' },
      ]);
    }
  }

  return [...new Set(requested)].sort();
}

/**
 * Canonical, sorted scope list. An explicit empty list stays empty (fail closed); only an absent
 * list falls back to the connector contract's `source.readonly`.
 */
function normalizeScopes(scopes: readonly string[] | undefined): readonly string[] {
  return scopes === undefined ? [...DEFAULT_CONSENT_SCOPES] : [...new Set(scopes)].sort();
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

function requireRow(row: ConsentGrantRow | undefined): ConsentGrantRow {
  if (row === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'consent write returned no row');
  }

  return row;
}

function requireValidClock(now: Date | undefined): Date | undefined {
  if (now === undefined) {
    return undefined;
  }

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InvalidArgumentError([{ path: 'now', code: 'invalid_date' }]);
  }

  return now;
}

export class PostgresConsentRepository
  implements ConsentRepository, ConsentEvaluator, ConsentAuthority
{
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------------------------------
  // Canonical, tenant-explicit surface (Worker gates, conformance suite, CLI).
  //
  // Every method takes `tenantId` explicitly because the caller has already resolved it from
  // authoritative state (a persisted Run, or a test fixture). The HTTP surface uses the
  // `AuthContext` overloads below and never accepts a tenant from a request.
  // ---------------------------------------------------------------------------------------------

  /** Grant or re-grant consent for one source profile. */
  async grantForTenant(
    params: GrantConsentParams,
    now?: Date,
    actor?: { readonly principalId: Id },
  ): Promise<PersistedConsentGrant> {
    const clock = requireValidClock(now);
    const sourceProfileId = parseSourceProfileId(params.sourceProfileId);

    if (typeof params.tenantId !== 'string' || params.tenantId.length === 0) {
      throw new InvalidArgumentError([{ path: 'tenant_id', code: 'too_small' }]);
    }

    const operations = normalizeOperations(params.allowedOperations);
    const scopes = normalizeScopes(params.scopes);
    const expiresAt = params.expiresAt ?? null;

    if (operations.length === 0) {
      throw new InvalidArgumentError([{ path: 'allowed_operations', code: 'too_small' }]);
    }

    if (expiresAt !== null) {
      const requestedMs = Date.parse(String(expiresAt));

      if (!Number.isFinite(requestedMs)) {
        throw new InvalidArgumentError([{ path: 'expires_at', code: 'invalid_date' }]);
      }

      // Already-expired grants are rejected at write time, never persisted as dead authorization.
      if (clock !== undefined) {
        if (requestedMs <= clock.getTime()) {
          throw new DomainError('INVALID_ARGUMENT', 'expires_at must be in the future');
        }
      }
    }

    return withTransaction(this.pool, async (client) => {
      if (actor !== undefined) {
        // The principal must exist inside this tenant before it can authorise anything, so a forged
        // or stale credential can never create an orphan grant.
        const principal = await client.query(PRINCIPAL_EXISTS_SQL, [
          params.tenantId,
          actor.principalId,
        ]);

        if ((principal.rowCount ?? 0) === 0) {
          throw new DomainError('UNAUTHENTICATED', 'principal is not provisioned in this tenant');
        }
      }

      if (expiresAt !== null && clock === undefined) {
        // Expiry sanity is decided by the database clock inside the same transaction that writes
        // it; the application clock is never trusted for an authorization boundary.
        const nowRow = await client.query<{ now: Date | string }>(
          'SELECT clock_timestamp() AS now',
        );
        const nowMs = new Date(nowRow.rows[0]?.now ?? Number.NaN).getTime();

        if (!(Date.parse(String(expiresAt)) > nowMs)) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'expires_at must be in the future according to the database clock',
          );
        }
      }

      const existing = await client.query<ConsentGrantRow>(SELECT_CONSENT_FOR_UPDATE_SQL, [
        params.tenantId,
        sourceProfileId,
      ]);
      const row = existing.rows[0];

      if (row === undefined) {
        const inserted = await client.query<ConsentGrantRow>(INSERT_CONSENT_SQL, [
          randomUUID(),
          params.tenantId,
          sourceProfileId,
          operations,
          scopes,
          actor?.principalId ?? null,
          expiresAt,
          clock ?? null,
        ]);

        return toPersistedGrant(requireRow(inserted.rows[0]), clock);
      }

      const isIdentical =
        deriveRowStatus(row, clock) === 'active' &&
        sameList(row.allowed_operations, operations) &&
        sameList(row.scopes, scopes) &&
        sameTimestamp(row.expires_at === null ? null : toIsoTimestamp(row.expires_at), expiresAt);

      if (isIdentical) {
        return toPersistedGrant(row, clock);
      }

      const updated = await client.query<ConsentGrantRow>(UPDATE_CONSENT_SQL, [
        params.tenantId,
        sourceProfileId,
        randomUUID(),
        operations,
        scopes,
        actor?.principalId ?? null,
        expiresAt,
        clock ?? null,
      ]);

      return toPersistedGrant(requireRow(updated.rows[0]), clock);
    });
  }

  /** Read one grant. `null` covers both "missing" and "owned by another tenant". */
  async getForTenant(
    tenantId: Id,
    sourceProfileId: SourceProfileId,
    now?: Date,
  ): Promise<PersistedConsentGrant | null> {
    // Malformed identifiers OR a malformed clock fail closed with `null` on read: a read must never
    // throw a shape error that distinguishes "invalid" from "absent".
    let clock: Date | undefined;

    try {
      clock = requireValidClock(now);
    } catch {
      return null;
    }

    const parsedProfile = SourceProfileIdSchema.safeParse(sourceProfileId);

    if (!parsedProfile.success || typeof tenantId !== 'string' || tenantId.length === 0) {
      return null;
    }

    try {
      const result = await this.pool.query<ConsentGrantRow>(SELECT_CONSENT_SQL, [
        tenantId,
        parsedProfile.data,
      ]);
      const row = result.rows[0];

      return row === undefined ? null : toPersistedGrant(row, clock);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** Revoke one grant. Revoking an already-revoked grant replays and never bumps twice. */
  async revokeForTenant(
    tenantId: Id,
    sourceProfileId: SourceProfileId,
    now?: Date,
    actor?: { readonly principalId: Id },
    options?: RevokeConsentOptions,
  ): Promise<PersistedConsentGrant> {
    const clock = requireValidClock(now);
    const profileId = parseSourceProfileId(sourceProfileId);

    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<ConsentGrantRow>(SELECT_CONSENT_FOR_UPDATE_SQL, [
        tenantId,
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
        return toPersistedGrant(row, clock);
      }

      const revoked = await client.query<ConsentGrantRow>(REVOKE_CONSENT_SQL, [
        tenantId,
        profileId,
        actor?.principalId ?? null,
        now ?? null,
      ]);

      return toPersistedGrant(requireRow(revoked.rows[0]), clock);
    });
  }

  /** Tenant-scoped listing, deterministically ordered by source profile (P0-C3C C-12). */
  async listForTenant(tenantId: Id, now?: Date): Promise<readonly PersistedConsentGrant[]> {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      return [];
    }

    let clock: Date | undefined;

    try {
      clock = requireValidClock(now);
    } catch {
      return [];
    }

    try {
      const result = await this.pool.query<ConsentGrantRow>(SELECT_CONSENT_LIST_SQL, [tenantId]);

      return result.rows.map((row) => toPersistedGrant(row, clock));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Authoritative generation view (P0-C3C `ConsentAuthority`).
   *
   * This is the single read the Worker, the dispatch gate and the publication gate resolve
   * against. It returns the EFFECTIVE status, so an elapsed `expires_at` reports `expired`
   * without the row being rewritten.
   */
  async resolveGeneration(
    tenantId: Id,
    sourceProfileId: SourceProfileId,
    now?: Date,
  ): Promise<AuthorizedConsentGeneration | null> {
    const grant = await this.getForTenant(tenantId, sourceProfileId, now);

    if (grant === null) {
      return null;
    }

    return {
      tenantId: grant.tenantId,
      sourceProfileId: grant.sourceProfileId,
      grantId: grant.grantId,
      version: grant.version,
      status: grant.status,
      expiresAt: grant.expiresAt,
    };
  }

  /**
   * Server-side consent evaluation for the worker path.
   *
   * Read-only. The publication guard performs its own `FOR UPDATE` read inside the publishing
   * transaction and evaluates it with `evaluateConsentRow`, so this method is for pre-read checks
   * and diagnostics only.
   */
  async evaluateConsent(
    tenantId: Id,
    sourceProfileId: SourceProfileId,
    operation: ConsentOperation,
    fence?: ConsentGeneration | null,
  ): Promise<ConsentDecision> {
    const profileId = parseSourceProfileId(sourceProfileId);

    try {
      const result = await this.pool.query<ConsentGrantRow>(SELECT_CONSENT_SQL, [
        tenantId,
        profileId,
      ]);

      return evaluateConsentRow(result.rows[0], {
        operation,
        requiredScopes:
          operation === SOURCE_READ_OPERATION ? READ_SNAPSHOT_REQUIREMENTS.requiredScopes : [],
        fence: fence ?? null,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** True when the grant currently authorises a snapshot read (operation AND scope). */
  async isReadAuthorized(
    tenantId: Id,
    sourceProfileId: SourceProfileId,
    now?: Date,
  ): Promise<boolean> {
    const grant = await this.getForTenant(tenantId, sourceProfileId, now);

    if (grant === null) {
      return false;
    }

    return deriveConsentStatus(grant, now ?? new Date()) === 'active';
  }

  // ---------------------------------------------------------------------------------------------
  // Tenant-scoped admin surface (`ConsentRepository`): the tenant comes from the verified ctx.
  // ---------------------------------------------------------------------------------------------

  async grant(
    ctx: AuthContext,
    cmd: GrantConsentCommand,
  ): Promise<{ readonly consent: PersistedConsentGrant; readonly replayed: boolean }> {
    const scoped = parseAuthContext(ctx);
    const before = await this.getForTenant(scoped.tenantId, cmd.sourceProfileId);

    const consent = await this.grantForTenant(
      {
        tenantId: scoped.tenantId,
        sourceProfileId: cmd.sourceProfileId,
        ...(cmd.allowedOperations === undefined
          ? {}
          : { allowedOperations: cmd.allowedOperations }),
        ...(cmd.scopes === undefined ? {} : { scopes: cmd.scopes }),
        expiresAt: cmd.expiresAt ?? null,
      },
      undefined,
      { principalId: scoped.principalId },
    );

    // A replay is exactly "the same generation came back", never "a version stayed put".
    const replayed =
      before !== null && before.grantId === consent.grantId && before.version === consent.version;

    return { consent, replayed };
  }

  async revoke(
    ctx: AuthContext,
    sourceProfileId: SourceProfileId,
    options?: RevokeConsentOptions,
  ): Promise<PersistedConsentGrant> {
    const scoped = parseAuthContext(ctx);

    return this.revokeForTenant(
      scoped.tenantId,
      sourceProfileId,
      undefined,
      { principalId: scoped.principalId },
      options,
    );
  }

  async get(
    ctx: AuthContext,
    sourceProfileId: SourceProfileId,
  ): Promise<PersistedConsentGrant | null> {
    const scoped = parseAuthContext(ctx);

    return this.getForTenant(scoped.tenantId, sourceProfileId);
  }

  async list(ctx: AuthContext): Promise<readonly PersistedConsentGrant[]> {
    const scoped = parseAuthContext(ctx);

    return this.listForTenant(scoped.tenantId);
  }
}
