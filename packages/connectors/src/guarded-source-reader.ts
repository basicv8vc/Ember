/**
 * Guarded Source Reader wrapper for @ember/connectors.
 *
 * Implements the P0-C3C Security & Trust Boundary:
 * - Fail-closed Pre-Read consent and policy authorization gate (0 reader calls on deny).
 * - Untrusted provider exception sanitization (never leak raw error messages, stacks, or URLs).
 * - Rigorous validation of returned snapshots (bounds checking, digest verification, deep immutability).
 * - Post-Read double-check consent validation to eliminate mid-read revocation leaks.
 * - Privacy-preserving audit logging with zero network calls asserted.
 */

import { createSourceAuditRecord } from './audit.js';
import {
  createCancelledError,
  createInvalidArgumentError,
  createNotFoundError,
  createPolicyDeniedError,
  isDomainError,
} from './errors.js';
import { validateReaderReturnedSnapshot } from './sanitizer.js';
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

  async readSnapshot(
    sourceProfileId: string,
    context: TrustedSourceAccessContext,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot> {
    const now = this.nowProvider();

    // 1. Authoritative perimeter context validation
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
    if (signal?.aborted) {
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
    } catch (error) {
      const postNow = this.nowProvider();
      if (
        signal?.aborted ||
        (isDomainError(error) && error.code === 'CANCELLED') ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
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
        if (isDomainError(error) && error.code === 'CANCELLED') {
          throw error;
        }
        throw createCancelledError('Snapshot read was aborted during execution');
      }

      // Untrusted exception sanitization:
      // Never leak raw exception messages, stacks, URLs, or internal details from the inner reader.
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

    // 6. Enforce strict schema, bounds, and digest verification on returned snapshot
    let snapshot: SourceSnapshot;
    try {
      snapshot = validateReaderReturnedSnapshot(
        rawSnapshot,
        sourceProfileId,
        profile.maxItems,
        profile.maxPayloadBytes,
      );
    } catch (validationError) {
      const postNow = this.nowProvider();
      const denialCode =
        isDomainError(validationError) &&
        validationError.diagnostic?.includes('PAYLOAD_LIMIT_EXCEEDED')
          ? 'PAYLOAD_LIMIT_EXCEEDED'
          : 'UNTRUSTED_CONTENT_DETECTED';

      if (this.auditSink) {
        this.auditSink.record(
          createSourceAuditRecord({
            tenantId: context.tenantId,
            commitmentId: context.commitmentId,
            taskId: context.taskId,
            sourceProfileId,
            decision: 'DENIED',
            denialCode,
            now: postNow,
          }),
        );
      }
      throw validationError;
    }

    // 7. CHECK 2: Post-Read Consent Re-Verification (Double-Check Invariant)
    const postNow = this.nowProvider();
    if (signal?.aborted) {
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
