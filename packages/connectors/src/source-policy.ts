/**
 * Pure policy evaluation engine for @ember/connectors.
 *
 * Enforces default-deny access controls:
 * - Opaque source profile allowlists.
 * - Strict tenant scope matching.
 * - Active consent grant validation.
 * - Safe static denial reasons and codes.
 */

import { describeConsentDenialCode, deriveConsentStatus } from './consent.js';
import type {
  ConsentGrant,
  SourceAccessDecision,
  SourceAccessPolicy,
  SourceProfile,
  TrustedSourceAccessContext,
} from './types.js';

export interface EvaluateSourceAccessParams {
  readonly profile: SourceProfile | null;
  readonly context: TrustedSourceAccessContext;
  readonly grant: ConsentGrant | null;
  readonly policy: SourceAccessPolicy;
  readonly operation?: string;
  /** Scopes the caller must hold on the grant (all of them). Empty/missing means "no scope check". */
  readonly requiredScopes?: readonly string[];
  readonly now?: Date;
}

/**
 * Evaluates whether a requested source read operation is permitted.
 * Guaranteed pure, deterministic, and free of side-effects or network calls.
 */
export function evaluateSourceAccess(params: EvaluateSourceAccessParams): SourceAccessDecision {
  const {
    profile,
    context,
    grant,
    policy,
    operation = 'read_snapshot',
    requiredScopes = [],
    now = new Date(),
  } = params;

  // 1. Profile existence check
  if (!profile) {
    return {
      allowed: false,
      denialCode: 'SOURCE_PROFILE_NOT_FOUND',
      reason: 'Source profile not found',
    };
  }

  // 2. Profile status check
  if (profile.status !== 'active') {
    return {
      allowed: false,
      denialCode: 'SOURCE_PROFILE_DISABLED',
      reason: 'Source profile is disabled',
    };
  }

  // 3. Strict tenant matching on profile
  if (profile.tenantId !== context.tenantId) {
    return {
      allowed: false,
      denialCode: 'TENANT_MISMATCH',
      reason: 'Tenant mismatch on source profile',
    };
  }

  // 4. Policy tenant binding
  if (policy.tenantId !== undefined && policy.tenantId !== context.tenantId) {
    return {
      allowed: false,
      denialCode: 'POLICY_DENIED',
      reason: 'Access policy is strictly bound to another tenant',
    };
  }

  // 5. Policy sourceProfileId allowlist
  if (!policy.allowedSourceProfileIds.includes(profile.sourceProfileId)) {
    return {
      allowed: false,
      denialCode: 'POLICY_DENIED',
      reason: 'Source profile is not permitted by server policy',
    };
  }

  // 6. Policy allowed operations
  if (!policy.allowedOperations.includes(operation)) {
    return {
      allowed: false,
      denialCode: 'OPERATION_NOT_ALLOWED',
      reason: 'Requested operation is not permitted by server policy',
    };
  }

  // 7. Profile allowed operations
  if (!profile.allowedOperations.includes(operation)) {
    return {
      allowed: false,
      denialCode: 'OPERATION_NOT_ALLOWED',
      reason: 'Requested operation is not supported by source profile',
    };
  }

  // 8. Consent grant presence
  if (!grant) {
    return {
      allowed: false,
      denialCode: 'CONSENT_NOT_FOUND',
      reason: 'No consent grant found for tenant and source profile',
    };
  }

  // 9. Consent tenant matching
  if (grant.tenantId !== context.tenantId) {
    return {
      allowed: false,
      denialCode: 'TENANT_MISMATCH',
      reason: 'Consent grant belongs to a different tenant',
    };
  }

  // 10-11. Canonical consent lifecycle check (revocation -> expiry -> non-active), shared with
  // `deriveConsentStatus` so the policy gate and persisted authority can never disagree.
  const consentDenial = describeConsentDenialCode(grant, now);
  if (consentDenial === 'CONSENT_REVOKED') {
    return {
      allowed: false,
      denialCode: 'CONSENT_REVOKED',
      reason: 'User consent has been revoked',
    };
  }
  if (consentDenial === 'CONSENT_EXPIRED') {
    return {
      allowed: false,
      denialCode: 'CONSENT_EXPIRED',
      reason: 'User consent grant has expired',
    };
  }

  if (deriveConsentStatus(grant, now) !== 'active') {
    return {
      allowed: false,
      denialCode: 'POLICY_DENIED',
      reason: 'Consent grant is not in active status',
    };
  }

  // 12. Consent allowed operations
  if (!grant.allowedOperations.includes(operation)) {
    return {
      allowed: false,
      denialCode: 'OPERATION_NOT_ALLOWED',
      reason: 'Operation is not permitted by user consent grant',
    };
  }

  // 13. Consent granted scopes (all required scopes must be present on the grant)
  if (requiredScopes.length > 0) {
    const grantedScopes = new Set(grant.scopes);
    if (!requiredScopes.every((scope) => grantedScopes.has(scope))) {
      return {
        allowed: false,
        denialCode: 'SCOPE_NOT_GRANTED',
        reason: 'Required scope is not granted by user consent',
      };
    }
  }

  return {
    allowed: true,
    sourceProfileId: profile.sourceProfileId,
    operation,
  };
}
