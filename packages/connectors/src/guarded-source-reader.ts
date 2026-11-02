/**
 * Guarded Source Reader wrapper for @ember/connectors.
 *
 * Implements the P0-C3C Security & Trust Boundary:
 * - Fail-closed Pre-Read consent and policy authorization gate (0 reader calls on deny).
 * - Untrusted provider exception sanitization: no error property (`code`, `name`, `message`,
 *   `stack`, `diagnostic`) is ever read, and true caller cancellation is derived only from the
 *   trusted server-owned `AbortSignal`.
 * - Exception-safe validation of returned snapshots (bounds checking, digest verification, deep
 *   immutability): throwing getters and hostile Proxies become fixed safe errors.
 * - Post-Read double-check consent validation to eliminate mid-read revocation leaks.
 * - GENERATION BINDING (P0-C3C CTO round 2): the grant the perimeter evaluates policy against must
 *   BE the fenced generation (`grantId` AND `version`), before dispatch and again after the read, so a
 *   fence can never rubber-stamp permissions taken from a different consent generation.
 * - Privacy-preserving audit logging with zero network calls asserted.
 */

import { createSourceAuditRecord, SAFE_DENIAL_DESCRIPTIONS } from './audit.js';
import {
  deriveConsentStatus,
  isConsentAuthority,
  SOURCE_READ_OPERATION,
  SOURCE_READ_SCOPE,
  validateConsentAuthorizationFence,
  validateConsentGenerationBinding,
  type ConsentFenceValidation,
  type ConsentGenerationBindingValidation,
} from './consent.js';
import {
  createCancelledError,
  createInvalidArgumentError,
  createNotFoundError,
  createPolicyDeniedError,
} from './errors.js';
import {
  inspectReaderReturnedSnapshot,
  SAFE_SNAPSHOT_REJECTION_DIAGNOSTICS,
  type ReaderSnapshotInspection,
  type ReaderSnapshotRejectionCode,
} from './sanitizer.js';
import { evaluateSourceAccess } from './source-policy.js';
import {
  SOURCE_PROFILE_ID_REGEX,
  type AuthorizedConsentGeneration,
  type ConsentAuthority,
  type ConsentGrant,
  type ConsentRegistry,
  type SourceAccessPolicy,
  type SourceAuditSink,
  type SourceDenialCode,
  type SourceProfile,
  type SourceReader,
  type SourceSnapshot,
  type TrustedSourceAccessContext,
} from './types.js';

export interface GuardedSourceReaderOptions {
  readonly reader: SourceReader;
  readonly registry: ConsentRegistry;
  readonly profiles: ReadonlyMap<string, SourceProfile>;
  readonly policy: SourceAccessPolicy;
  readonly auditSink?: SourceAuditSink;
  readonly nowProvider?: () => Date;
  /**
   * Optional authoritative generation source used to verify authorization fences. Defaults to the
   * registry when it implements `ConsentAuthority` (the fake registry does). Production wiring MUST
   * pass the durable consent repository here.
   */
  readonly authority?: ConsentAuthority;
  /**
   * When true, a read without an authorization fence is denied. Default false to preserve the
   * pre-fence contract; production should enable it once the scheduler always attaches a fence.
   */
  readonly requireAuthorizationFence?: boolean;
}

const MISSING_FENCE: ConsentFenceValidation = Object.freeze({
  valid: false,
  code: 'CONSENT_FENCE_MISSING',
  denialCode: 'CONSENT_FENCE_MISSING',
});

const NO_FENCE_REQUIRED: ConsentFenceValidation = Object.freeze({
  valid: true,
  code: 'VALID',
  denialCode: null,
});

export class GuardedSourceReader implements SourceReader {
  private readonly reader: SourceReader;
  private readonly registry: ConsentRegistry;
  private readonly profiles: ReadonlyMap<string, SourceProfile>;
  private readonly policy: SourceAccessPolicy;
  private readonly auditSink?: SourceAuditSink;
  private readonly nowProvider: () => Date;
  private readonly authority: ConsentAuthority | null;
  private readonly requireAuthorizationFence: boolean;

  constructor(options: GuardedSourceReaderOptions) {
    if (!options || !options.reader || !options.registry || !options.policy || !options.profiles) {
      throw createInvalidArgumentError(
        'GuardedSourceReader requires reader, registry, profiles map, and policy',
      );
    }
    this.reader = options.reader;
    this.registry = options.registry;
    this.profiles = options.profiles;
    this.policy = options.policy;
    this.auditSink = options.auditSink;
    this.nowProvider = options.nowProvider ?? (() => new Date());
    this.authority =
      options.authority ?? (isConsentAuthority(options.registry) ? options.registry : null);
    this.requireAuthorizationFence = options.requireAuthorizationFence === true;
  }

  /**
   * Resolves the authoritative consent generation for the caller's lineage.
   * Fails closed: an unavailable or throwing authority yields `null` (never a grant).
   */
  private async resolveAuthoritativeGeneration(
    tenantId: string,
    sourceProfileId: string,
    now: Date,
  ): Promise<AuthorizedConsentGeneration | null> {
    if (this.authority === null) {
      return null;
    }
    try {
      const generation = await this.authority.resolveGeneration(tenantId, sourceProfileId, now);
      if (generation === null || typeof generation !== 'object') {
        return null;
      }
      return generation;
    } catch {
      return null;
    }
  }

  /**
   * Verifies the caller's authorization fence against AUTHORITATIVE consent state.
   *
   * A fence is never proof of authorization on its own: the referenced `grantId` + `grantVersion`
   * must still be the current, active generation for the bound tenant and source profile. Optional
   * fences are therefore only skipped when the caller supplied none and the fence is not required.
   */
  private async verifyAuthorizationFence(
    sourceProfileId: string,
    context: TrustedSourceAccessContext,
    now: Date,
  ): Promise<ConsentFenceValidation> {
    const fence = context.authorizationFence;
    if (fence === undefined || fence === null) {
      return this.requireAuthorizationFence ? MISSING_FENCE : NO_FENCE_REQUIRED;
    }
    if (this.authority === null) {
      // Unverifiable fence: fail closed rather than trusting caller-supplied state.
      return MISSING_FENCE;
    }

    const authoritative = await this.resolveAuthoritativeGeneration(
      context.tenantId,
      sourceProfileId,
      now,
    );

    return validateConsentAuthorizationFence({
      fence,
      tenantId: context.tenantId,
      sourceProfileId,
      authoritative,
      now,
    });
  }

  /**
   * Verifies the GENERATION BINDING invariant: the grant just read from the registry (and therefore
   * the exact record whose `allowedOperations` / `scopes` policy was evaluated against) must be the
   * generation named by the caller's authorization fence.
   *
   * A verified fence plus a divergent registry read is a split brain: the fence would attest G2 while
   * the read is authorized by G1's terms. Both directions are fatal, so any mismatch denies.
   */
  private verifyGenerationBinding(
    sourceProfileId: string,
    context: TrustedSourceAccessContext,
    grant: ConsentGrant | null,
  ): ConsentGenerationBindingValidation {
    return validateConsentGenerationBinding({
      grant,
      fence: context.authorizationFence,
      tenantId: context.tenantId,
      sourceProfileId,
    });
  }

  /** Records a DENIED audit entry with a static reason and throws the matching safe policy denial. */
  private denyRead(
    sourceProfileId: string,
    context: TrustedSourceAccessContext,
    now: Date,
    denialCode: SourceDenialCode,
  ): never {
    if (this.auditSink) {
      this.auditSink.record(
        createSourceAuditRecord({
          tenantId: context.tenantId,
          commitmentId: context.commitmentId,
          taskId: context.taskId,
          sourceProfileId,
          decision: 'DENIED',
          denialCode,
          now,
        }),
      );
    }
    throw createPolicyDeniedError(SAFE_DENIAL_DESCRIPTIONS[denialCode], denialCode);
  }

  private validateContext(context: TrustedSourceAccessContext): void {
    if (!context || typeof context !== 'object') {
      throw createInvalidArgumentError('TrustedSourceAccessContext must be a valid object');
    }
    if (typeof context.tenantId !== 'string' || context.tenantId.trim() === '') {
      throw createInvalidArgumentError('TrustedSourceAccessContext missing valid tenantId');
    }
    if (typeof context.commitmentId !== 'string' || context.commitmentId.trim() === '') {
      throw createInvalidArgumentError('TrustedSourceAccessContext missing valid commitmentId');
    }
    if (typeof context.taskId !== 'string' || context.taskId.trim() === '') {
      throw createInvalidArgumentError('TrustedSourceAccessContext missing valid taskId');
    }
    if (typeof context.runId !== 'string' || context.runId.trim() === '') {
      throw createInvalidArgumentError('TrustedSourceAccessContext missing valid runId');
    }
    if (
      typeof context.leaseEpoch !== 'number' ||
      !Number.isInteger(context.leaseEpoch) ||
      context.leaseEpoch < 0
    ) {
      throw createInvalidArgumentError(
        'TrustedSourceAccessContext missing non-negative integer leaseEpoch',
      );
    }
    if (
      typeof context.authorizedAt !== 'string' ||
      context.authorizedAt.trim() === '' ||
      Number.isNaN(Date.parse(context.authorizedAt))
    ) {
      throw createInvalidArgumentError(
        'TrustedSourceAccessContext missing valid RFC 3339 authorizedAt timestamp',
      );
    }
  }

  private validateSourceProfileId(sourceProfileId: string): void {
    if (typeof sourceProfileId !== 'string' || !SOURCE_PROFILE_ID_REGEX.test(sourceProfileId)) {
      throw createInvalidArgumentError(
        'sourceProfileId must be an opaque identifier matching ^[a-z0-9][a-z0-9._-]{2,63}$; URLs or path separators are strictly forbidden',
      );
    }
  }

  /**
   * Inspects the untrusted snapshot returned by the inner reader and either returns a trusted,
   * deeply frozen snapshot or throws a fixed safe `POLICY_DENIED` error.
   *
   * Nothing supplied by the reader is trusted here. Hostile getters and Proxy traps may throw
   * while the object is inspected, so the thrown value is never read. The rejection code comes
   * exclusively from the trusted {@link ReaderSnapshotInspection} result, so a spoofed
   * `DomainError` diagnostic cannot influence the error text or the audit trail.
   */
  private inspectSnapshotOrDeny(
    rawSnapshot: unknown,
    sourceProfileId: string,
    profile: SourceProfile,
    context: TrustedSourceAccessContext,
  ): SourceSnapshot {
    let inspection: ReaderSnapshotInspection | null = null;
    try {
      inspection = inspectReaderReturnedSnapshot(
        rawSnapshot,
        sourceProfileId,
        profile.maxItems,
        profile.maxPayloadBytes,
      );
    } catch {
      // Defensive: the inspector is contractually non-throwing. If a hostile getter somehow
      // escapes it, the thrown value is still never bound or inspected.
      inspection = null;
    }

    if (inspection !== null && inspection.ok) {
      return inspection.snapshot;
    }

    const denialCode: ReaderSnapshotRejectionCode =
      inspection === null ? 'UNTRUSTED_CONTENT_DETECTED' : inspection.denialCode;

    if (this.auditSink) {
      this.auditSink.record(
        createSourceAuditRecord({
          tenantId: context.tenantId,
          commitmentId: context.commitmentId,
          taskId: context.taskId,
          sourceProfileId,
          decision: 'DENIED',
          denialCode,
          now: this.nowProvider(),
        }),
      );
    }

    throw createPolicyDeniedError(SAFE_SNAPSHOT_REJECTION_DIAGNOSTICS[denialCode], denialCode);
  }

  async readSnapshot(
    sourceProfileId: string,
    context: TrustedSourceAccessContext,
    signal: AbortSignal,
  ): Promise<SourceSnapshot> {
    const now = this.nowProvider();

    // 1. Authoritative perimeter context validation
    if (!signal) {
      throw createInvalidArgumentError('AbortSignal is required');
    }
    this.validateContext(context);
    this.validateSourceProfileId(sourceProfileId);

    // 2. Profile resolution & tenant isolation check
    const profile = this.profiles.get(sourceProfileId) ?? null;
    if (!profile || profile.tenantId !== context.tenantId) {
      // Uniform Agnosticism: return NOT_FOUND whether non-existent or other tenant
      if (this.auditSink) {
        this.auditSink.record(
          createSourceAuditRecord({
            tenantId: context.tenantId,
            commitmentId: context.commitmentId,
            taskId: context.taskId,
            sourceProfileId,
            decision: 'DENIED',
            denialCode: 'SOURCE_PROFILE_NOT_FOUND',
            now,
          }),
        );
      }
      throw createNotFoundError('Source profile not found');
    }

    // 3. CHECK 1: Pre-Read Consent & Policy Evaluation Gate (0 reader calls on deny)
    const grant = this.registry.get(context.tenantId, sourceProfileId, now);
    const decision = evaluateSourceAccess({
      profile,
      context,
      grant,
      policy: this.policy,
      operation: SOURCE_READ_OPERATION,
      requiredScopes: [SOURCE_READ_SCOPE],
      now,
    });

    if (!decision.allowed) {
      if (this.auditSink) {
        this.auditSink.record(
          createSourceAuditRecord({
            tenantId: context.tenantId,
            commitmentId: context.commitmentId,
            taskId: context.taskId,
            sourceProfileId,
            decision: 'DENIED',
            denialCode: decision.denialCode,
            now,
          }),
        );
      }
      // Fail closed immediately. The underlying reader is NEVER invoked.
      throw createPolicyDeniedError(decision.reason, decision.denialCode);
    }

    // 3.5 Authorization fence verification against AUTHORITATIVE consent state.
    // A worker-supplied fence is untrusted input: the referenced generation must still be the
    // current, active generation for this tenant and source profile.
    if (context.authorizationFence !== undefined || this.requireAuthorizationFence) {
      const fenceResult = await this.verifyAuthorizationFence(sourceProfileId, context, now);
      if (!fenceResult.valid) {
        const denialCode: SourceDenialCode = fenceResult.denialCode ?? 'CONSENT_FENCE_INVALID';
        this.denyRead(sourceProfileId, context, now, denialCode);
      }

      // 3.6 GENERATION BINDING: the grant whose terms policy just evaluated must BE the fenced
      // generation. Without this, a fence for G2 could authorize a read whose scopes came from G1.
      const binding = this.verifyGenerationBinding(sourceProfileId, context, grant);
      if (!binding.consistent) {
        const denialCode: SourceDenialCode = binding.denialCode ?? 'CONSENT_GENERATION_MISMATCH';
        this.denyRead(sourceProfileId, context, now, denialCode);
      }
    }

    // 4. Cancellation check prior to dispatch
    if (signal.aborted) {
      if (this.auditSink) {
        this.auditSink.record(
          createSourceAuditRecord({
            tenantId: context.tenantId,
            commitmentId: context.commitmentId,
            taskId: context.taskId,
            sourceProfileId,
            decision: 'DENIED',
            denialCode: 'READ_ABORTED',
            now,
          }),
        );
      }
      throw createCancelledError('Snapshot read was aborted prior to invocation');
    }

    // 5. Execute read on wrapped reader with untrusted exception sanitization
    let rawSnapshot: unknown;
    try {
      rawSnapshot = await this.reader.readSnapshot(sourceProfileId, context, signal);
    } catch {
      const postNow = this.nowProvider();
      // CTO Security Hardening Requirement 2:
      // Do NOT touch error.code, error.name, error.message, error.diagnostic, or ANY property on error!
      // An adversarial Error Proxy or getter can throw or spoof state.
      // ONLY the authoritative, server-owned signal.aborted decides true caller cancellation.
      if (signal.aborted) {
        if (this.auditSink) {
          this.auditSink.record(
            createSourceAuditRecord({
              tenantId: context.tenantId,
              commitmentId: context.commitmentId,
              taskId: context.taskId,
              sourceProfileId,
              decision: 'DENIED',
              denialCode: 'READ_ABORTED',
              now: postNow,
            }),
          );
        }
        throw createCancelledError('Snapshot read was aborted during execution');
      }

      // If signal was NOT aborted, this was a provider execution failure.
      // Record audit and throw safe, sanitized POLICY_DENIED error without inspecting error properties.
      if (this.auditSink) {
        this.auditSink.record(
          createSourceAuditRecord({
            tenantId: context.tenantId,
            commitmentId: context.commitmentId,
            taskId: context.taskId,
            sourceProfileId,
            decision: 'DENIED',
            denialCode: 'POLICY_DENIED',
            now: postNow,
          }),
        );
      }
      throw createPolicyDeniedError(
        'Source reader execution failed; untrusted exception sanitized',
        'POLICY_DENIED',
      );
    }

    // 6. Enforce strict schema, bounds, and digest verification on the returned snapshot.
    // The snapshot is UNTRUSTED: reading its properties can execute hostile getter or Proxy code.
    const snapshot = this.inspectSnapshotOrDeny(rawSnapshot, sourceProfileId, profile, context);

    // 7. CHECK 2: Post-Read Consent Re-Verification (Double-Check Invariant)
    const postNow = this.nowProvider();
    if (signal.aborted) {
      if (this.auditSink) {
        this.auditSink.record(
          createSourceAuditRecord({
            tenantId: context.tenantId,
            commitmentId: context.commitmentId,
            taskId: context.taskId,
            sourceProfileId,
            decision: 'DENIED',
            denialCode: 'READ_ABORTED',
            now: postNow,
          }),
        );
      }
      throw createCancelledError('Snapshot read was aborted during execution');
    }

    // Re-verify that the consent grant was not revoked or expired while the read was running
    const postGrant = this.registry.get(context.tenantId, sourceProfileId, postNow);
    const postStatus = postGrant === null ? null : deriveConsentStatus(postGrant, postNow);

    // Re-verify the authorization generation too: a revoke followed by a re-grant during the read
    // must still discard this snapshot, because the fenced generation is no longer authoritative.
    const postFence = await this.verifyAuthorizationFence(sourceProfileId, context, postNow);

    // Re-verify the GENERATION BINDING as well: if the registry and the fence diverge while the read
    // was in flight, the snapshot was authorized by terms the fence never described. Discard it.
    const postBinding = this.verifyGenerationBinding(sourceProfileId, context, postGrant);

    if (postStatus !== 'active' || !postFence.valid || !postBinding.consistent) {
      // Consent was revoked or expired mid-read! Discard the snapshot immediately.
      if (this.auditSink) {
        this.auditSink.record(
          createSourceAuditRecord({
            tenantId: context.tenantId,
            commitmentId: context.commitmentId,
            taskId: context.taskId,
            sourceProfileId,
            decision: 'DENIED',
            denialCode: 'REVOKED_DURING_EXECUTION',
            now: postNow,
          }),
        );
      }
      throw createPolicyDeniedError(
        'Consent was revoked or expired during snapshot read; snapshot discarded',
        'REVOKED_DURING_EXECUTION',
      );
    }

    // 8. Audit success and return deeply frozen snapshot
    if (this.auditSink) {
      this.auditSink.record(
        createSourceAuditRecord({
          tenantId: context.tenantId,
          commitmentId: context.commitmentId,
          taskId: context.taskId,
          sourceProfileId,
          decision: 'ALLOWED',
          now: postNow,
        }),
      );
    }

    return snapshot;
  }
}
