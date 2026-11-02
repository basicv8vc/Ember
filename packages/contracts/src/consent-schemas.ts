import type { AuthContext, Id } from '@ember/domain';
import { z } from 'zod';
import { SourceProfileIdSchema, type SourceProfileId } from './commitment-schemas.js';
import {
  SOURCE_READ_OPERATION,
  SOURCE_READ_SCOPE,
  type ConsentGrant,
  type SourceDenialCode,
} from './consent.js';
import { IdSchema, IsoDateTimeSchema } from './task-schemas.js';
import { toInvalidArgumentError } from './validation.js';

/**
 * P0-C3D durable consent vocabulary: wire DTOs, request schemas and the persistence ports.
 *
 * The *security contract* itself (generations, the authorization fence, `ConsentAuthority`) lives
 * in `./consent.js` and is re-exported here. This module adds only what a durable store and its
 * HTTP surface need, so no package can end up with its own idea of what a grant is.
 *
 * Two properties are load-bearing:
 *
 * 1. **Authorization is not a credential.** Nothing here has a field for a token, cookie,
 *    password or key. A grant records *what* a tenant allowed, never the secret used to do it.
 * 2. **Every explicit re-grant mints a new generation** (`grantId` + `version`). Work records the
 *    generation it was dispatched under, and publication compares it with the current
 *    authoritative generation inside one transaction (the "authorization fence"), so a
 *    revocation or re-grant that lands between dispatch and publication is always observed.
 */

export {
  CONSENT_FENCE_DIGEST_DOMAIN,
  CONSENT_FENCE_DIGEST_REGEX,
  CONSENT_FENCE_MAX_CLOCK_SKEW_MS,
  CONSENT_GRANT_ID_MAX_CHARS,
  CONSENT_LIFECYCLE_REVISION,
  CONSENT_FENCE_VALIDATION_CODES,
  SOURCE_DENIAL_CODES,
  SOURCE_READ_OPERATION,
  SOURCE_READ_SCOPE,
  computeConsentFenceDigest,
  createConsentAuthorizationFence,
  deriveConsentStatus,
  isConsentAuthority,
  isConsentGrantActive,
  isValidConsentGrantRecord,
  toAuthorizedConsentGeneration,
  validateConsentAuthorizationFence,
  validateConsentGenerationBinding,
  type AuthorizedConsentGeneration,
  type ConsentAuthority,
  type ConsentAuthorizationFence,
  type ConsentFenceBody,
  type ConsentFenceValidation,
  type ConsentFenceValidationCode,
  type ConsentGeneration,
  type ConsentGrant,
  type ConsentGrantId,
  type ConsentReadGate,
  type ConsentStatus,
  type GrantConsentParams,
  type SourceDenialCode,
  type TrustedSourceAccessContext,
  type ValidateConsentAuthorizationFenceParams,
  type ValidateConsentGenerationBindingParams,
} from './consent.js';

/** Effective status. `expired` is derived from `expiresAt` and the database clock. */
export const CONSENT_STATUSES = ['active', 'revoked', 'expired'] as const;
export const ConsentStatusSchema = z.enum(CONSENT_STATUSES);

/** Statuses actually stored. Expiry is never written down, so it can never go stale. */
export const PERSISTED_CONSENT_STATUSES = ['active', 'revoked'] as const;
export type PersistedConsentStatus = (typeof PERSISTED_CONSENT_STATUSES)[number];

/**
 * Closed operation vocabulary a grant can authorise.
 *
 * The frozen connector contract defines exactly one source capability (`read_snapshot`); keeping
 * the vocabulary closed means a grant can never silently accumulate authority the connectors do
 * not implement.
 */
export const CONSENT_OPERATIONS = [SOURCE_READ_OPERATION] as const;
export type ConsentOperation = (typeof CONSENT_OPERATIONS)[number];
export const ConsentOperationSchema = z.enum(CONSENT_OPERATIONS);

/** Operations a grant authorises when the caller does not narrow it (connector contract default). */
export const DEFAULT_CONSENT_OPERATIONS: readonly ConsentOperation[] = Object.freeze([
  ...CONSENT_OPERATIONS,
]);

/**
 * Scopes a grant carries when the caller does not name them. `source.readonly` is the scope the
 * connector contract requires for `read_snapshot`; defaulting to it keeps a default grant usable
 * instead of silently useless.
 */
export const DEFAULT_CONSENT_SCOPES: readonly string[] = Object.freeze([SOURCE_READ_SCOPE]);

export const CONSENT_LIMITS = Object.freeze({
  maxOperations: CONSENT_OPERATIONS.length,
  maxScopes: 16,
  scopeMinChars: 1,
  scopeMaxChars: 64,
});

/** A grant scope is a bounded, lower-case token label. It is never a URL or a query string. */
export const ConsentScopeSchema = z
  .string()
  .min(CONSENT_LIMITS.scopeMinChars)
  .max(CONSENT_LIMITS.scopeMaxChars)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, 'scope must be a lower-case token label');

/**
 * Why a consent check failed. Every code is a member of the frozen `SourceDenialCode` union, so a
 * durable refusal and a connector refusal can never disagree about vocabulary. These codes are
 * internal: a client always sees the fixed `POLICY_DENIED` text.
 */
export const CONSENT_DENIAL_CODES = [
  'CONSENT_NOT_FOUND',
  'CONSENT_REVOKED',
  'CONSENT_EXPIRED',
  'CONSENT_FENCE_MISSING',
  'CONSENT_FENCE_STALE',
  'CONSENT_GENERATION_MISMATCH',
  'OPERATION_NOT_ALLOWED',
  'SCOPE_NOT_GRANTED',
] as const satisfies readonly SourceDenialCode[];

export type ConsentDenialCode = (typeof CONSENT_DENIAL_CODES)[number];


/** Public consent record (wire format uses snake_case, like every other Ember DTO). */
export interface ConsentGrantDto {
  /** Generation identity (`grantId`). Changes on every explicit re-grant. */
  readonly grant_id: Id;
  readonly tenant_id: Id;
  readonly source_profile_id: SourceProfileId;
  readonly status: ConsentStatus;
  readonly allowed_operations: readonly ConsentOperation[];
  readonly scopes: readonly string[];
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export const ConsentGrantDtoSchema: z.ZodType<ConsentGrantDto> = z.strictObject({
  grant_id: IdSchema,
  tenant_id: IdSchema,
  source_profile_id: SourceProfileIdSchema,
  status: ConsentStatusSchema,
  allowed_operations: z.array(ConsentOperationSchema).min(1).max(CONSENT_LIMITS.maxOperations),
  scopes: z.array(ConsentScopeSchema).max(CONSENT_LIMITS.maxScopes),
  granted_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema.nullable(),
  revoked_at: IsoDateTimeSchema.nullable(),
  version: z.number().int().min(1),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});

export interface ConsentGrantListDto {
  readonly consents: readonly ConsentGrantDto[];
}

/** Receipt for `POST /v1/consents`: an identical re-grant replays instead of bumping version. */
export interface ConsentGrantReceiptDto {
  readonly consent: ConsentGrantDto;
  readonly replayed: boolean;
}

/**
 * `expires_at` is inspected against the **database** clock inside the write transaction, not
 * against this process's clock, so a skewed host cannot manufacture a longer grant.
 */
export const GrantConsentRequestSchema = z.strictObject({
  source_profile_id: SourceProfileIdSchema,
  allowed_operations: z
    .array(ConsentOperationSchema)
    .min(1)
    .max(CONSENT_LIMITS.maxOperations)
    .optional(),
  scopes: z.array(ConsentScopeSchema).max(CONSENT_LIMITS.maxScopes).optional(),
  expires_at: IsoDateTimeSchema.nullable().optional(),
});

export type GrantConsentRequestDto = z.infer<typeof GrantConsentRequestSchema>;

export function parseGrantConsentRequestDto(value: unknown): GrantConsentRequestDto {
  const result = GrantConsentRequestSchema.safeParse(value);

  if (!result.success) {
    throw toInvalidArgumentError(result.error);
  }

  return result.data;
}

/**
 * `expected_version` makes a revocation a compare-and-set: a caller that observed version N
 * cannot revoke a grant that has since been re-granted to N+1 without noticing.
 */
export const RevokeConsentRequestSchema = z.strictObject({
  expected_version: z.number().int().min(1).optional(),
});

export type RevokeConsentRequestDto = z.infer<typeof RevokeConsentRequestSchema>;

export function parseRevokeConsentRequestDto(value: unknown): RevokeConsentRequestDto {
  const result = RevokeConsentRequestSchema.safeParse(value);

  if (!result.success) {
    throw toInvalidArgumentError(result.error);
  }

  return result.data;
}

/**
 * Durable consent record used inside the application (camelCase, timestamps as RFC 3339).
 *
 * It extends the canonical {@link ConsentGrant} with the row audit timestamps a durable store also
 * returns. Authorization never reads them: the generation is `grantId` + `version` only.
 */
export interface PersistedConsentGrant extends ConsentGrant {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GrantConsentCommand {
  readonly sourceProfileId: SourceProfileId;
  /** Defaults to `DEFAULT_CONSENT_OPERATIONS` (the connector contract's `read_snapshot`). */
  readonly allowedOperations?: readonly ConsentOperation[];
  /** Defaults to `DEFAULT_CONSENT_SCOPES` (`source.readonly`). */
  readonly scopes?: readonly string[];
  readonly expiresAt?: string | null;
}

export interface RevokeConsentOptions {
  /** Compare-and-set on `ConsentGrant.version`. */
  readonly expectedVersion?: number;
}

/**
 * Tenant-scoped consent persistence port.
 *
 * Every method takes the gateway-verified `AuthContext`: a caller can never choose its own
 * tenant, and another tenant's grant is indistinguishable from a missing one (`null` /
 * `NOT_FOUND`).
 */
export interface ConsentRepository {
  /**
   * Grant (or re-grant) consent for one source profile.
   *
   * An identical re-grant of a still-effective grant is idempotent: it returns the same record
   * with `replayed: true` and does not advance the generation. Any difference (operations,
   * scopes, expiry) or a previously revoked/expired grant mints a NEW generation: a new
   * `grantId` and a strictly greater `version` (P0-C3C C-06).
   */
  grant(
    ctx: AuthContext,
    cmd: GrantConsentCommand,
  ): Promise<{ readonly consent: PersistedConsentGrant; readonly replayed: boolean }>;

  /** Revoke an existing grant. Revoking an already-revoked grant is idempotent. */
  revoke(
    ctx: AuthContext,
    sourceProfileId: SourceProfileId,
    options?: RevokeConsentOptions,
  ): Promise<PersistedConsentGrant>;

  /** Return `null` for a missing grant and for a grant owned by another tenant. */
  get(ctx: AuthContext, sourceProfileId: SourceProfileId): Promise<PersistedConsentGrant | null>;

  /** Tenant-scoped listing, deterministically ordered by source profile. */
  list(ctx: AuthContext): Promise<readonly PersistedConsentGrant[]>;
}

/**
 * Outcome of one consent check.
 *
 * A decision names the GENERATION (`grantId` + `grantVersion`) that authorised the operation, so a
 * caller can persist it as an authorization fence. Both are `null` when nothing authorised it.
 */
export interface ConsentDecision {
  readonly allowed: boolean;
  readonly denialCode: ConsentDenialCode | null;
  readonly grantId: ConsentGrantId | null;
  readonly grantVersion: number | null;
}

/**
 * Server-side consent evaluator for the worker path.
 *
 * It takes a `tenantId` rather than an `AuthContext` because the worker derives its tenant
 * from the persisted Run, never from a user credential. `fence` is the recorded dispatch
 * generation: when it is provided, the grant must still be at exactly that generation.
 */
export interface ConsentEvaluator {
  evaluateConsent(
    tenantId: Id,
    sourceProfileId: SourceProfileId,
    operation: ConsentOperation,
    fence?: ConsentGeneration | null,
  ): Promise<ConsentDecision>;
}

export function toConsentGrantDto(grant: PersistedConsentGrant): ConsentGrantDto {
  return {
    grant_id: grant.grantId,
    tenant_id: grant.tenantId,
    source_profile_id: grant.sourceProfileId,
    status: grant.status,
    allowed_operations: grant.allowedOperations.filter((operation): operation is ConsentOperation =>
      CONSENT_OPERATIONS.includes(operation as ConsentOperation),
    ),
    scopes: grant.scopes,
    granted_at: grant.grantedAt,
    expires_at: grant.expiresAt,
    revoked_at: grant.revokedAt,
    version: grant.version,
    created_at: grant.createdAt,
    updated_at: grant.updatedAt,
  };
}

export function toConsentGrantListDto(
  grants: readonly PersistedConsentGrant[],
): ConsentGrantListDto {
  return { consents: grants.map(toConsentGrantDto) };
}

export function toConsentGrantReceiptDto(
  grant: PersistedConsentGrant,
  replayed: boolean,
): ConsentGrantReceiptDto {
  return { consent: toConsentGrantDto(grant), replayed };
}

