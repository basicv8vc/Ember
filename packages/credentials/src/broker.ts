/**
 * Control-plane Credential Broker for @ember/credentials.
 *
 * Implements Sections 1 & 4 of P0-C1C:
 * - Dual verification boundaries:
 *   1) Management plane: verified AuthContext (tenantId, principalId, policyVersion)
 *   2) Execution plane: LeasedRun verified via injected authoritative RunExecutionContextReader
 * - Re-authenticates leaseEpoch, tenantId, runId, attempt, and expiry against the database row.
 * - Rejects forged caller identities, missing readers, or text-based self-attestation.
 * - Enforces uniform agnosticism (NOT_FOUND) for cross-tenant access.
 * - Zero network calls: returns strictly synthetic, redacted SIMULATED results.
 */

import type { RunExecutionContext, RunExecutionContextReader } from '@ember/contracts';
import { DomainError, isDomainError, type AuthContext, type LeasedRun } from '@ember/domain';
import { createAuditRecord } from './audit.js';
import { evaluateEgressRequest } from './egress-policy.js';
import {
  createInvalidArgumentError,
  createNotFoundError,
  createPolicyDeniedError,
  createStaleLeaseError,
  createUnauthenticatedError,
} from './errors.js';
import type { InMemoryCredentialRegistry } from './registry.js';
import type {
  AuditSink,
  CredentialMetadata,
  EgressDenialCode,
  EgressPolicy,
  EgressRequest,
  EgressRule,
  RegisterCredentialOptions,
  RotateCredentialOptions,
  SimulatedProxyResult,
} from './types.js';

export interface CredentialBrokerOptions {
  readonly registry: InMemoryCredentialRegistry;
  readonly policy: EgressPolicy;
  readonly auditSink?: AuditSink;
  readonly trustedWorkerId?: string;
}

export class CredentialBroker {
  readonly registry: InMemoryCredentialRegistry;
  readonly policy: EgressPolicy;
  readonly auditSink?: AuditSink;
  readonly trustedWorkerId?: string;

  constructor(options: CredentialBrokerOptions) {
    if (!options || !options.registry || !options.policy) {
      throw createInvalidArgumentError('CredentialBroker requires registry and policy');
    }
    this.assertValidPolicy(options.policy);
    this.registry = options.registry;
    this.policy = options.policy;
    this.auditSink = options.auditSink;
    if (options.trustedWorkerId !== undefined) {
      if (typeof options.trustedWorkerId !== 'string' || options.trustedWorkerId.trim() === '') {
        throw createInvalidArgumentError(
          'trustedWorkerId must be a non-empty string when provided',
        );
      }
      this.trustedWorkerId = options.trustedWorkerId.trim();
    }
  }

  private assertValidPolicy(policy: EgressPolicy): void {
    if (!policy || !Array.isArray(policy.rules)) {
      throw createInvalidArgumentError('EgressPolicy must define an array of rules');
    }
    const seenRuleIds = new Set<string>();
    const rules: readonly EgressRule[] = policy.rules;
    for (const rule of rules) {
      if (!rule || !rule.ruleId || typeof rule.ruleId !== 'string' || rule.ruleId.trim() === '') {
        throw createInvalidArgumentError('Every rule in EgressPolicy must have a non-empty ruleId');
      }
      const normalized = rule.ruleId.trim();
      if (seenRuleIds.has(normalized)) {
        throw createInvalidArgumentError(
          `Duplicate ruleId '${normalized}' detected in egress policy; rule IDs must be unique to prevent rule shadowing and scope bypass`,
        );
      }
      seenRuleIds.add(normalized);
    }
  }

  // ---------------------------------------------------------------------------
  // Management API (verified AuthContext required)
  // ---------------------------------------------------------------------------

  async registerCredential(
    ctx: AuthContext,
    options: RegisterCredentialOptions,
    now: Date = new Date(),
  ): Promise<CredentialMetadata> {
    this.assertValidAuthContext(ctx);
    return Promise.resolve(this.registry.register(ctx, options, now));
  }

  async getCredentialMetadata(
    ctx: AuthContext,
    credentialRef: string,
    now: Date = new Date(),
  ): Promise<CredentialMetadata> {
    this.assertValidAuthContext(ctx);
    return Promise.resolve(this.registry.get(ctx, credentialRef, now));
  }

  async rotateCredential(
    ctx: AuthContext,
    credentialRef: string,
    options: RotateCredentialOptions = {},
    now: Date = new Date(),
  ): Promise<CredentialMetadata> {
    this.assertValidAuthContext(ctx);
    return Promise.resolve(this.registry.rotate(ctx, credentialRef, options, now));
  }

  async revokeCredential(
    ctx: AuthContext,
    credentialRef: string,
    now: Date = new Date(),
  ): Promise<CredentialMetadata> {
    this.assertValidAuthContext(ctx);
    return Promise.resolve(this.registry.revoke(ctx, credentialRef, now));
  }

  async listCredentials(
    ctx: AuthContext,
    now: Date = new Date(),
  ): Promise<readonly CredentialMetadata[]> {
    this.assertValidAuthContext(ctx);
    return Promise.resolve(this.registry.list(ctx, now));
  }

  // ---------------------------------------------------------------------------
  // Execution API (authoritative RunExecutionContextReader re-verification required)
  // ---------------------------------------------------------------------------

  /**
   * Execute an egress operation with an opaque credential reference.
   *
   * Verifies the lease claim against the authoritative RunExecutionContextReader,
   * checks credential validity and scopes, evaluates the default-deny egress policy,
   * and returns a synthetic SIMULATED proxy result without any network side-effects.
   */
  async executeWithCredential(
    lease: LeasedRun,
    credentialRef: string,
    egressRequest: EgressRequest,
    contextReader: RunExecutionContextReader,
    now: Date = new Date(),
  ): Promise<SimulatedProxyResult> {
    // 1. Fail closed if trusted worker identity is not configured on broker
    if (
      !this.trustedWorkerId ||
      typeof this.trustedWorkerId !== 'string' ||
      this.trustedWorkerId.trim() === ''
    ) {
      throw createUnauthenticatedError('Trusted worker identity is required for execution');
    }

    // 2. Validate lease input structure
    this.assertValidLease(lease);

    // 3. Validate context reader presence
    if (!contextReader || typeof contextReader.read !== 'function') {
      throw createUnauthenticatedError('Injected RunExecutionContextReader is required');
    }

    // 4. Authoritative verification of the claimed lease
    let context: RunExecutionContext;
    try {
      context = await contextReader.read(lease, now);
    } catch (err) {
      if (isDomainError(err)) {
        throw err;
      }
      throw new DomainError(
        'DB_UNAVAILABLE',
        'Context reader failed during authoritative verification',
      );
    }

    if (!context) {
      throw createNotFoundError('Execution context not found for leased run');
    }

    // 5. Authoritative operational worker identity verification (fail closed immediately)
    if (
      !context.workerId ||
      typeof context.workerId !== 'string' ||
      context.workerId.trim() === '' ||
      context.workerId !== this.trustedWorkerId
    ) {
      throw createUnauthenticatedError(
        'Operational worker identity mismatch with authoritative execution context',
      );
    }

    // 6. Verify tenant-scoped policy binding against authoritative context (fail-closed if missing or mismatched)
    if (
      this.policy.tenantId !== undefined &&
      (!context.tenantId ||
        typeof context.tenantId !== 'string' ||
        context.tenantId.trim() === '' ||
        this.policy.tenantId !== context.tenantId)
    ) {
      this.recordDenialAudit({
        tenantId: context.tenantId || '[MISSING_TENANT]',
        taskId: context.taskId,
        runId: context.runId,
        credentialRef,
        credentialVersion: 0,
        provider: '[UNVERIFIED_PROVIDER]',
        operation: '[UNVERIFIED_OPERATION]',
        url: egressRequest.url,
        method: egressRequest.method,
        reason: 'Policy tenant mismatch: policy is bound to a different tenant',
        code: 'NO_MATCHING_RULE',
        now,
      });
      throw createPolicyDeniedError(
        'Policy tenant mismatch: policy is bound to a different tenant',
        'NO_MATCHING_RULE',
      );
    }

    // 7. Verify context invariants against the caller lease
    if (context.tenantId !== lease.tenantId) {
      throw createStaleLeaseError(
        'Claimed tenantId does not match authoritative execution context',
      );
    }
    if (context.taskId !== lease.taskId) {
      throw createStaleLeaseError('Claimed taskId does not match authoritative execution context');
    }
    if (context.runId !== lease.runId) {
      throw createStaleLeaseError('Claimed runId does not match authoritative execution context');
    }
    if (context.attempt !== lease.attempt) {
      throw createStaleLeaseError('Claimed attempt does not match authoritative execution context');
    }
    if (context.leaseEpoch !== lease.leaseEpoch) {
      throw createStaleLeaseError(
        'Claimed leaseEpoch does not match authoritative execution context',
      );
    }

    // 8. Check lease expiry
    const leaseExpiryMs = new Date(lease.leaseExpiresAt).getTime();
    if (Number.isNaN(leaseExpiryMs) || now.getTime() >= leaseExpiryMs) {
      throw createStaleLeaseError('Leased run claim has expired');
    }

    // Note: context.workerId is purely operational execution identity, never end-user identity.

    // 9. Tenant-isolated credential lookup (Uniform agnosticism: returns NOT_FOUND if foreign)
    const credential = this.registry.getInternal(context.tenantId, credentialRef, now);
    if (!credential) {
      // Audit denial: do not echo unverified provider or operation strings
      this.recordDenialAudit({
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        credentialRef,
        credentialVersion: 0,
        provider: '[UNVERIFIED_PROVIDER]',
        operation: '[UNVERIFIED_OPERATION]',
        url: egressRequest.url,
        method: egressRequest.method,
        reason: 'Credential not found in tenant',
        code: 'NO_MATCHING_RULE',
        now,
      });
      throw createNotFoundError('Credential not found in this tenant');
    }

    // 10. Check credential status
    if (credential.status === 'revoked') {
      this.recordDenialAudit({
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        credentialRef,
        credentialVersion: credential.version,
        provider: credential.provider,
        operation: '[UNVERIFIED_OPERATION]',
        url: egressRequest.url,
        method: egressRequest.method,
        reason: 'Credential has been revoked',
        code: 'NO_MATCHING_RULE',
        now,
      });
      throw createPolicyDeniedError('Credential has been revoked');
    }

    if (credential.status === 'expired') {
      this.recordDenialAudit({
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        credentialRef,
        credentialVersion: credential.version,
        provider: credential.provider,
        operation: '[UNVERIFIED_OPERATION]',
        url: egressRequest.url,
        method: egressRequest.method,
        reason: 'Credential has expired',
        code: 'NO_MATCHING_RULE',
        now,
      });
      throw createPolicyDeniedError('Credential has expired');
    }

    // 11. Provider alignment
    if (credential.provider !== egressRequest.provider) {
      this.recordDenialAudit({
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        credentialRef,
        credentialVersion: credential.version,
        provider: '[UNVERIFIED_PROVIDER]',
        operation: '[UNVERIFIED_OPERATION]',
        url: egressRequest.url,
        method: egressRequest.method,
        reason: 'Credential provider mismatch',
        code: 'NO_MATCHING_RULE',
        now,
      });
      throw createPolicyDeniedError('Credential provider mismatch', 'NO_MATCHING_RULE');
    }

    // 12. Evaluate Egress Policy against request with tenant scoping
    const egressDecision = evaluateEgressRequest(this.policy, egressRequest, context.tenantId);
    if (!egressDecision.allowed) {
      this.recordDenialAudit({
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        credentialRef,
        credentialVersion: credential.version,
        provider: this.policy.rules.some((r) => r.provider === credential.provider)
          ? credential.provider
          : '[UNVERIFIED_PROVIDER]',
        operation: '[UNVERIFIED_OPERATION]',
        url: egressRequest.url,
        method: egressRequest.method,
        reason: egressDecision.reason,
        code: egressDecision.denialCode,
        now,
      });
      throw createPolicyDeniedError(
        'Egress request denied by security policy',
        egressDecision.denialCode,
      );
    }

    // 13. Server-side rule.requiredScopes verification against credential.scopes
    const matchedRules = this.policy.rules.filter((r) => r.ruleId === egressDecision.matchedRuleId);
    if (matchedRules.length !== 1) {
      this.recordDenialAudit({
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        credentialRef,
        credentialVersion: credential.version,
        provider: '[UNVERIFIED_PROVIDER]',
        operation: '[UNVERIFIED_OPERATION]',
        url: egressRequest.url,
        method: egressRequest.method,
        reason: 'No matching egress rule found',
        code: 'NO_MATCHING_RULE',
        now,
      });
      throw createPolicyDeniedError('No matching egress rule found', 'NO_MATCHING_RULE');
    }
    const matchedRule = matchedRules[0]!;

    // Verify credential has all scopes required by the server-side egress rule
    const credScopeSet = new Set<string>(credential.scopes);
    const missingInCredential = matchedRule.requiredScopes.filter((s) => !credScopeSet.has(s));
    if (missingInCredential.length > 0) {
      this.recordDenialAudit({
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
        credentialRef,
        credentialVersion: credential.version,
        provider: matchedRule.provider,
        operation: egressDecision.operation,
        url: egressRequest.url,
        method: egressRequest.method,
        reason: 'Required scopes are not satisfied by credential',
        code: 'SCOPE_MISMATCH',
        now,
      });
      throw createPolicyDeniedError(
        'Credential scopes do not satisfy required rule scopes',
        'SCOPE_MISMATCH',
      );
    }

    // Verify caller cannot bypass via missing, empty, or forged requestedScopes
    if (egressRequest.requestedScopes !== undefined) {
      if (egressRequest.requestedScopes.length === 0) {
        if (matchedRule.requiredScopes.length > 0) {
          this.recordDenialAudit({
            tenantId: context.tenantId,
            taskId: context.taskId,
            runId: context.runId,
            credentialRef,
            credentialVersion: credential.version,
            provider: egressRequest.provider,
            operation: egressRequest.operation,
            url: egressRequest.url,
            method: egressRequest.method,
            reason: 'Empty requested scopes cannot satisfy required rule scopes',
            code: 'SCOPE_MISMATCH',
            now,
          });
          throw createPolicyDeniedError(
            'Empty requested scopes cannot satisfy required rule scopes',
            'SCOPE_MISMATCH',
          );
        }
      } else {
        const ungranted = egressRequest.requestedScopes.filter((s) => !credScopeSet.has(s));
        if (ungranted.length > 0) {
          this.recordDenialAudit({
            tenantId: context.tenantId,
            taskId: context.taskId,
            runId: context.runId,
            credentialRef,
            credentialVersion: credential.version,
            provider: egressRequest.provider,
            operation: egressRequest.operation,
            url: egressRequest.url,
            method: egressRequest.method,
            reason: 'Requested scopes exceed credential scopes',
            code: 'SCOPE_MISMATCH',
            now,
          });
          throw createPolicyDeniedError(
            'Requested scopes exceed credential scopes',
            'SCOPE_MISMATCH',
          );
        }

        const requestedSet = new Set<string>(egressRequest.requestedScopes);
        const missingInRequested = matchedRule.requiredScopes.filter((s) => !requestedSet.has(s));
        if (missingInRequested.length > 0) {
          this.recordDenialAudit({
            tenantId: context.tenantId,
            taskId: context.taskId,
            runId: context.runId,
            credentialRef,
            credentialVersion: credential.version,
            provider: egressRequest.provider,
            operation: egressRequest.operation,
            url: egressRequest.url,
            method: egressRequest.method,
            reason: 'Requested scopes do not satisfy required rule scopes',
            code: 'SCOPE_MISMATCH',
            now,
          });
          throw createPolicyDeniedError(
            'Requested scopes do not satisfy required rule scopes',
            'SCOPE_MISMATCH',
          );
        }
      }
    }

    // 14. Record approved audit record (networkCallsMade: 0 guaranteed)
    const auditRecord = createAuditRecord({
      tenantId: context.tenantId,
      taskId: context.taskId,
      runId: context.runId,
      callerType: 'execution',
      provider: egressRequest.provider,
      operation: egressRequest.operation,
      operationKind: 'read',
      credentialRef: credential.credentialRef,
      credentialVersion: credential.version,
      targetUrlOrOrigin: egressRequest.url,
      method: egressRequest.method,
      decision: 'ALLOWED',
      now,
    });

    if (this.auditSink) {
      this.auditSink.record(auditRecord);
    }

    // 15. Return synthetic, redacted SIMULATED result. No network socket or HTTP call is made.
    return Object.freeze({
      status: 'SIMULATED',
      allowed: true,
      connector: egressRequest.provider,
      operation: egressRequest.operation,
      timestamp: now.toISOString(),
      executionContext: Object.freeze({
        tenantId: context.tenantId,
        taskId: context.taskId,
        runId: context.runId,
      }),
      egress: Object.freeze({
        sanitizedUrl: egressDecision.sanitizedUrl,
        method: egressRequest.method,
        matchedRuleId: egressDecision.matchedRuleId,
      }),
      auditId: auditRecord.auditId,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal Validators and Helpers
  // ---------------------------------------------------------------------------

  /**
   * CRITICAL PERIMETER TRUST BOUNDARY (RFC v0.2 ADR-005):
   * AuthContext is authoritative perimeter data injected EXCLUSIVELY by the trusted API gateway
   * after upstream mTLS or validated session verification.
   * Untrusted caller runtimes or agent sandboxes cannot synthesize or modify AuthContext.
   */
  private assertValidAuthContext(ctx: AuthContext): void {
    if (!ctx || typeof ctx !== 'object') {
      throw createUnauthenticatedError('AuthContext is required');
    }
    if (!ctx.tenantId || typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
      throw createUnauthenticatedError('Valid tenantId is required in AuthContext');
    }
    if (!ctx.principalId || typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
      throw createUnauthenticatedError('Valid principalId is required in AuthContext');
    }
    if (
      typeof ctx.policyVersion !== 'number' ||
      !Number.isSafeInteger(ctx.policyVersion) ||
      ctx.policyVersion < 0
    ) {
      throw createUnauthenticatedError('Valid policyVersion is required in AuthContext');
    }
    // Strict tenant-scoped policy binding (fail-closed if missing or mismatched)
    if (
      this.policy.tenantId !== undefined &&
      (!ctx.tenantId ||
        typeof ctx.tenantId !== 'string' ||
        ctx.tenantId.trim() === '' ||
        this.policy.tenantId !== ctx.tenantId)
    ) {
      throw createPolicyDeniedError(
        'Policy tenant mismatch: policy is bound to a different tenant',
        'NO_MATCHING_RULE',
      );
    }
  }

  private assertValidLease(lease: LeasedRun): void {
    if (!lease || typeof lease !== 'object') {
      throw createInvalidArgumentError('LeasedRun is required');
    }
    if (!lease.tenantId || typeof lease.tenantId !== 'string') {
      throw createInvalidArgumentError('tenantId in LeasedRun is required');
    }
    if (!lease.taskId || typeof lease.taskId !== 'string') {
      throw createInvalidArgumentError('taskId in LeasedRun is required');
    }
    if (!lease.runId || typeof lease.runId !== 'string') {
      throw createInvalidArgumentError('runId in LeasedRun is required');
    }
    if (
      typeof lease.attempt !== 'number' ||
      !Number.isSafeInteger(lease.attempt) ||
      lease.attempt < 1
    ) {
      throw createInvalidArgumentError('attempt in LeasedRun must be a positive integer');
    }
    if (
      typeof lease.leaseEpoch !== 'number' ||
      !Number.isSafeInteger(lease.leaseEpoch) ||
      lease.leaseEpoch < 0
    ) {
      throw createInvalidArgumentError('leaseEpoch in LeasedRun must be a non-negative integer');
    }
    if (!lease.leaseExpiresAt || typeof lease.leaseExpiresAt !== 'string') {
      throw createInvalidArgumentError('leaseExpiresAt in LeasedRun is required');
    }
  }

  private recordDenialAudit(params: {
    tenantId: string;
    taskId: string;
    runId: string;
    credentialRef: string;
    credentialVersion: number;
    provider: string;
    operation: string;
    url: string;
    method: string;
    reason: string;
    code?: EgressDenialCode;
    now: Date;
  }): void {
    if (!this.auditSink) return;

    try {
      const validMethod =
        params.method === 'GET' ||
        params.method === 'HEAD' ||
        params.method === 'POST' ||
        params.method === 'PUT' ||
        params.method === 'PATCH' ||
        params.method === 'DELETE' ||
        params.method === 'OPTIONS'
          ? params.method
          : 'GET';

      // Ensure denial audit strictly redacts unverified caller provider or operation strings,
      // and binds operation whitelist checks strictly to the verified provider to prevent cross-provider mislabeling.
      const rules: readonly EgressRule[] = this.policy.rules;
      const safeProvider =
        params.provider &&
        typeof params.provider === 'string' &&
        rules.some((r) => r.provider === params.provider)
          ? params.provider
          : '[UNVERIFIED_PROVIDER]';

      const safeOperation =
        safeProvider !== '[UNVERIFIED_PROVIDER]' &&
        params.operation &&
        typeof params.operation === 'string' &&
        rules.some(
          (r) =>
            r.provider === safeProvider && r.allowedOperations.includes(params.operation.trim()),
        )
          ? params.operation.trim()
          : '[UNVERIFIED_OPERATION]';

      const record = createAuditRecord({
        tenantId: params.tenantId,
        taskId: params.taskId,
        runId: params.runId,
        callerType: 'execution',
        provider: safeProvider,
        operation: safeOperation,
        operationKind: 'read',
        credentialRef: params.credentialRef,
        credentialVersion: params.credentialVersion,
        targetUrlOrOrigin: params.url,
        method: validMethod,
        decision: 'DENIED',
        denialReason: params.reason,
        denialCode: params.code,
        now: params.now,
      });

      this.auditSink.record(record);
    } catch {
      // Audit recording must never throw to mask errors
    }
  }
}
