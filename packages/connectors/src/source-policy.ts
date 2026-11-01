/**
 * Pure policy evaluation engine for @ember/connectors.
 *
 * Enforces default-deny access controls:
 * - Opaque source profile allowlists.
 * - Strict tenant scope matching.
 * - Active consent grant validation.
 * - Safe static denial reasons and codes.
 */

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
  readonly now?: Date;
}

/**
 * Evaluates whether a requested source read operation is permitted.
 * Guaranteed pure, deterministic, and free of side-effects or network calls.
 */
export function evaluateSourceAccess(params: EvaluateSourceAccessParams): SourceAccessDecision {
  const { profile, context, grant, policy, operation = 'read_snapshot', now = new Date() } = params;

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

  // 10. Consent revocation check
  if (grant.status === 'revoked' || grant.revokedAt !== null) {
    return {
      allowed: false,
      denialCode: 'CONSENT_REVOKED',
      reason: 'User consent has been revoked',
    };
  }

  // 11. Consent expiration check
  if (grant.status === 'expired') {
    return {
      allowed: false,
      denialCode: 'CONSENT_EXPIRED',
      reason: 'User consent grant has expired',
    };
  }

  if (grant.expiresAt !== null) {
    const expDate = new Date(grant.expiresAt);
    if (expDate <= now) {
      return {
        allowed: false,
        denialCode: 'CONSENT_EXPIRED',
        reason: 'User consent grant has expired',
      };
    }
  }

  if (grant.status !== 'active') {
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

  return {
    allowed: true,
    sourceProfileId: profile.sourceProfileId,
    operation,
  };
}
