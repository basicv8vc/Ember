/**
 * Core type definitions for @ember/connectors.
 *
 * Implements P0-C3C:
 * - Provider-neutral, consent-aware, strictly read-only source port.
 * - Deterministic, non-sensitive fixture snapshots with zero network calls.
 * - Strict tenant isolation and fail-closed security boundary.
 */

export const SOURCE_CATEGORIES = ['public.feed', 'developer.repo', 'document.read'] as const;

export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/**
 * Format validation regex for source_profile_id.
 * Must be an opaque server-owned reference: lowercase alphanumeric, dots, dashes, underscores.
 * Absolutely forbids protocol schemes (://), userinfo (@), paths (/ or \), or whitespace.
 */
export const SOURCE_PROFILE_ID_REGEX = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/**
 * Frozen size and length ceilings for SourceSnapshot items and payloads.
 * Evaluated strictly in UTF-8 bytes where applicable.
 */
export const SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  profileIdMinChars: 3,
  profileIdMaxChars: 64,
  itemIdMaxChars: 128,
  itemTitleMaxChars: 256,
  itemContentSnippetMaxChars: 2048,
  maxItems: 50,
  maxPayloadBytes: 32768, // 32 KiB total snapshot ceiling
  maxMetadataKeys: 10,
  maxMetadataKeyChars: 32,
  maxMetadataValueChars: 256,
});

/**
 * Server-owned catalog profile defining an authorized external information source.
 * Under NO circumstances does this contain raw user URLs, secrets, or bearer tokens.
 */
export interface SourceProfile {
  readonly sourceProfileId: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly category: SourceCategory;
  readonly title: string;
  readonly description?: string;
  readonly allowedOperations: readonly string[];
  readonly maxItems: number;
  readonly maxPayloadBytes: number;
  readonly status: 'active' | 'disabled';
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One safe, non-sensitive item within a SourceSnapshot.
 * All text fields are treated as UNTRUSTED DATA, never instructions.
 */
export interface SourceSnapshotItem {
  readonly itemId: string;
  readonly title: string;
  readonly content: string;
  readonly publishedAt: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Immutable, strictly bounded snapshot representing observed source state.
 * Returns deeply frozen objects with a canonical SHA-256 digest.
 */
export interface SourceSnapshot {
  readonly sourceProfileId: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly items: readonly SourceSnapshotItem[];
}

/**
 * Verified caller execution context constructed by the authoritative worker / scheduler.
 * Untrusted callers or LLM prompts CANNOT supply or forge this context.
 */
export interface TrustedSourceAccessContext {
  readonly tenantId: string;
  readonly commitmentId: string;
  readonly occurrenceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly callerType: 'commitment_scheduler' | 'worker_runtime';
  readonly verifiedAt: string;
}

export type ConsentStatus = 'active' | 'revoked' | 'expired';

/**
 * Tenant-scoped permission record authorizing access to a source profile.
 */
export interface ConsentGrant {
  readonly grantId: string;
  readonly tenantId: string;
  readonly sourceProfileId: string;
  readonly status: ConsentStatus;
  readonly allowedOperations: readonly string[];
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly version: number;
}

export interface GrantConsentParams {
  readonly tenantId: string;
  readonly sourceProfileId: string;
  readonly allowedOperations?: readonly string[];
  readonly scopes?: readonly string[];
  readonly expiresAt?: string | null;
}

/**
 * Server-owned source access policy. Default action is always 'deny'.
 */
export interface SourceAccessPolicy {
  readonly version: number;
  readonly tenantId?: string;
  readonly allowedSourceProfileIds: readonly string[];
  readonly allowedOperations: readonly string[];
  readonly maxItems?: number;
  readonly maxPayloadBytes?: number;
  readonly defaultAction: 'deny';
}

export const SOURCE_DENIAL_CODES = [
  'SOURCE_PROFILE_NOT_FOUND',
  'SOURCE_PROFILE_DISABLED',
  'INVALID_SOURCE_PROFILE_ID',
  'TENANT_MISMATCH',
  'CONSENT_NOT_FOUND',
  'CONSENT_REVOKED',
  'CONSENT_EXPIRED',
  'OPERATION_NOT_ALLOWED',
  'SCOPE_NOT_GRANTED',
  'PAYLOAD_LIMIT_EXCEEDED',
  'READ_ABORTED',
  'REVOKED_DURING_EXECUTION',
  'UNTRUSTED_CONTENT_DETECTED',
  'POLICY_DENIED',
] as const;

export type SourceDenialCode = (typeof SOURCE_DENIAL_CODES)[number];

export interface SourceAccessDecisionAllowed {
  readonly allowed: true;
  readonly sourceProfileId: string;
  readonly operation: string;
}

export interface SourceAccessDecisionDenied {
  readonly allowed: false;
  readonly denialCode: SourceDenialCode;
  readonly reason: string;
  readonly diagnostic?: string;
}

export type SourceAccessDecision = SourceAccessDecisionAllowed | SourceAccessDecisionDenied;

/**
 * Provider-neutral read-only source interface.
 */
export interface SourceReader {
  readSnapshot(
    sourceProfileId: string,
    context: TrustedSourceAccessContext,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot>;
}

/**
 * Port for consent management and verification.
 */
export interface ConsentRegistry {
  grant(params: GrantConsentParams, now?: Date): ConsentGrant;
  get(tenantId: string, sourceProfileId: string, now?: Date): ConsentGrant | null;
  revoke(tenantId: string, sourceProfileId: string, now?: Date): ConsentGrant;
  list(tenantId: string, now?: Date): readonly ConsentGrant[];
  clear(): void;
}

/**
 * Privacy-preserving audit record asserting zero network calls.
 */
export interface SourceAuditRecord {
  readonly auditId: string;
  readonly timestamp: string;
  readonly tenantIdHash: string;
  readonly commitmentId: string;
  readonly occurrenceId: string;
  readonly taskId: string;
  readonly sourceProfileId: string;
  readonly decision: 'ALLOWED' | 'DENIED';
  readonly denialCode?: SourceDenialCode;
  readonly denialReason?: string;
  readonly networkCallsMade: 0;
}

export interface SourceAuditSink {
  record(record: SourceAuditRecord): void;
  getRecords(): readonly SourceAuditRecord[];
  clear(): void;
}
