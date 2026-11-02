import {
  createConsentAuthorizationFence,
  validateConsentAuthorizationFence,
  validateConsentGenerationBinding,
  type AuthorizedConsentGeneration,
  type ConsentAuthority,
  type ConsentAuthorizationFence,
  type ConsentGrant,
} from '@ember/connectors';
import { DomainError, type Id } from '@ember/domain';

/**
 * P0-C3B Consent authorization seam.
 *
 * ## Contract ownership
 *
 * The Consent contract is owned by P0-C3C and lives in `@ember/connectors`
 * (`docs/P0C3-C-CONSENT-CONTRACT.md`). This module declares **no** Consent vocabulary of its own:
 * the fence, the generation view, the authority port, the digest and both validators are imported
 * from the canonical package. What P0-C3B adds is only the Worker-facing shape:
 *
 * - {@link ConsentFenceAuthority} — the authority plus the two fence operations the Worker needs;
 * - {@link ConsentReadAuthorization} — what a *verified* generation authorizes, which the connector
 *   boundary needs in order to authorize the read itself;
 * - {@link fromResolvedGenerationConsent} — the single adapter from a canonical `ConsentAuthority`
 *   to those gates.
 *
 * Nothing here re-implements C3C validation: fence shape, digest, tenant/profile binding, status
 * precedence and staleness are decided by `validateConsentAuthorizationFence`, and the
 * "the policy-evaluated grant must BE the fenced generation" invariant by
 * `validateConsentGenerationBinding`.
 *
 * ## Why a fence and not a boolean
 *
 * A boolean verdict cannot tell "Consent was active for this occurrence" from "Consent was active,
 * then revoked, then re-granted for a different approval". The Worker authorizes a read, the read
 * takes time, and an Outcome is published afterwards, so authorization must be bound to the exact
 * generation that authorized the read:
 *
 * - `authorizeFence` captures the generation before the read;
 * - the fence travels inside `TrustedSourceAccessContext.authorizationFence` (Lane C boundary);
 * - `assertFenceCurrent` re-checks it immediately before publication.
 *
 * ## Why the verified generation also reports its scope
 *
 * A fence that only answers "still active?" cannot authorize a read, because the connector
 * boundary decides read access from `grant.allowedOperations`. The Worker therefore resolves the
 * authorized operations together with the generation check and mirrors exactly those into the
 * connector registry. Nothing is defaulted: a store that cannot report them denies the read, so
 * "granted for something else" can never be spent as "granted for `read_snapshot`".
 */

/**
 * Re-exported canonical C3C vocabulary.
 *
 * `@ember/execution` previously declared field-for-field mirrors of these types. They are now the
 * single definitions from `@ember/connectors`, so the Worker, the connector boundary and (once
 * merged) the PostgreSQL authority cannot drift apart.
 */
export type {
  AuthorizedConsentGeneration,
  ConsentAuthority,
  ConsentAuthorizationFence,
  ConsentGrant,
};

/**
 * The read-only grant lookup a fence-aware Worker needs in order to learn *what* the resolved
 * generation authorizes.
 *
 * Canonical C3C `AuthorizedConsentGeneration` carries identity and status only (operations are
 * deliberately not part of that view), so a Worker that has to mirror the authorized scope reads
 * the grant record itself. `ConsentRegistry.get` is the canonical shape; the return type is
 * widened to a promise because the durable PostgreSQL store reads asynchronously.
 */
export interface ConsentGrantSource {
  get(
    tenantId: string,
    sourceProfileId: string,
    now?: Date,
  ): ConsentGrant | null | Promise<ConsentGrant | null>;
}

/** The lineage a fence is expected to describe. Comes from persisted state, never from the fence. */
export interface ConsentFenceExpectation {
  readonly tenantId: Id;
  readonly sourceProfileId: string;
}

/**
 * What the authority confirms about the read it just authorized.
 *
 * These are the operations and scopes of the *durable* Consent record, never a Worker default.
 * The Worker mirrors them verbatim into the connector boundary because `evaluateSourceAccess`
 * decides read access from `grant.allowedOperations`: substituting a default there would silently
 * upgrade a grant that never included `read_snapshot`.
 */
export interface ConsentReadAuthorization {
  readonly allowedOperations: readonly string[];
  readonly scopes: readonly string[];
}

/**
 * Consent authority that can issue and re-verify a versioned authorization fence.
 *
 * Extends the canonical C3C `ConsentAuthority` (`resolveGeneration`), so an object of this shape is
 * always usable at the connector boundary as well. Every method MUST fail closed with
 * `POLICY_DENIED` when Consent is missing, revoked, expired, or unreadable.
 */
export interface ConsentFenceAuthority extends ConsentAuthority {
  /** Resolves only while the lineage has an effectively active generation. */
  assertActive(tenantId: Id, sourceProfileId: string): Promise<void>;

  /** Returns the canonical fence of the currently active generation, or rejects `POLICY_DENIED`. */
  authorizeFence(tenantId: Id, sourceProfileId: string): Promise<ConsentAuthorizationFence>;

  /**
   * Resolves only while `fence` still describes the active generation of `expected`, and reports
   * what that generation authorizes.
   *
   * A store whose generation moved (revocation, expiry, re-grant, approval invalidation) MUST
   * reject, and the caller MUST NOT publish anything after a rejection. An authority that cannot
   * report the authorized operations MUST reject as well: a read authorized without a scope is
   * indistinguishable from a read authorized for everything.
   */
  assertFenceCurrent(
    fence: ConsentAuthorizationFence,
    expected: ConsentFenceExpectation,
  ): Promise<ConsentReadAuthorization>;
}

/**
 * Structural check used at every seam that must not trust a caller-supplied object.
 *
 * A plain `ConsentAuthority` (generation read only) is *not* fence-capable: it cannot prove which
 * generation authorized a read, so an execution configured with one fails closed instead of
 * publishing an unattributable Outcome.
 */
export function isConsentFenceAuthority(value: unknown): value is ConsentFenceAuthority {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.resolveGeneration === 'function' &&
    typeof candidate.assertActive === 'function' &&
    typeof candidate.authorizeFence === 'function' &&
    typeof candidate.assertFenceCurrent === 'function'
  );
}

/**
 * Structural check for the canonical C3C `ConsentAuthority` port (`resolveGeneration`).
 *
 * The Worker uses it to decide whether an injected object may be handed to the connector boundary
 * as the authoritative generation source.
 */
export function isConsentAuthority(value: unknown): value is ConsentAuthority {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { resolveGeneration?: unknown }).resolveGeneration === 'function'
  );
}

/** Options for {@link fromResolvedGenerationConsent}. */
export interface ResolvedGenerationAdapterOptions {
  /** Evaluator clock. Exposed so tests can pin fence issuance and staleness. */
  readonly now?: () => Date;
  /**
   * Authoritative grant lookup used to obtain the operations/scopes the resolved generation
   * authorizes. When omitted, every read is denied: the Worker will not invent a scope.
   */
  readonly grants?: ConsentGrantSource;
}

/**
 * Binds a canonical C3C `ConsentAuthority` to the Worker's fence gates.
 *
 * This is the single integration point for the durable store. The durable authority implements
 * `resolveGeneration`; this adapter derives all three gate methods from it, so no gate ever runs
 * against a verdict-only object and no caller has to re-implement generation comparison:
 *
 * - `assertActive` — resolves the generation and requires effective status `active`;
 * - `authorizeFence` — mints the canonical fence (with digest) for the grant that IS that
 *   generation, then re-validates it with the canonical validators;
 * - `assertFenceCurrent` — re-resolves and re-validates the SAME `grantId` + `version`.
 *
 * The generation is re-resolved on every call and never cached, so a fence captured for one
 * Task/Run attempt cannot authorize a later attempt or a new lease epoch: the next attempt mints
 * its own fence, and a stale one fails `CONSENT_FENCE_STALE`.
 */
export function fromResolvedGenerationConsent(
  authority: ConsentAuthority,
  options: ResolvedGenerationAdapterOptions = {},
): ConsentFenceAuthority {
  const now = options.now ?? ((): Date => new Date());
  const grants = options.grants;

  const resolveActive = async (
    tenantId: string,
    sourceProfileId: string,
    at: Date,
  ): Promise<AuthorizedConsentGeneration> => {
    let generation: AuthorizedConsentGeneration | null;

    try {
      generation = await authority.resolveGeneration(tenantId, sourceProfileId, at);
    } catch (error) {
      throw toConsentDenied(error, 'Source Consent could not be resolved');
    }

    if (generation === null || typeof generation !== 'object') {
      throw consentDenied('Source Consent is not active for this source profile');
    }

    // A store answering for another lineage is not this lineage's authority.
    if (generation.tenantId !== tenantId || generation.sourceProfileId !== sourceProfileId) {
      throw consentDenied('Source Consent was resolved for another source profile');
    }

    if (generation.status !== 'active') {
      throw consentDenied('Source Consent is not active for this source profile');
    }

    return generation;
  };

  const readGrant = async (
    tenantId: string,
    sourceProfileId: string,
    at: Date,
  ): Promise<ConsentGrant> => {
    if (grants === undefined) {
      throw consentDenied(
        'Consent store cannot report the operations authorized for this source profile',
      );
    }

    let grant: ConsentGrant | null;

    try {
      grant = await grants.get(tenantId, sourceProfileId, at);
    } catch (error) {
      throw toConsentDenied(error, 'Source Consent grant could not be read');
    }

    if (grant === null || typeof grant !== 'object') {
      throw consentDenied('Source Consent is not active for this source profile');
    }

    return grant;
  };

  /**
   * Re-validates a fence against the authoritative generation and proves the grant the Worker is
   * about to mirror IS that generation. Both checks are canonical C3C helpers; neither is
   * reproduced here.
   */
  const assertFenceIsTheGeneration = (
    fence: ConsentAuthorizationFence,
    generation: AuthorizedConsentGeneration,
    grant: ConsentGrant,
    at: Date,
  ): void => {
    const expectation: ConsentFenceExpectation = {
      tenantId: generation.tenantId,
      sourceProfileId: generation.sourceProfileId,
    };

    const fenceValidation = validateConsentAuthorizationFence({
      fence,
      tenantId: expectation.tenantId,
      sourceProfileId: expectation.sourceProfileId,
      authoritative: generation,
      now: at,
    });

    if (!fenceValidation.valid) {
      throw consentDenied(
        `Consent authorization fence is not usable: ${fenceValidation.code.toLowerCase()}`,
      );
    }

    const binding = validateConsentGenerationBinding({
      grant,
      fence,
      tenantId: expectation.tenantId,
      sourceProfileId: expectation.sourceProfileId,
    });

    if (!binding.consistent) {
      throw consentDenied(
        `Consent authorization fence is not bound to the resolved grant: ${binding.code.toLowerCase()}`,
      );
    }
  };

  return {
    // Canonical C3C generation read, forwarded unchanged. Gates use the methods below; this exists
    // so the adapter is usable anywhere a `ConsentAuthority` is expected (e.g. the connector
    // boundary), without a second wrapper object.
    resolveGeneration(
      tenantId: string,
      sourceProfileId: string,
      at?: Date,
    ): ReturnType<ConsentAuthority['resolveGeneration']> {
      return authority.resolveGeneration(tenantId, sourceProfileId, at ?? now());
    },

    async assertActive(tenantId: Id, sourceProfileId: string): Promise<void> {
      await resolveActive(tenantId, sourceProfileId, now());
    },

    async authorizeFence(
      tenantId: Id,
      sourceProfileId: string,
    ): Promise<ConsentAuthorizationFence> {
      const at = now();
      const generation = await resolveActive(tenantId, sourceProfileId, at);
      const grant = await readGrant(tenantId, sourceProfileId, at);

      // Canonical minting: `createConsentAuthorizationFence` derives the digest and refuses a
      // generation that is not effectively active at `at`.
      let fence: ConsentAuthorizationFence;

      try {
        fence = createConsentAuthorizationFence(grant, at);
      } catch (error) {
        throw toConsentDenied(error, 'Source Consent cannot be fenced for this source profile');
      }

      assertFenceIsTheGeneration(fence, generation, grant, at);

      return fence;
    },

    async assertFenceCurrent(
      fence: ConsentAuthorizationFence,
      expected: ConsentFenceExpectation,
    ): Promise<ConsentReadAuthorization> {
      const at = now();
      const generation = await resolveActive(expected.tenantId, expected.sourceProfileId, at);
      const grant = await readGrant(expected.tenantId, expected.sourceProfileId, at);

      assertFenceIsTheGeneration(fence, generation, grant, at);

      return readAuthorizationOf(grant);
    },
  };
}

/**
 * Extracts the operations and scopes a consent grant authorizes, refusing to invent them.
 *
 * The grant is the only place these can come from: the fence deliberately carries no scopes
 * (P0C3-C §3) and the Worker must not derive permissions from the request. A grant that reports no
 * operations therefore authorizes nothing, which is the correct direction to fail.
 */
function readAuthorizationOf(grant: ConsentGrant): ConsentReadAuthorization {
  const operations = grant.allowedOperations;

  if (!Array.isArray(operations) || operations.length === 0) {
    throw consentDenied('Consent store did not report the operations authorized for this read');
  }

  const allowedOperations = operations.filter(
    (value): value is string => typeof value === 'string',
  );

  if (allowedOperations.length !== operations.length || allowedOperations.length === 0) {
    throw consentDenied('Consent store reported malformed authorized operations');
  }

  const reportedScopes = grant.scopes;

  if (!Array.isArray(reportedScopes)) {
    throw consentDenied('Consent store reported malformed consent scopes');
  }

  const scopes = reportedScopes.filter((value): value is string => typeof value === 'string');

  if (scopes.length !== reportedScopes.length) {
    throw consentDenied('Consent store reported malformed consent scopes');
  }

  return { allowedOperations, scopes };
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
