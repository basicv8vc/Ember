import type { ConsentAuthority } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';

/**
 * P0-C3B Consent authorization seam.
 *
 * ## Contract ownership
 *
 * The Consent contract is owned by P0-C3C (`docs/P0C3-C-CONSENT-CONTRACT.md`,
 * `@ember/connectors`). This module deliberately does **not** define a competing contract: the
 * fence below is a field-for-field structural mirror of `@ember/connectors`'
 * `ConsentAuthorizationFence`, the `resolveGeneration`-shaped authority view mirrors
 * `AuthorizedConsentGeneration`, and {@link fromResolvedGenerationConsent} is the single adapter
 * that binds a P0-C3C `ConsentAuthority` to the Worker's gates. When P0-C3C lands on this branch
 * these local declarations are replaced by imports with no call-site change.
 *
 * ## Why a fence and not a boolean
 *
 * A boolean verdict cannot tell "Consent was active for this occurrence" from "Consent was
 * active, then revoked, then re-granted for a different approval". The Worker authorizes a read,
 * the read takes time, and an Outcome is published afterwards, so authorization must be bound to
 * the exact generation that authorized the read:
 *
 * - {@link ConsentFenceAuthority.authorizeFence} captures the generation before the read;
 * - the fence travels with the source read (Lane C boundary);
 * - {@link ConsentFenceAuthority.assertFenceCurrent} re-checks it immediately before publication.
 *
 * Per P0C3-C §3 the `digest` is an integrity check, never proof of authorization: authority for
 * a read comes only from the authority confirming `grantId` + `grantVersion` is still current.
 * P0-C3B therefore treats `digest` as opaque and never trusts it.
 */

/** Mirrors P0-C3C `CONSENT_GRANT_ID_MAX_CHARS`. */
export const CONSENT_GRANT_ID_MAX_CHARS = 128;

/** Mirrors P0-C3C `CONSENT_FENCE_DIGEST_REGEX` (SHA-256 hex over the canonical fence body). */
export const CONSENT_FENCE_DIGEST_REGEX = /^[0-9a-f]{64}$/;

/**
 * Versioned proof that a Source Profile Consent generation authorized a read.
 *
 * Structural twin of P0-C3C `ConsentAuthorizationFence`. `grantVersion` is opaque to the Worker
 * except for equality: it is whatever the durable Consent store emits, and the Worker never
 * derives it.
 */
export interface ConsentAuthorizationFence {
  readonly tenantId: Id;
  readonly sourceProfileId: string;
  /** Identity of the authorization unit (P0-C3C generation). Distinguishes re-grant cycles. */
  readonly grantId: string;
  /** Monotonic generation version. Must be a positive integer. */
  readonly grantVersion: number;
  /** RFC 3339 timestamp of the authorization decision (audit metadata, not a freshness gate). */
  readonly issuedAt: string;
  /** SHA-256 hex integrity digest. Optional here: P0-C3C always mints it, and it never authorizes. */
  readonly digest?: string;
}

/**
 * Consent authority that can issue and re-verify a versioned authorization fence.
 *
 * `ConsentAuthority` (in `@ember/contracts`) remains the minimal async verdict port; this extended
 * port is what the orchestrator needs in order to bind a read to one generation. Every method
 * MUST fail closed with `POLICY_DENIED` when Consent is missing, revoked, expired, or unreadable.
 */
export interface ConsentFenceAuthority extends ConsentAuthority {
  /** Returns the fence of the currently active generation, or rejects with `POLICY_DENIED`. */
  authorizeFence(tenantId: Id, sourceProfileId: string): Promise<ConsentAuthorizationFence>;

  /**
   * Resolves only while `fence` still describes the active generation.
   *
   * A store whose generation moved (revocation, expiry, re-grant, approval invalidation) MUST
   * reject, and the caller MUST NOT publish anything after a rejection.
   */
  assertFenceCurrent(fence: ConsentAuthorizationFence): Promise<void>;
}

/**
 * Structural check used at every seam that must not trust a caller-supplied object.
 *
 * A plain `ConsentAuthority` (verdict only) is *not* fence-capable: it cannot prove which
 * generation authorized a read, so an execution configured with one fails closed instead of
 * publishing an unattributable Outcome.
 */
export function isConsentFenceAuthority(value: unknown): value is ConsentFenceAuthority {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.assertActive === 'function' &&
    typeof candidate.authorizeFence === 'function' &&
    typeof candidate.assertFenceCurrent === 'function'
  );
}

/**
 * Authoritative view of the CURRENT consent generation for a lineage.
 *
 * Structural twin of P0-C3C `AuthorizedConsentGeneration`. `status` is the EFFECTIVE status: an
 * active record whose `expiresAt` has passed reports `expired` without the row being rewritten.
 */
export interface AuthorizedConsentGenerationView {
  readonly grantId: string;
  readonly version: number;
  readonly tenantId: string;
  readonly sourceProfileId: string;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly expiresAt: string | null;
}

/**
 * Read-only authority over persisted consent generations (P0-C3C shape).
 *
 * This is the port Agent A's durable PostgreSQL store implements and `FakeConsentRegistry`
 * implements for tests. Resolving synchronously or asynchronously is allowed so an authoritative
 * database read can be awaited without weakening the generation check.
 */
export interface ResolvedGenerationConsentAuthority {
  resolveGeneration(
    tenantId: string,
    sourceProfileId: string,
    now?: Date,
  ):
    | AuthorizedConsentGenerationView
    | null
    | Promise<AuthorizedConsentGenerationView | null>;
}

/** True when the value exposes P0-C3C's `resolveGeneration` read port. */
export function isResolvedGenerationConsentAuthority(
  value: unknown,
): value is ResolvedGenerationConsentAuthority {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).resolveGeneration === 'function'
  );
}

/** Options for {@link fromResolvedGenerationConsent}. */
export interface ResolvedGenerationAdapterOptions {
  /** Clock used to stamp `issuedAt`. Injectable so audit ordering is deterministic in tests. */
  readonly now?: () => Date;
}

/**
 * Binds a P0-C3C `resolveGeneration` authority to the Worker's fence gates.
 *
 * This is the single integration point for Lane C / Agent A. A durable authority implements only
 * `resolveGeneration`; this adapter derives all three gate methods from it, so no gate ever runs
 * against a verdict-only object and no caller has to re-implement generation comparison:
 *
 * - `assertActive` — resolves the generation and requires effective status `active`;
 * - `authorizeFence` — mints the fence from the resolved generation;
 * - `assertFenceCurrent` — re-resolves and requires the SAME `grantId` + `version`.
 *
 * When the P0-C3C module lands on this branch, fence minting is delegated to
 * `createConsentAuthorizationFence` (which adds the canonical `digest`); the comparison logic here
 * already matches its semantics.
 */
export function fromResolvedGenerationConsent(
  authority: ResolvedGenerationConsentAuthority,
  options: ResolvedGenerationAdapterOptions = {},
): ConsentFenceAuthority {
  const now = options.now ?? ((): Date => new Date());

  const resolveActive = async (
    tenantId: string,
    sourceProfileId: string,
  ): Promise<AuthorizedConsentGenerationView> => {
    let generation: AuthorizedConsentGenerationView | null;

    try {
      generation = await authority.resolveGeneration(tenantId, sourceProfileId, now());
    } catch (error) {
      throw toConsentDenied(error, 'Source Consent could not be resolved');
    }

    if (generation === null || typeof generation !== 'object') {
      throw consentDenied('Source Consent is not active for this source profile');
    }

    if (generation.status !== 'active') {
      throw consentDenied('Source Consent is not active for this source profile');
    }

    return generation;
  };

  return {
    async assertActive(tenantId: Id, sourceProfileId: string): Promise<void> {
      await resolveActive(tenantId, sourceProfileId);
    },

    async authorizeFence(tenantId: Id, sourceProfileId: string): Promise<ConsentAuthorizationFence> {
      const generation = await resolveActive(tenantId, sourceProfileId);

      return parseConsentFence({
        tenantId,
        sourceProfileId,
        grantId: generation.grantId,
        grantVersion: generation.version,
        issuedAt: now().toISOString(),
      });
    },

    async assertFenceCurrent(fence: ConsentAuthorizationFence): Promise<void> {
      const parsed = parseConsentFence(fence);
      const generation = await resolveActive(parsed.tenantId, parsed.sourceProfileId);

      // Generation identity, not just the version number: a lineage whose versions restart on
      // re-grant would otherwise accept an authorization minted before the re-grant.
      if (generation.grantId !== parsed.grantId || generation.version !== parsed.grantVersion) {
        throw consentDenied('Source Consent was re-granted or revoked after the read was authorized');
      }
    },
  };
}

/**
 * Validates an untrusted fence value at a trust boundary.
 *
 * The fence may come from a durable Consent store or from a test double, so its shape is
 * re-verified instead of being assumed from the TypeScript type. Every rejection is a terminal,
 * content-free `POLICY_DENIED`.
 */
export function parseConsentFence(value: unknown): ConsentAuthorizationFence {
  if (value === null || typeof value !== 'object') {
    throw consentDenied('Consent authorization fence is missing');
  }

  const candidate = value as Record<string, unknown>;
  const { tenantId, sourceProfileId, grantId, grantVersion, issuedAt, digest } = candidate;

  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw consentDenied('Consent authorization fence has no tenant');
  }

  if (typeof sourceProfileId !== 'string' || sourceProfileId.length === 0) {
    throw consentDenied('Consent authorization fence has no source profile');
  }

  if (
    typeof grantId !== 'string' ||
    grantId.length === 0 ||
    grantId.length > CONSENT_GRANT_ID_MAX_CHARS
  ) {
    throw consentDenied('Consent authorization fence has no usable grant identity');
  }

  if (
    typeof grantVersion !== 'number' ||
    !Number.isInteger(grantVersion) ||
    grantVersion < 1 ||
    grantVersion > Number.MAX_SAFE_INTEGER
  ) {
    throw consentDenied('Consent authorization fence has no usable grant version');
  }

  if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) {
    throw consentDenied('Consent authorization fence has no authorization timestamp');
  }

  // A digest that is present must be well formed, but it is never an authorization input.
  if (digest !== undefined) {
    if (typeof digest !== 'string' || !CONSENT_FENCE_DIGEST_REGEX.test(digest)) {
      throw consentDenied('Consent authorization fence carries a malformed integrity digest');
    }
  }

  return {
    tenantId,
    sourceProfileId,
    grantId,
    grantVersion,
    issuedAt,
    ...(digest === undefined ? {} : { digest }),
  };
}

/**
 * Rejects a fence that belongs to another tenant or another Source Profile.
 *
 * A fence is only meaningful for the exact Occurrence identity the Worker resolved from
 * persisted state; reusing one across tenants or profiles would launder an authorization.
 */
export function assertFenceMatches(
  fence: ConsentAuthorizationFence,
  expected: { readonly tenantId: Id; readonly sourceProfileId: string },
): void {
  if (fence.tenantId !== expected.tenantId) {
    throw consentDenied('Consent authorization fence belongs to another tenant');
  }

  if (fence.sourceProfileId !== expected.sourceProfileId) {
    throw consentDenied('Consent authorization fence belongs to another source profile');
  }
}

/**
 * Normalizes any Consent failure into `POLICY_DENIED`.
 *
 * Consent denials must be terminal and indistinguishable from each other on the wire, and a
 * transport/driver error must never surface as a retryable success path.
 */
export function toConsentDenied(cause: unknown, fallback: string): DomainError {
  if (cause instanceof DomainError) {
    if (cause.code === 'POLICY_DENIED') {
      return cause;
    }

    return consentDenied(cause.message.length > 0 ? cause.message : fallback);
  }

  return consentDenied(fallback);
}

/** Fixed, content-free consent denial. Never carries source content or driver messages. */
export function consentDenied(reason: string): DomainError {
  return new DomainError('POLICY_DENIED', reason);
}
