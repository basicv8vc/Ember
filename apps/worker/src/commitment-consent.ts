import type { ConsentAuthority } from '@ember/contracts';
import type { Id } from '@ember/domain';
import {
  isConsentFenceAuthority,
  toConsentDenied,
  type ConsentFenceAuthority,
} from '@ember/execution';
import type { ConsentPublicationGuard } from '@ember/postgres';
import { isUnavailableConsentAuthority } from './commitment-source-reader.js';

/**
 * Single Worker-side seams for the (still missing) durable Lane C Source Consent dependency.
 *
 * P0-C3B must not invent Consent persistence: `migrations/**`, `packages/postgres/**` and
 * `packages/contracts/**` belong to Lane C, and the Consent *contract* (`ConsentGrant`,
 * `ConsentAuthority.resolveGeneration`, the fence shape) is frozen by P0-C3C in
 * `@ember/connectors`. What this module owns is the *wiring*, so that replacing one object in the
 * composition root simultaneously arms:
 *
 * 1. the pre-read versioned authorization fence used by `CommitmentOrchestrator`,
 * 2. the fence re-verification inside `CommitmentSourceReader` (pre- and post-read),
 * 3. the transaction-scoped publication guard the PostgreSQL repository already accepts,
 * 4. the startup gate that decides whether the Scheduler may run at all.
 *
 * The replacement is `fromResolvedGenerationConsent(authority)` from `@ember/execution`: a P0-C3C
 * `resolveGeneration` authority (Agent A's durable store) is adapted to `ConsentFenceAuthority`
 * without any gate changing. Until that object exists, every seam above fails closed.
 */

export interface ConsentReadinessGate {
  readonly ready: boolean;
  /** Stable, content-free operator-facing reason. Never contains tenant or source identifiers. */
  readonly reason: string;
}

/**
 * Decides whether the given authority may authorize autonomous scheduling.
 *
 * Scheduling turns due commitments into dispatched Tasks with no human in the loop, so running
 * it against a placeholder or non-attributable authority would create work that can only ever
 * fail closed at publication. That is refused at startup instead.
 */
export function evaluateSchedulerConsentGate(authority: unknown): ConsentReadinessGate {
  if (authority === undefined || authority === null) {
    return { ready: false, reason: 'no Consent authority is wired' };
  }

  if (isUnavailableConsentAuthority(authority)) {
    return {
      ready: false,
      reason: 'only the deny-all placeholder Consent authority is wired',
    };
  }

  if (!isConsentFenceAuthority(authority)) {
    return {
      ready: false,
      reason: 'the wired Consent authority cannot issue a versioned authorization fence',
    };
  }

  return { ready: true, reason: 'versioned Consent authority is wired' };
}

/**
 * Rejects an authority that cannot satisfy the P0-C3B Consent contract.
 *
 * Used by the composition root so a misconfiguration is a startup error instead of a stream of
 * per-occurrence failures discovered in production traffic.
 */
export function requireCommitmentConsentAuthority(
  authority: ConsentAuthority | ConsentFenceAuthority | undefined,
  context: string,
): ConsentFenceAuthority {
  const gate = evaluateSchedulerConsentGate(authority);

  if (!gate.ready || authority === undefined) {
    throw toConsentDenied(
      undefined,
      `${context} requires a durable Consent authority: ${gate.reason}`,
    );
  }

  return authority as ConsentFenceAuthority;
}

/**
 * Builds the `ConsentPublicationGuard` the PostgreSQL commitment repository runs *inside* the
 * transaction that appends an Outcome.
 *
 * The repository's default guard denies every publication, so this factory is the only way to
 * enable Outcome publication, and it enables it only for the authority it is given. A denial or
 * an unreadable Consent store rejects the append and leaves the occurrence unpublished.
 *
 * Note: the durable adapter must later use the supplied `client` so the check is part of the
 * same transaction (row lock / snapshot). The current port takes the client positionally, so
 * wiring that is additive and does not change this call site.
 */
export function createCommitmentConsentPublicationGuard(
  authority: ConsentAuthority | ConsentFenceAuthority,
): ConsentPublicationGuard {
  return {
    async assertActive(_client: unknown, params: ConsentGuardParams): Promise<void> {
      try {
        await authority.assertActive(params.tenantId, params.sourceProfileId);
      } catch (error) {
        throw toConsentDenied(error, 'Source Consent is not active for this outcome');
      }
    },
  };
}

/** Structural mirror of the repository's guard parameters, kept explicit for readability. */
export interface ConsentGuardParams {
  readonly tenantId: Id;
  readonly sourceProfileId: string;
}
