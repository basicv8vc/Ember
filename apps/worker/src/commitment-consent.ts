import type { ConsentAuthority } from '@ember/connectors';
import {
  isConsentFenceAuthority,
  toConsentDenied,
  type ConsentFenceAuthority,
} from '@ember/execution';
import { isUnavailableConsentAuthority } from './commitment-source-reader.js';

/**
 * Single Worker-side seams for the Source Consent dependency.
 *
 * P0-C3B must not invent Consent persistence: `migrations/**`, `packages/postgres/**` and
 * `packages/contracts/**` belong to Lane C, and the Consent *contract* (`ConsentGrant`,
 * `ConsentAuthority.resolveGeneration`, the fence shape) is frozen by P0-C3C in `@ember/contracts`
 * and re-exported by `@ember/connectors`. What this module owns is the *wiring*, so that replacing
 * one object in the composition root simultaneously arms:
 *
 * 1. the pre-read versioned authorization fence used by `CommitmentOrchestrator`,
 * 2. the fence re-verification inside `CommitmentSourceReader` (pre- and post-read),
 * 3. the transaction-scoped publication guard the PostgreSQL repository already accepts,
 * 4. the startup gate that decides whether the Scheduler may run at all.
 *
 * The object wired in production is `fromResolvedGenerationConsent(store, { grants })` from
 * `@ember/execution`: a P0-C3C `resolveGeneration` authority (P0-C3D's durable store) adapted to
 * `ConsentFenceAuthority` without any gate changing. The deny-all placeholder remains only as the
 * fail-closed default, and the startup gate refuses to schedule against it.
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
 * The publication guard is no longer a Worker seam.
 *
 * P0-C3B used to build its own `ConsentPublicationGuard` here, calling `assertActive()` before the
 * Outcome INSERT. That guard could not see the publishing transaction, so a revocation committed
 * between its check and the INSERT could still slip through.
 *
 * P0-C3D (#84) replaced it with `PostgresConsentPublicationGuard` in `@ember/postgres`, which runs
 * on the append transaction's own client, locks the consent row with `SELECT … FOR UPDATE` and
 * compares `(grantId, version)`. The factory was deleted rather than adapted: keeping a
 * parallel guard that ignores its `client` argument would leave a way to describe a non-atomic
 * check as atomic. Publication denial is covered by
 * `tests/integration/p0c3d-consent-postgres.test.ts`, including the revocation races.
 */
