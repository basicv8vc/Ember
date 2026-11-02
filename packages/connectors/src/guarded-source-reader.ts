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
 * - Privacy-preserving audit logging with zero network calls asserted.
 */

import { createSourceAuditRecord } from './audit.js';
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
  type ConsentRegistry,
  type SourceAccessPolicy,
  type SourceAuditSink,
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
}

export class GuardedSourceReader implements SourceReader {
  private readonly reader: SourceReader;
  private readonly registry: ConsentRegistry;
  private readonly profiles: ReadonlyMap<string, SourceProfile>;
  private readonly policy: SourceAccessPolicy;
  private readonly auditSink?: SourceAuditSink;
  private readonly nowProvider: () => Date;

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
      operation: 'read_snapshot',
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
    if (
      !postGrant ||
      postGrant.status !== 'active' ||
      postGrant.revokedAt !== null ||
      (postGrant.expiresAt !== null && new Date(postGrant.expiresAt) <= postNow)
    ) {
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
