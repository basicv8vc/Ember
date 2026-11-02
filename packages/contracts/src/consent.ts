/**
 * The canonical Consent contract: lifecycle semantics, the versioned authorization fence and the
 * authoritative generation port.
 *
 * This module is the SINGLE definition of the Consent contract in Ember. It lives in
 * `@ember/contracts` (not in a connector or a repository package) because three very different
 * layers must agree on it byte for byte:
 *
 * - `@ember/connectors` evaluates source access and re-validates fences around every read;
 * - `@ember/execution` / `apps/worker` mint a fence before a read and re-verify it before
 *   publication;
 * - `@ember/postgres` persists the generations and validates the recorded fence inside the
 *   transaction that publishes an Outcome.
 *
 * Frozen semantics (see `docs/P0C3-C-CONSENT-CONTRACT.md`, owned by P0-C3C):
 * - A consent lineage is identified by (`tenantId`, `sourceProfileId`).
 * - Every authorization unit is a GENERATION: (`grantId`, `version`), both monotonic and immutable.
 * - Revocation and expiry are terminal for the generation they apply to; only an explicit re-grant
 *   mints a new generation, and the superseded generation can never authorize again.
 * - Expiry is DERIVED from `expiresAt` at evaluation time and never rewrites the generation.
 * - All reads are fail-closed: an unparseable or unknown record is treated as not authorized.
 *
 * This module performs no I/O and no network calls.
 */

import { timingSafeEqual } from 'node:crypto';
import { DomainError } from '@ember/domain';
import { computeCanonicalDigest, deepFreeze } from './canonical.js';
import { SOURCE_PROFILE_ID_REGEX, type SourceProfileId } from './commitment-schemas.js';

/** `INVALID_ARGUMENT` rejection with a diagnostic that never echoes caller input. */
function createInvalidArgumentError(diagnostic = 'Invalid argument'): DomainError {
  return new DomainError('INVALID_ARGUMENT', diagnostic);
}

/**
 * Statuses a consent record can report. `expired` is an EFFECTIVE status derived from
 * `expiresAt`; it is never stored, so an expiry can never go stale in a column.
 */
export type ConsentStatus = 'active' | 'revoked' | 'expired';

/** Opaque identifier of one persisted generation. Never interpreted, only compared. */
export type ConsentGrantId = string;

/**
 * Tenant-scoped permission record authorizing access to one source profile.
 *
 * `grantId` + `version` is the GENERATION: the identity an authorization fence names and that
 * publication re-checks. Extra audit fields (row timestamps) may exist on a durable
 * implementation's records; they are deliberately not part of the contract.
 */
export interface ConsentGrant {
  readonly grantId: string;
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
  readonly status: ConsentStatus;
  readonly allowedOperations: readonly string[];
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly version: number;
}

/** Parameters of one explicit (re-)grant. `tenantId` is always server-resolved. */
export interface GrantConsentParams {
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
  readonly allowedOperations?: readonly string[];
  readonly scopes?: readonly string[];
  readonly expiresAt?: string | null;
}

/**
 * Monotonic authorization generation identity of one consent lineage
 * (`tenantId` + `sourceProfileId`). A generation is immutable and single-use for authorization:
 * once it is revoked or superseded by an explicit re-grant it can never authorize again.
 */
export interface ConsentGeneration {
  readonly grantId: string;
  readonly version: number;
}

/**
 * Authoritative view of the CURRENT consent generation for a lineage, as resolved from persisted
 * state at a given instant. `status` is the EFFECTIVE status: an active record whose `expiresAt`
 * has passed reports `expired` without the persisted row being rewritten.
 */
export interface AuthorizedConsentGeneration extends ConsentGeneration {
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
  readonly status: ConsentStatus;
  readonly expiresAt: string | null;
}

/**
 * Versioned authorization fence binding one worker attempt to ONE consent generation.
 *
 * Trust model (frozen in `docs/P0C3-C-CONSENT-CONTRACT.md` §3):
 * - `digest` is an integrity/self-consistency check over the fence body. It is NOT a MAC and NOT
 *   proof of authorization.
 * - The only proof of authorization is the authoritative {@link ConsentAuthority} confirming that
 *   `grantId` + `grantVersion` is still the current generation for the lineage.
 */
export interface ConsentAuthorizationFence {
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly issuedAt: string; // RFC 3339
  readonly digest: string; // SHA-256 hex (64 chars) over the canonical fence body
}

/**
 * Read-only authority over persisted consent generations.
 *
 * Implemented by the durable consent repository (PostgreSQL) and by `FakeConsentRegistry` for
 * tests. Implementations MAY be asynchronous so an authoritative database read can be awaited
 * without weakening the generation check.
 */
export interface ConsentAuthority {
  resolveGeneration(
    tenantId: string,
    sourceProfileId: SourceProfileId,
    now?: Date,
  ): AuthorizedConsentGeneration | null | Promise<AuthorizedConsentGeneration | null>;
}

/**
 * Pre-read Consent gate used by the Worker before it touches a source.
 *
 * This is deliberately NOT `ConsentAuthority`: a boolean gate cannot express WHICH generation
 * authorized a read, so it can authorize a read but can never satisfy a publication fence. It is
 * named for what it does so a verdict-only object can never be mistaken for the generation port.
 */
export interface ConsentReadGate {
  assertActive(tenantId: string, sourceProfileId: string): Promise<void>;
}

/** Why a source-access decision or a consent check was denied. */
export const SOURCE_DENIAL_CODES = [
  'SOURCE_PROFILE_NOT_FOUND',
  'SOURCE_PROFILE_DISABLED',
  'INVALID_SOURCE_PROFILE_ID',
  'TENANT_MISMATCH',
  'CONSENT_NOT_FOUND',
  'CONSENT_REVOKED',
  'CONSENT_EXPIRED',
  'CONSENT_FENCE_MISSING',
  'CONSENT_FENCE_INVALID',
  'CONSENT_FENCE_STALE',
  'CONSENT_GENERATION_MISMATCH',
  'OPERATION_NOT_ALLOWED',
  'SCOPE_NOT_GRANTED',
  'PAYLOAD_LIMIT_EXCEEDED',
  'READ_ABORTED',
  'REVOKED_DURING_EXECUTION',
  'UNTRUSTED_CONTENT_DETECTED',
  'POLICY_DENIED',
] as const;

export type SourceDenialCode = (typeof SOURCE_DENIAL_CODES)[number];

/**
 * Verified caller execution context constructed by the authoritative worker scheduler (P0-C3-0
 * §5.1). Untrusted callers or LLM prompts CANNOT supply or forge this context.
 *
 * `authorizationFence` is an OPTIONAL, server-assembled reference to the consent generation the
 * scheduler resolved from authoritative persisted state. It is never proof of authorization on
 * its own: the guarded source reader re-validates it against the authoritative
 * {@link ConsentAuthority} before and after every read.
 */
export interface TrustedSourceAccessContext {
  readonly tenantId: string;
  readonly commitmentId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly authorizedAt: string; // RFC 3339
  readonly authorizationFence?: ConsentAuthorizationFence;
}


/** Identifier of the frozen Consent lifecycle this package implements. */
export const CONSENT_LIFECYCLE_REVISION = 'p0c3c-consent-v1';

/** Scope required for every read-only source snapshot read. */
export const SOURCE_READ_SCOPE = 'source.readonly';

/** Operation name of the single read-only source capability. */
export const SOURCE_READ_OPERATION = 'read_snapshot';

/** Domain separator mixed into every authorization fence digest. */
export const CONSENT_FENCE_DIGEST_DOMAIN = 'ember.consent.fence.v1';

/** Fences issued further than this ahead of the evaluator clock are rejected. */
export const CONSENT_FENCE_MAX_CLOCK_SKEW_MS = 60_000;

export const CONSENT_FENCE_DIGEST_REGEX = /^[0-9a-f]{64}$/;

/** Upper bound for opaque `tenantId` / `grantId` values accepted from persisted state. */
export const CONSENT_GRANT_ID_MAX_CHARS = 128;

const CONSENT_STATUSES: readonly ConsentStatus[] = Object.freeze(['active', 'revoked', 'expired']);

/**
 * Returns the EFFECTIVE status of a consent record at `now`.
 *
 * Precedence (frozen):
 * 1. `revoked` (status or non-null `revokedAt`) wins over everything: revocation is terminal.
 * 2. `expired` when the recorded status is `expired`.
 * 3. `expired` when `expiresAt <= now` (boundary inclusive: the generation is dead at `expiresAt`).
 * 4. An unparseable `expiresAt`, unknown status, or invalid clock is treated as NOT active
 *    (`expired`) — fail closed, never fail open.
 */
export function deriveConsentStatus(
  grant: Pick<ConsentGrant, 'status' | 'revokedAt' | 'expiresAt'>,
  now: Date,
): ConsentStatus {
  if (grant === null || typeof grant !== 'object') {
    return 'expired';
  }
  if (grant.status === 'revoked' || grant.revokedAt !== null) {
    return 'revoked';
  }
  if (grant.status === 'expired') {
    return 'expired';
  }
  if (!CONSENT_STATUSES.includes(grant.status)) {
    return 'expired';
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return 'expired';
  }
  if (grant.expiresAt !== null) {
    const expiresAtMs = typeof grant.expiresAt === 'string' ? Date.parse(grant.expiresAt) : NaN;
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= now.getTime()) {
      return 'expired';
    }
  }
  return 'active';
}

/** True only when the grant is the current, unexpired, unrevoked authorization for its lineage. */
export function isConsentGrantActive(
  grant: Pick<ConsentGrant, 'status' | 'revokedAt' | 'expiresAt'> | null,
  now: Date,
): boolean {
  return (
    grant !== null && typeof grant === 'object' && deriveConsentStatus(grant, now) === 'active'
  );
}

/**
 * Maps a grant to the safe consent denial code implied by its effective status, or `null` when the
 * grant is active. Never returns caller-supplied text.
 */
export function describeConsentDenialCode(
  grant: Pick<ConsentGrant, 'status' | 'revokedAt' | 'expiresAt'>,
  now: Date,
): 'CONSENT_REVOKED' | 'CONSENT_EXPIRED' | null {
  const status = deriveConsentStatus(grant, now);
  if (status === 'active') {
    return null;
  }
  return status === 'revoked' ? 'CONSENT_REVOKED' : 'CONSENT_EXPIRED';
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

/**
 * Structural validation of a persisted consent record.
 * Anything that does not match the frozen shape is rejected (fail closed) instead of coerced.
 */
export function isValidConsentGrantRecord(value: unknown): value is ConsentGrant {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const grant = value as Record<string, unknown>;
  if (typeof grant.grantId !== 'string' || grant.grantId.length === 0) return false;
  if (grant.grantId.length > CONSENT_GRANT_ID_MAX_CHARS) return false;
  if (typeof grant.tenantId !== 'string' || grant.tenantId.length === 0) return false;
  if (
    typeof grant.sourceProfileId !== 'string' ||
    !SOURCE_PROFILE_ID_REGEX.test(grant.sourceProfileId)
  ) {
    return false;
  }
  if (typeof grant.status !== 'string' || !CONSENT_STATUSES.includes(grant.status as ConsentStatus))
    return false;
  if (!isStringArray(grant.allowedOperations) || !isStringArray(grant.scopes)) return false;
  if (typeof grant.grantedAt !== 'string' || Number.isNaN(Date.parse(grant.grantedAt)))
    return false;
  if (grant.expiresAt !== null) {
    if (typeof grant.expiresAt !== 'string' || Number.isNaN(Date.parse(grant.expiresAt))) {
      return false;
    }
  }
  if (grant.revokedAt !== null) {
    if (typeof grant.revokedAt !== 'string' || Number.isNaN(Date.parse(grant.revokedAt))) {
      return false;
    }
  }
  if (typeof grant.version !== 'number' || !Number.isInteger(grant.version) || grant.version < 1) {
    return false;
  }
  return true;
}

/**
 * Projects a persisted grant onto the authoritative generation view used by fence validation.
 * Throws for structurally invalid records so the caller cannot treat garbage as authorized state.
 */
export function toAuthorizedConsentGeneration(
  grant: ConsentGrant,
  now: Date,
): AuthorizedConsentGeneration {
  if (!isValidConsentGrantRecord(grant)) {
    throw createInvalidArgumentError('Consent grant record does not match the frozen contract');
  }
  return deepFreeze({
    tenantId: grant.tenantId,
    sourceProfileId: grant.sourceProfileId,
    grantId: grant.grantId,
    version: grant.version,
    status: deriveConsentStatus(grant, now),
    expiresAt: grant.expiresAt,
  });
}

export interface ConsentFenceBody {
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly issuedAt: string;
}

/**
 * Deterministic digest over the canonical fence body.
 *
 * SECURITY NOTE: this digest is a self-consistency checksum, NOT an authenticator. It cannot prove
 * that a worker was authorized, because any caller can recompute it. Authorization is established
 * exclusively by comparing the fence generation against authoritative persisted state.
 */
export function computeConsentFenceDigest(body: ConsentFenceBody): string {
  return computeCanonicalDigest({
    domain: CONSENT_FENCE_DIGEST_DOMAIN,
    tenantId: body.tenantId,
    sourceProfileId: body.sourceProfileId,
    grantId: body.grantId,
    grantVersion: body.grantVersion,
    issuedAt: body.issuedAt,
  });
}

/**
 * Mints an authorization fence for the CURRENT generation of an ACTIVE grant.
 * Throws `INVALID_ARGUMENT` for revoked/expired grants: a dead generation can never be fenced.
 */
export function createConsentAuthorizationFence(
  grant: ConsentGrant,
  issuedAt: Date = new Date(),
): ConsentAuthorizationFence {
  if (!isValidConsentGrantRecord(grant)) {
    throw createInvalidArgumentError('Cannot mint an authorization fence from an invalid grant');
  }
  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) {
    throw createInvalidArgumentError('Authorization fence issuance time must be a valid Date');
  }
  const status = deriveConsentStatus(grant, issuedAt);
  if (status !== 'active') {
    throw createInvalidArgumentError(
      `Cannot mint an authorization fence for a ${status} consent generation`,
    );
  }
  const body: ConsentFenceBody = {
    tenantId: grant.tenantId,
    sourceProfileId: grant.sourceProfileId,
    grantId: grant.grantId,
    grantVersion: grant.version,
    issuedAt: issuedAt.toISOString(),
  };
  return deepFreeze({ ...body, digest: computeConsentFenceDigest(body) });
}

export const CONSENT_FENCE_VALIDATION_CODES = [
  'VALID',
  'CONSENT_FENCE_MISSING',
  'CONSENT_FENCE_MALFORMED',
  'CONSENT_FENCE_TAMPERED',
  'CONSENT_FENCE_BINDING_MISMATCH',
  'CONSENT_FENCE_STALE',
  'CONSENT_NOT_FOUND',
  'CONSENT_REVOKED',
  'CONSENT_EXPIRED',
] as const;

export type ConsentFenceValidationCode = (typeof CONSENT_FENCE_VALIDATION_CODES)[number];

export interface ConsentFenceValidation {
  readonly valid: boolean;
  readonly code: ConsentFenceValidationCode;
  readonly denialCode: SourceDenialCode | null;
}

export interface ValidateConsentAuthorizationFenceParams {
  /** Fence supplied by the worker. Treated as UNTRUSTED input. */
  readonly fence: unknown;
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
  /** Current authoritative generation resolved from persisted consent state, or `null`. */
  readonly authoritative: AuthorizedConsentGeneration | null;
  readonly now: Date;
}

const INVALID_FENCE: ConsentFenceValidation = Object.freeze({
  valid: false,
  code: 'CONSENT_FENCE_MALFORMED',
  denialCode: 'CONSENT_FENCE_INVALID',
});

function fenceRejected(
  code: ConsentFenceValidationCode,
  denialCode: SourceDenialCode | null,
): ConsentFenceValidation {
  return Object.freeze({ valid: false, code, denialCode });
}

function safeDigestEquals(candidate: string, expected: string): boolean {
  if (typeof candidate !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * Strictly parses an untrusted fence value. Hostile getters or Proxies cannot escape as exceptions
 * because the whole read is contained, and an unreadable fence is rejected rather than coerced.
 */
function readFence(value: unknown): (ConsentFenceBody & { readonly digest: string }) | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  try {
    const record = value as Record<string, unknown>;
    const { tenantId, sourceProfileId, grantId, grantVersion, issuedAt, digest } = record;
    if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
    if (typeof sourceProfileId !== 'string' || !SOURCE_PROFILE_ID_REGEX.test(sourceProfileId)) {
      return null;
    }
    if (typeof grantId !== 'string' || grantId.length === 0) return null;
    if (grantId.length > CONSENT_GRANT_ID_MAX_CHARS) return null;
    if (
      typeof grantVersion !== 'number' ||
      !Number.isSafeInteger(grantVersion) ||
      grantVersion < 1
    ) {
      return null;
    }
    if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) return null;
    if (typeof digest !== 'string' || !CONSENT_FENCE_DIGEST_REGEX.test(digest)) return null;
    return { tenantId, sourceProfileId, grantId, grantVersion, issuedAt, digest };
  } catch {
    return null;
  }
}

/**
 * Validates an authorization fence against the authoritative consent generation.
 *
 * The fence is accepted ONLY when all of the following hold:
 * 1. It is structurally valid and its canonical digest matches (tamper/self-consistency check).
 * 2. It is bound to the same tenant and source profile as the caller context.
 * 3. An authoritative generation exists for that lineage (tenant-scoped lookup).
 * 4. The authoritative generation is effectively `active` at `now` (a revoked lineage yields
 *    `CONSENT_REVOKED`, an elapsed one yields `CONSENT_EXPIRED`).
 * 5. `grantId` AND `grantVersion` equal the CURRENT authoritative generation; otherwise the fence is
 *    `CONSENT_FENCE_STALE`. This is checked last so that the denial names the more specific reason
 *    whenever the fence still references the lineage's current generation.
 *
 * Consequence (frozen requirement): an old generation stays invalid after revoke and after
 * re-grant, even though fresh consent for the same lineage is active.
 */
export function validateConsentAuthorizationFence(
  params: ValidateConsentAuthorizationFenceParams,
): ConsentFenceValidation {
  const { fence, tenantId, sourceProfileId, authoritative, now } = params;

  const parsed = readFence(fence);
  if (parsed === null) {
    return INVALID_FENCE;
  }

  const expectedDigest = computeConsentFenceDigest({
    tenantId: parsed.tenantId,
    sourceProfileId: parsed.sourceProfileId,
    grantId: parsed.grantId,
    grantVersion: parsed.grantVersion,
    issuedAt: parsed.issuedAt,
  });
  if (!safeDigestEquals(parsed.digest, expectedDigest)) {
    return fenceRejected('CONSENT_FENCE_TAMPERED', 'CONSENT_FENCE_INVALID');
  }

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return INVALID_FENCE;
  }

  if (Date.parse(parsed.issuedAt) > now.getTime() + CONSENT_FENCE_MAX_CLOCK_SKEW_MS) {
    return INVALID_FENCE;
  }

  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return INVALID_FENCE;
  }
  if (parsed.tenantId !== tenantId || parsed.sourceProfileId !== sourceProfileId) {
    return fenceRejected('CONSENT_FENCE_BINDING_MISMATCH', 'TENANT_MISMATCH');
  }

  if (authoritative === null || typeof authoritative !== 'object') {
    return fenceRejected('CONSENT_NOT_FOUND', 'CONSENT_NOT_FOUND');
  }
  if (authoritative.tenantId !== tenantId || authoritative.sourceProfileId !== sourceProfileId) {
    return fenceRejected('CONSENT_FENCE_BINDING_MISMATCH', 'TENANT_MISMATCH');
  }

  if (parsed.grantId !== undefined && authoritative.grantId === parsed.grantId) {
    // Same generation: the denial reason is the lineage's authorization state, not staleness.
    if (authoritative.status === 'revoked') {
      return fenceRejected('CONSENT_REVOKED', 'CONSENT_REVOKED');
    }
    if (authoritative.status !== 'active') {
      return fenceRejected('CONSENT_EXPIRED', 'CONSENT_EXPIRED');
    }
  }

  if (parsed.grantId !== authoritative.grantId || parsed.grantVersion !== authoritative.version) {
    return fenceRejected('CONSENT_FENCE_STALE', 'CONSENT_FENCE_STALE');
  }

  return Object.freeze({ valid: true, code: 'VALID', denialCode: null });
}

export const CONSENT_GENERATION_BINDING_CODES = [
  'VALID',
  'TENANT_MISMATCH',
  'CONSENT_NOT_FOUND',
  'CONSENT_FENCE_INVALID',
  'CONSENT_GENERATION_MISMATCH',
] as const;

export type ConsentGenerationBindingCode = (typeof CONSENT_GENERATION_BINDING_CODES)[number];

export interface ConsentGenerationBindingValidation {
  readonly consistent: boolean;
  readonly code: ConsentGenerationBindingCode;
  readonly denialCode: SourceDenialCode | null;
}

export interface ValidateConsentGenerationBindingParams {
  /** Grant the perimeter read from the registry and evaluated policy against. */
  readonly grant: ConsentGrant | null;
  /** Fence supplied by the worker, or `undefined` / `null` when none was supplied. */
  readonly fence: unknown;
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
}

const CONSISTENT_BINDING: ConsentGenerationBindingValidation = Object.freeze({
  consistent: true,
  code: 'VALID',
  denialCode: null,
});

const UNBINDABLE_GRANT_BINDING: ConsentGenerationBindingValidation = Object.freeze({
  consistent: false,
  code: 'CONSENT_NOT_FOUND',
  denialCode: 'CONSENT_NOT_FOUND',
});

const MISMATCHED_BINDING: ConsentGenerationBindingValidation = Object.freeze({
  consistent: false,
  code: 'CONSENT_GENERATION_MISMATCH',
  denialCode: 'CONSENT_GENERATION_MISMATCH',
});

const INVALID_FENCE_BINDING: ConsentGenerationBindingValidation = Object.freeze({
  consistent: false,
  code: 'CONSENT_FENCE_INVALID',
  denialCode: 'CONSENT_FENCE_INVALID',
});

const TENANT_MISMATCH_BINDING: ConsentGenerationBindingValidation = Object.freeze({
  consistent: false,
  code: 'TENANT_MISMATCH',
  denialCode: 'TENANT_MISMATCH',
});

/**
 * Validates the GENERATION BINDING invariant of the perimeter (P0-C3C, CTO round 2).
 *
 * Verifying a fence against the authority is not sufficient on its own: the perimeter also evaluates
 * policy (`allowedOperations`, `scopes`, tenant, status) against the grant returned by
 * `ConsentRegistry.get()`. If those two sources disagree, a fence for generation G2 could authorize a
 * read whose permissions were taken from generation G1 — i.e. the fence would be a rubber stamp on
 * terms it never described. This function closes that gap by requiring the policy-evaluated grant to
 * BE the fenced generation:
 *
 * 1. No fence supplied → nothing to bind (`VALID`); legacy fence-less reads are unaffected.
 * 2. An unreadable fence is `CONSENT_FENCE_INVALID` (never coerced, never trusted).
 * 3. The fence must name the caller's tenant and source profile → else `TENANT_MISMATCH`.
 * 4. A missing / unreadable grant is `CONSENT_NOT_FOUND` (indistinguishable from "no consent").
 * 5. The grant must belong to the caller's lineage → else `TENANT_MISMATCH`.
 * 6. `grantId` AND `version` must equal the fence generation → else `CONSENT_GENERATION_MISMATCH`.
 *
 * Every branch fails closed; a hostile getter or Proxy thrown while the grant is read is reported as
 * `CONSENT_GENERATION_MISMATCH` and the thrown value is never inspected.
 */
export function validateConsentGenerationBinding(
  params: ValidateConsentGenerationBindingParams,
): ConsentGenerationBindingValidation {
  if (params === null || typeof params !== 'object') {
    return MISMATCHED_BINDING;
  }
  const { grant, fence, tenantId, sourceProfileId } = params;
  if (fence === undefined || fence === null) {
    return CONSISTENT_BINDING;
  }
  try {
    const parsed = readFence(fence);
    if (parsed === null) {
      return INVALID_FENCE_BINDING;
    }
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      return INVALID_FENCE_BINDING;
    }
    if (parsed.tenantId !== tenantId || parsed.sourceProfileId !== sourceProfileId) {
      return TENANT_MISMATCH_BINDING;
    }
    if (grant === null || typeof grant !== 'object') {
      return UNBINDABLE_GRANT_BINDING;
    }

    const record = grant as unknown as Record<string, unknown>;
    const grantId = record.grantId;
    const version = record.version;
    if (typeof grantId !== 'string' || grantId.length === 0) {
      return UNBINDABLE_GRANT_BINDING;
    }
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      return UNBINDABLE_GRANT_BINDING;
    }
    if (record.tenantId !== tenantId || record.sourceProfileId !== sourceProfileId) {
      return TENANT_MISMATCH_BINDING;
    }
    if (parsed.grantId !== grantId || parsed.grantVersion !== version) {
      return MISMATCHED_BINDING;
    }
    return CONSISTENT_BINDING;
  } catch {
    // A thrown getter / Proxy can never authorize: unprovable binding fails closed.
    return MISMATCHED_BINDING;
  }
}

/**
 * Duck-types a consent registry (or any object) as an authoritative generation source, so a
 * composition root can pass a durable authority explicitly and fall back to the registry.
 */
export function isConsentAuthority(value: unknown): value is ConsentAuthority {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { resolveGeneration?: unknown }).resolveGeneration === 'function'
  );
}
