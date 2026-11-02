import type { AuthContext, Id } from '@ember/domain';
import { z } from 'zod';
import { SourceProfileIdSchema, type SourceProfileId } from './commitment-schemas.js';
import { IdSchema, IsoDateTimeSchema } from './task-schemas.js';
import { toInvalidArgumentError } from './validation.js';

/**
 * P0-C3D consent contracts.
 *
 * Consent is the authorization fact that lets a tenant's agent read one source profile and
 * publish the outcome of that read. `@ember/connectors` owns the *in-memory* evaluation
 * double (`FakeConsentRegistry`); this module owns the durable vocabulary and the persistence
 * port that PostgreSQL implements.
 *
 * Two properties are load-bearing:
 *
 * 1. **Authorization is not a credential.** Nothing here has a field for a token, cookie,
 *    password or key. A grant records *what* a tenant allowed, never the secret used to do it.
 * 2. **Every mutation is versioned.** `ConsentGrant.version` increments on grant, re-grant and
 *    revocation. Work records the version it was dispatched under, and publication compares
 *    the two inside one transaction (the "authorization fence"), so a revocation that lands
 *    between dispatch and publication is always observed.
 */

/** Effective status. `expired` is derived from `expiresAt` and the database clock. */
export const CONSENT_STATUSES = ['active', 'revoked', 'expired'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export const ConsentStatusSchema = z.enum(CONSENT_STATUSES);

/** Statuses actually stored. Expiry is never written down, so it can never go stale. */
export const PERSISTED_CONSENT_STATUSES = ['active', 'revoked'] as const;
export type PersistedConsentStatus = (typeof PERSISTED_CONSENT_STATUSES)[number];

/** Closed operation vocabulary a grant can authorise. */
export const CONSENT_OPERATIONS = ['read_snapshot', 'publish_outcome'] as const;
export type ConsentOperation = (typeof CONSENT_OPERATIONS)[number];
export const ConsentOperationSchema = z.enum(CONSENT_OPERATIONS);

/**
 * Operations a grant authorises when the caller does not narrow it. A commitment needs both:
 * `read_snapshot` to read the source and `publish_outcome` to record what changed.
 */
export const DEFAULT_CONSENT_OPERATIONS: readonly ConsentOperation[] = Object.freeze([
  ...CONSENT_OPERATIONS,
]);

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
 * Why a consent check failed. These codes are returned by `ConsentDecision`, never leaked as
 * HTTP text: a denial is always reported to a client as the fixed `POLICY_DENIED` message.
 */
export const CONSENT_DENIAL_CODES = [
  'CONSENT_NOT_FOUND',
  'CONSENT_REVOKED',
  'CONSENT_EXPIRED',
  'OPERATION_NOT_ALLOWED',
  'CONSENT_VERSION_STALE',
] as const;
export type ConsentDenialCode = (typeof CONSENT_DENIAL_CODES)[number];

/** Public consent record (wire format uses snake_case, like every other Ember DTO). */
export interface ConsentGrantDto {
  readonly consent_id: Id;
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
  consent_id: IdSchema,
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

/** Durable consent record used inside the application (camelCase, timestamps as RFC 3339). */
export interface ConsentGrant {
  readonly consentId: Id;
  readonly tenantId: Id;
  readonly sourceProfileId: SourceProfileId;
  readonly status: ConsentStatus;
  readonly allowedOperations: readonly ConsentOperation[];
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GrantConsentCommand {
  readonly sourceProfileId: SourceProfileId;
  /** Defaults to `DEFAULT_CONSENT_OPERATIONS`. */
  readonly allowedOperations?: readonly ConsentOperation[];
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
   * with `replayed: true` and does not advance `version`. Any difference (operations, scopes,
   * expiry) or a previously revoked/expired grant advances `version`.
   */
  grant(
    ctx: AuthContext,
    cmd: GrantConsentCommand,
  ): Promise<{ readonly consent: ConsentGrant; readonly replayed: boolean }>;

  /** Revoke an existing grant. Revoking an already-revoked grant is idempotent. */
  revoke(
    ctx: AuthContext,
    sourceProfileId: SourceProfileId,
    options?: RevokeConsentOptions,
  ): Promise<ConsentGrant>;

  /** Return `null` for a missing grant and for a grant owned by another tenant. */
  get(ctx: AuthContext, sourceProfileId: SourceProfileId): Promise<ConsentGrant | null>;

  /** Tenant-scoped listing, newest first. */
  list(ctx: AuthContext): Promise<readonly ConsentGrant[]>;
}

/**
 * Outcome of one consent check. `consentVersion` is the version that authorised the operation
 * (the value a publication fence must record), or `null` when nothing authorised it.
 */
export interface ConsentDecision {
  readonly allowed: boolean;
  readonly denialCode: ConsentDenialCode | null;
  readonly consentVersion: number | null;
}

/**
 * Server-side consent evaluator for the worker path.
 *
 * It takes a `tenantId` rather than an `AuthContext` because the worker derives its tenant
 * from the persisted Run, never from a user credential. `requiredVersion` is the fence: when
 * it is provided, the grant must still be at exactly that version.
 */
export interface ConsentEvaluator {
  evaluateConsent(
    tenantId: Id,
    sourceProfileId: SourceProfileId,
    operation: ConsentOperation,
    requiredVersion?: number | null,
  ): Promise<ConsentDecision>;
}

export function toConsentGrantDto(grant: ConsentGrant): ConsentGrantDto {
  return {
    consent_id: grant.consentId,
    tenant_id: grant.tenantId,
    source_profile_id: grant.sourceProfileId,
    status: grant.status,
    allowed_operations: grant.allowedOperations,
    scopes: grant.scopes,
    granted_at: grant.grantedAt,
    expires_at: grant.expiresAt,
    revoked_at: grant.revokedAt,
    version: grant.version,
    created_at: grant.createdAt,
    updated_at: grant.updatedAt,
  };
}

export function toConsentGrantListDto(grants: readonly ConsentGrant[]): ConsentGrantListDto {
  return { consents: grants.map(toConsentGrantDto) };
}

export function toConsentGrantReceiptDto(
  grant: ConsentGrant,
  replayed: boolean,
): ConsentGrantReceiptDto {
  return { consent: toConsentGrantDto(grant), replayed };
}
