/**
 * In-memory Fake Consent Registry for @ember/connectors.
 *
 * CRITICAL ARCHITECTURAL BOUNDARY:
 * - This registry is an ephemeral, process-local test double (see `durability`).
 * - It is strictly for unit/integration testing and deterministic fake execution.
 * - Under NO circumstances does it provide cross-process transactional atomicity, durability, or
 *   crash safety, and it MUST NOT be used as the production consent store.
 * - Durable, cross-process consent persistence is Agent A's PostgreSQL repository, which must
 *   satisfy the same behavioral contract (`docs/P0C3-C-CONSENT-CONTRACT.md`).
 *
 * Frozen Consent semantics implemented here (P0-C3C):
 * - A lineage is (`tenantId`, `sourceProfileId`); every authorization unit is a generation
 *   (`grantId`, `version`) that is immutable once issued.
 * - An explicit re-grant mints a NEW `grantId` and a strictly greater `version`; the superseded
 *   generation can never authorize again.
 * - Re-granting identical terms while the current generation is still active is an idempotent
 *   re-affirmation: the SAME generation is returned (no version bump, no new grantId).
 * - Revocation is terminal and idempotent: it bumps the version exactly once and never resurrects.
 * - Expiry is derived from `expiresAt` at evaluation time and never rewrites the generation.
 * - Reads fail closed: malformed identifiers or clocks yield `null` / `[]` (never an exception and
 *   never a grant), while mutating inputs are rejected with INVALID_ARGUMENT.
 */

import { randomUUID } from 'node:crypto';
import { deepFreeze } from './canonical.js';
import {
  deriveConsentStatus,
  isValidConsentGrantRecord,
  toAuthorizedConsentGeneration,
} from './consent.js';
import { createInvalidArgumentError, createNotFoundError } from './errors.js';
import {
  SOURCE_PROFILE_ID_REGEX,
  type AuthorizedConsentGeneration,
  type ConsentAuthority,
  type ConsentGrant,
  type ConsentRegistry,
  type GrantConsentParams,
  type SourceProfileId,
} from './types.js';

/** Maximum entries accepted in `allowedOperations` / `scopes`. */
const MAX_TERM_ENTRIES = 32;
/** Maximum characters per operation/scope term. */
const MAX_TERM_CHARS = 64;
/** Maximum characters per opaque tenant identifier. */
const MAX_TENANT_ID_CHARS = 128;

const DEFAULT_ALLOWED_OPERATIONS: readonly string[] = Object.freeze(['read_snapshot']);
const DEFAULT_SCOPES: readonly string[] = Object.freeze(['source.readonly']);

function normalizeTenantId(tenantId: unknown): string {
  if (
    typeof tenantId !== 'string' ||
    tenantId.trim() === '' ||
    tenantId.length > MAX_TENANT_ID_CHARS
  ) {
    throw createInvalidArgumentError(
      'tenantId must be a non-empty opaque string of at most 128 characters',
    );
  }
  return tenantId;
}

function normalizeSourceProfileId(sourceProfileId: unknown): SourceProfileId {
  if (typeof sourceProfileId !== 'string' || !SOURCE_PROFILE_ID_REGEX.test(sourceProfileId)) {
    throw createInvalidArgumentError(
      'sourceProfileId must be a valid opaque identifier matching ^[a-z0-9][a-z0-9._-]{2,63}$',
    );
  }
  return sourceProfileId;
}

function normalizeClock(now: unknown, field = 'now'): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw createInvalidArgumentError(`${field} must be a valid Date`);
  }
  return now;
}

function normalizeTerms(
  value: unknown,
  fallback: readonly string[],
  field: string,
): readonly string[] {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TERM_ENTRIES) {
    throw createInvalidArgumentError(
      `${field} must be an array of 1-${MAX_TERM_ENTRIES} non-empty strings`,
    );
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw createInvalidArgumentError(`${field} must be an array of non-empty strings`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TERM_CHARS) {
      throw createInvalidArgumentError(`${field} entries must be 1-${MAX_TERM_CHARS} characters`);
    }
    if (!normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }
  return Object.freeze(normalized);
}

function normalizeExpiresAt(value: unknown, now: Date): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw createInvalidArgumentError('expiresAt must be a valid RFC 3339 date string or null');
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw createInvalidArgumentError('expiresAt must be a valid RFC 3339 date string or null');
  }
  if (parsed <= now.getTime()) {
    throw createInvalidArgumentError('expiresAt must be in the future at grant time');
  }
  return new Date(parsed).toISOString();
}

function sameAuthorizationTerms(
  grant: ConsentGrant,
  allowedOperations: readonly string[],
  scopes: readonly string[],
  expiresAt: string | null,
): boolean {
  return (
    grant.expiresAt === expiresAt &&
    grant.allowedOperations.length === allowedOperations.length &&
    allowedOperations.every((operation) => grant.allowedOperations.includes(operation)) &&
    grant.scopes.length === scopes.length &&
    scopes.every((scope) => grant.scopes.includes(scope))
  );
}

export class FakeConsentRegistry implements ConsentRegistry, ConsentAuthority {
  /**
   * Explicit marker that this registry is a process-local test double. Production wiring MUST NOT
   * treat a registry with this marker as durable consent state.
   */
  readonly durability = 'process-local-ephemeral' as const;

  private readonly grants = new Map<string, ConsentGrant>();

  private buildKey(tenantId: string, sourceProfileId: string): string {
    return `${tenantId}::${sourceProfileId}`;
  }

  /**
   * Returns the stored record for a lineage, or `null`.
   * Fail closed: malformed identifiers or a corrupted stored record never yield a grant and never
   * throw, so a read path can never fail open.
   */
  private peek(tenantId: unknown, sourceProfileId: unknown): ConsentGrant | null {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      return null;
    }
    if (typeof sourceProfileId !== 'string' || !SOURCE_PROFILE_ID_REGEX.test(sourceProfileId)) {
      return null;
    }
    const stored = this.grants.get(this.buildKey(tenantId, sourceProfileId));
    if (stored === undefined || !isValidConsentGrantRecord(stored)) {
      return null;
    }
    return stored;
  }

  /** Projects the stored generation onto its EFFECTIVE status at `now` without mutating it. */
  private project(grant: ConsentGrant, now: Date): ConsentGrant {
    const status = deriveConsentStatus(grant, now);
    if (status === grant.status) {
      return grant;
    }
    return deepFreeze({ ...grant, status });
  }

  /**
   * Grants (or explicitly re-grants) consent for one lineage.
   *
   * - First grant: new `grantId`, `version` 1.
   * - Explicit re-grant (revoked / expired / changed terms): new `grantId`, `version` + 1.
   * - Idempotent re-affirmation (identical terms, current generation still active): unchanged
   *   generation returned so repeated scheduler calls cannot inflate versions.
   */
  grant(params: GrantConsentParams, now: Date = new Date()): ConsentGrant {
    if (params === null || typeof params !== 'object') {
      throw createInvalidArgumentError('grant(params) requires a params object');
    }
    const tenantId = normalizeTenantId(params.tenantId);
    const sourceProfileId = normalizeSourceProfileId(params.sourceProfileId);
    const clock = normalizeClock(now);
    const allowedOperations = normalizeTerms(
      params.allowedOperations,
      DEFAULT_ALLOWED_OPERATIONS,
      'allowedOperations',
    );
    const scopes = normalizeTerms(params.scopes, DEFAULT_SCOPES, 'scopes');
    const expiresAt = normalizeExpiresAt(params.expiresAt, clock);

    const existing = this.peek(tenantId, sourceProfileId);

    if (
      existing !== null &&
      deriveConsentStatus(existing, clock) === 'active' &&
      sameAuthorizationTerms(existing, allowedOperations, scopes, expiresAt)
    ) {
      return existing;
    }

    const record: ConsentGrant = deepFreeze({
      grantId: randomUUID(),
      tenantId,
      sourceProfileId,
      status: 'active',
      allowedOperations,
      scopes,
      grantedAt: clock.toISOString(),
      expiresAt,
      revokedAt: null,
      version: existing === null ? 1 : existing.version + 1,
    });

    this.grants.set(this.buildKey(tenantId, sourceProfileId), record);
    return record;
  }

  /**
   * Returns the current generation projected at `now`, or `null`.
   * Never throws: invalid identifiers or clocks are indistinguishable from "no consent".
   */
  get(tenantId: string, sourceProfileId: string, now: Date = new Date()): ConsentGrant | null {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return null;
    }
    const stored = this.peek(tenantId, sourceProfileId);
    return stored === null ? null : this.project(stored, now);
  }

  /**
   * Revokes consent for one lineage. Terminal and idempotent: the version is bumped exactly once,
   * `revokedAt` is preserved on repeat calls, and an expired grant is still closed out.
   */
  revoke(tenantId: string, sourceProfileId: string, now: Date = new Date()): ConsentGrant {
    const tenant = normalizeTenantId(tenantId);
    const profile = normalizeSourceProfileId(sourceProfileId);
    const clock = normalizeClock(now);

    const stored = this.peek(tenant, profile);
    if (stored === null) {
      // Uniform Agnosticism: identical NOT_FOUND for missing, malformed, and foreign-tenant lineages.
      throw createNotFoundError('Consent grant not found');
    }
    if (deriveConsentStatus(stored, clock) === 'revoked') {
      return stored;
    }

    const revoked: ConsentGrant = deepFreeze({
      ...stored,
      status: 'revoked',
      revokedAt: clock.toISOString(),
      version: stored.version + 1,
    });

    this.grants.set(this.buildKey(tenant, profile), revoked);
    return revoked;
  }

  /** Tenant-scoped, deterministically ordered projection of the current generations. */
  list(tenantId: string, now: Date = new Date()): readonly ConsentGrant[] {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      return Object.freeze([]);
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return Object.freeze([]);
    }

    const results: ConsentGrant[] = [];
    for (const stored of this.grants.values()) {
      if (stored.tenantId === tenantId) {
        results.push(this.project(stored, now));
      }
    }
    results.sort((left, right) =>
      left.sourceProfileId < right.sourceProfileId
        ? -1
        : left.sourceProfileId > right.sourceProfileId
          ? 1
          : 0,
    );

    return Object.freeze(results);
  }

  /**
   * Authoritative generation view used by the P0-C3C authorization fence.
   * A test/unit adapter only; the production implementation must read persisted state.
   */
  resolveGeneration(
    tenantId: string,
    sourceProfileId: string,
    now: Date = new Date(),
  ): AuthorizedConsentGeneration | null {
    const grant = this.get(tenantId, sourceProfileId, now);
    if (grant === null) {
      return null;
    }
    return toAuthorizedConsentGeneration(grant, now);
  }

  clear(): void {
    this.grants.clear();
  }
}
