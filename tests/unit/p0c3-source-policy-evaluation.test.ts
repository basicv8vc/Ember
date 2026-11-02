import { describe, expect, it } from 'vitest';
import {
  evaluateSourceAccess,
  FIXTURE_PROFILE_ALERTS,
  FIXTURE_PROFILE_DISABLED,
  FIXTURE_PROFILE_RELEASES,
  TEST_TENANT_A,
  TEST_TENANT_B,
  type ConsentGrant,
  type SourceAccessPolicy,
  type TrustedSourceAccessContext,
} from '@ember/connectors';

describe('P0-C3C: Pure Source Access Policy Evaluation', () => {
  const validContext: TrustedSourceAccessContext = {
    tenantId: TEST_TENANT_A,
    commitmentId: 'comm_11111111-1111-1111-1111-111111111111',
    taskId: 'task_11111111-1111-1111-1111-111111111111',
    runId: 'run_11111111-1111-1111-1111-111111111111',
    leaseEpoch: 1,
    authorizedAt: '2026-11-01T12:00:00.000Z',
  };

  const validPolicy: SourceAccessPolicy = {
    version: 1,
    allowedSourceProfileIds: ['sp_ember_releases', 'sp_system_alerts'],
    allowedOperations: ['read_snapshot'],
    defaultAction: 'deny',
  };

  const validGrant: ConsentGrant = {
    grantId: 'grant_11111111-1111-1111-1111-111111111111',
    tenantId: TEST_TENANT_A,
    sourceProfileId: 'sp_ember_releases',
    status: 'active',
    allowedOperations: ['read_snapshot'],
    scopes: ['source.readonly'],
    grantedAt: '2026-11-01T10:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    version: 1,
  };

  it('allows access when profile, policy, and active grant match', () => {
    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_RELEASES,
      context: validContext,
      grant: validGrant,
      policy: validPolicy,
      operation: 'read_snapshot',
    });

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.sourceProfileId).toBe('sp_ember_releases');
      expect(decision.operation).toBe('read_snapshot');
    }
  });

  it('denies when profile is null (SOURCE_PROFILE_NOT_FOUND)', () => {
    const decision = evaluateSourceAccess({
      profile: null,
      context: validContext,
      grant: validGrant,
      policy: validPolicy,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('SOURCE_PROFILE_NOT_FOUND');
    }
  });

  it('denies when profile is disabled (SOURCE_PROFILE_DISABLED)', () => {
    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_DISABLED,
      context: validContext,
      grant: validGrant,
      policy: validPolicy,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('SOURCE_PROFILE_DISABLED');
    }
  });

  it('denies on tenant mismatch between caller context and profile (TENANT_MISMATCH)', () => {
    const crossTenantContext: TrustedSourceAccessContext = {
      ...validContext,
      tenantId: TEST_TENANT_B,
    };

    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_RELEASES,
      context: crossTenantContext,
      grant: validGrant,
      policy: validPolicy,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('TENANT_MISMATCH');
    }
  });

  it('denies when policy is bound to another tenant (POLICY_DENIED)', () => {
    const tenantBPolicy: SourceAccessPolicy = {
      ...validPolicy,
      tenantId: TEST_TENANT_B,
    };

    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_RELEASES,
      context: validContext,
      grant: validGrant,
      policy: tenantBPolicy,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('POLICY_DENIED');
    }
  });

  it('denies when profile is not allowlisted by policy (POLICY_DENIED)', () => {
    const restrictivePolicy: SourceAccessPolicy = {
      ...validPolicy,
      allowedSourceProfileIds: ['sp_system_alerts'],
    };

    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_RELEASES,
      context: validContext,
      grant: validGrant,
      policy: restrictivePolicy,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('POLICY_DENIED');
    }
  });

  it('denies when operation is not allowed by policy (OPERATION_NOT_ALLOWED)', () => {
    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_RELEASES,
      context: validContext,
      grant: validGrant,
      policy: validPolicy,
      operation: 'admin_mutate',
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('OPERATION_NOT_ALLOWED');
    }
  });

  it('denies when consent grant is missing (CONSENT_NOT_FOUND)', () => {
    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_RELEASES,
      context: validContext,
      grant: null,
      policy: validPolicy,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('CONSENT_NOT_FOUND');
    }
  });

  it('denies when consent grant belongs to another tenant (TENANT_MISMATCH)', () => {
    const crossTenantGrant: ConsentGrant = {
      ...validGrant,
      tenantId: TEST_TENANT_B,
    };

    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_RELEASES,
      context: validContext,
      grant: crossTenantGrant,
      policy: validPolicy,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('TENANT_MISMATCH');
    }
  });

  it('denies when consent grant is revoked (CONSENT_REVOKED)', () => {
    const revokedGrant: ConsentGrant = {
      ...validGrant,
      status: 'revoked',
      revokedAt: '2026-11-01T11:00:00.000Z',
    };

    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_RELEASES,
      context: validContext,
      grant: revokedGrant,
      policy: validPolicy,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('CONSENT_REVOKED');
    }
  });

  it('denies when consent grant is expired (CONSENT_EXPIRED)', () => {
    const expiredGrant: ConsentGrant = {
      ...validGrant,
      status: 'active',
      expiresAt: '2026-11-01T11:00:00.000Z',
    };

    const decision = evaluateSourceAccess({
      profile: FIXTURE_PROFILE_ALERTS,
      context: validContext,
      grant: expiredGrant,
      policy: validPolicy,
      now: new Date('2026-11-01T11:30:00.000Z'),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denialCode).toBe('CONSENT_EXPIRED');
    }
  });
});
