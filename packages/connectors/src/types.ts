/**
 * Core type definitions for @ember/connectors.
 *
 * Implements P0-C3-0 frozen contract specifications (§5):
 * - Provider-neutral, consent-aware, strictly read-only source port.
 * - Deterministic, non-sensitive fixture snapshots with zero network calls.
 * - Strict tenant isolation and fail-closed security boundary.
 */

export type SourceProfileId = string;

export const SOURCE_CATEGORIES = ['public.feed', 'developer.repo', 'document.read'] as const;

export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/**
 * Format validation regex for source_profile_id.
 * Must be an opaque server-owned reference: lowercase alphanumeric, dots, dashes, underscores.
 * Absolutely forbids protocol schemes (://), userinfo (@), paths (/ or \), or whitespace.
 */
export const SOURCE_PROFILE_ID_REGEX = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/**
 * Frozen size and length ceilings for SourceSnapshot items and payloads (P0-C3-0 §2.1 & §5.1).
 * Evaluated strictly in UTF-8 bytes where applicable.
 */
export const SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  profileIdMinChars: 3,
  profileIdMaxChars: 64,
  itemIdMaxChars: 128,
  itemTitleMaxChars: 256,
  itemContentSnippetMaxChars: 1_000,
  maxItems: 50,
  maxPayloadBytes: 32_768, // 32 KiB total snapshot ceiling
});

/**
 * Server-owned catalog profile defining an authorized external information source.
 * Under NO circumstances does this contain raw user URLs, secrets, or bearer tokens.
 */
export interface SourceProfile {
  readonly sourceProfileId: SourceProfileId;
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
 * One safe, non-sensitive item within a SourceSnapshot (P0-C3-0 §5.1).
 * All text fields are treated as UNTRUSTED DATA, never instructions.
 */
export interface SourceSnapshotItem {
  readonly id: string; // Max 128 chars
  readonly title: string; // Max 256 chars
  readonly contentSnippet: string; // Max 1,000 chars, untrusted text
  readonly observedAt: string; // RFC 3339
}

/**
 * Immutable, strictly bounded snapshot representing observed source state (P0-C3-0 §5.1).
 * Returns deeply frozen objects with a canonical SHA-256 digest.
 */
export interface SourceSnapshot {
  readonly sourceProfileId: SourceProfileId;
  readonly observedAt: string; // RFC 3339
  readonly digest: string; // SHA-256 hex string (64 characters)
  readonly boundedSafeItems: readonly SourceSnapshotItem[]; // Max 50 items
}

/**
 * The Consent contract (grants, generations, the authorization fence, the authoritative port) is
 * defined ONCE in `@ember/contracts` and re-exported here so every connector module and test keeps
 * importing it from `@ember/connectors`.
 *
 * `authorizationFence` on {@link TrustedSourceAccessContext} is an OPTIONAL, server-assembled
 * reference to the consent generation the scheduler resolved from authoritative persisted state
 * (see `docs/P0C3-C-CONSENT-CONTRACT.md`). It is never proof of authorization on its own: the
 * guarded source reader re-validates it against the authoritative authority before and after every
 * read.
 */
import type {
  ConsentGrant,
  GrantConsentParams,
  SourceDenialCode,
  TrustedSourceAccessContext,
} from '@ember/contracts';

export type {
  AuthorizedConsentGeneration,
  ConsentAuthority,
  ConsentAuthorizationFence,
  ConsentGeneration,
  ConsentGrant,
  ConsentStatus,
  GrantConsentParams,
  SourceDenialCode,
  TrustedSourceAccessContext,
} from '@ember/contracts';

export { SOURCE_DENIAL_CODES } from '@ember/contracts';

/**
 * Server-owned source access policy. Default action is always 'deny'.
 */
export interface SourceAccessPolicy {
  readonly version: number;
  readonly tenantId?: string;
  readonly allowedSourceProfileIds: readonly SourceProfileId[];
  readonly allowedOperations: readonly string[];
  readonly maxItems?: number;
  readonly maxPayloadBytes?: number;
  readonly defaultAction: 'deny';
}

export interface SourceAccessDecisionAllowed {
  readonly allowed: true;
  readonly sourceProfileId: SourceProfileId;
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
 * Unified SourceReader interface (P0-C3-0 §5.1).
 */
export interface SourceReader {
  readSnapshot(
    profileId: SourceProfileId,
    trustedContext: TrustedSourceAccessContext,
    signal: AbortSignal,
  ): Promise<SourceSnapshot>;
}

/**
 * Port for consent management and verification.
 */
export interface ConsentRegistry {
  grant(params: GrantConsentParams, now?: Date): ConsentGrant;
  get(tenantId: string, sourceProfileId: SourceProfileId, now?: Date): ConsentGrant | null;
  revoke(tenantId: string, sourceProfileId: SourceProfileId, now?: Date): ConsentGrant;
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
  readonly taskId: string;
  readonly sourceProfileId: SourceProfileId;
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
