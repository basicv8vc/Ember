import type { ConsentReadGate } from '@ember/contracts';
import type { Id } from '@ember/domain';
import {
  isConsentFenceAuthority,
  toConsentDenied,
  type ConsentFenceAuthority,
} from '@ember/execution';
import type { ConsentDispatchFence, ConsentPublicationGuard } from '@ember/postgres';
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
  authority: ConsentReadGate | ConsentFenceAuthority | undefined,
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
 * Adapts a fence-capable authority to the PostgreSQL repository's transaction-scoped guard.
 *
 * Production uses `PostgresConsentPublicationGuard` instead: it reads and locks the consent row on
 * the repository's own connection, so the check is part of the publishing transaction. This adapter
 * exists for tests and for wiring an authority that is not DB-backed, and it deliberately performs
 * the comparison through the SAME methods the orchestrator uses (`authorizeFence` +
 * `assertFenceCurrent`), so no gate can be satisfied by a boolean verdict.
 *
 * A `null` fence is denied: an occurrence without a recorded generation cannot prove which consent
 * authorized its read.
 */
export function createCommitmentConsentPublicationGuard(
  authority: ConsentFenceAuthority,
): ConsentPublicationGuard {
  return {
    async authorizeFence(_client, params): Promise<ConsentDispatchFence> {
      try {
        const fence = await authority.authorizeFence(params.tenantId, params.sourceProfileId);

        return { grantId: fence.grantId, version: fence.grantVersion };
      } catch (error) {
        throw toConsentDenied(error, 'Source Consent does not authorize this dispatch');
      }
    },

    async assertFenceCurrent(_client, params): Promise<void> {
      if (params.fence === null) {
        throw toConsentDenied(undefined, 'Occurrence has no recorded consent generation fence');
      }

      try {
        const current = await authority.authorizeFence(params.tenantId, params.sourceProfileId);

        if (
          current.grantId !== params.fence.grantId ||
          current.grantVersion !== params.fence.version
        ) {
          throw toConsentDenied(
            undefined,
            'Source Consent was re-granted or revoked after this work was authorized',
          );
        }
      } catch (error) {
        throw toConsentDenied(error, 'Source Consent does not authorize this outcome');
      }
    },
  };
}

/** Structural mirror of the repository's guard parameters, kept explicit for readability. */
export interface ConsentGuardParams {
  readonly tenantId: Id;
  readonly sourceProfileId: string;
}
