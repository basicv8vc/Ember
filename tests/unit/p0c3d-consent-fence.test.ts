import {
  assertConsentAllowed,
  CONSENT_COLUMNS_SQL,
  evaluateConsentRow,
  type ConsentGrantRow,
} from '@ember/postgres';
import { DomainError } from '@ember/domain';
import { describe, expect, it } from 'vitest';

const GRANTED_AT = '2026-01-01T00:00:00.000Z';

/** A row exactly as `CONSENT_COLUMNS_SQL` projects it for an effective, unbounded grant. */
function effectiveRow(overrides: Partial<ConsentGrantRow> = {}): ConsentGrantRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    source_profile_id: 'fixture.github-release',
    status: 'active',
    allowed_operations: ['read_snapshot', 'publish_outcome'],
    scopes: [],
    granted_at: GRANTED_AT,
    expires_at: null,
    revoked_at: null,
    version: 1,
    created_at: GRANTED_AT,
    updated_at: GRANTED_AT,
    effective_status: 'active',
    is_effective: true,
    ...overrides,
  };
}

describe('evaluateConsentRow (authorization matrix)', () => {
  it('allows an effective grant that lists the operation', () => {
    const decision = evaluateConsentRow(effectiveRow(), 'read_snapshot');

    expect(decision).toStrictEqual({ allowed: true, denialCode: null, consentVersion: 1 });
  });

  it('fails closed when no grant row exists', () => {
    expect(evaluateConsentRow(undefined, 'read_snapshot')).toStrictEqual({
      allowed: false,
      denialCode: 'CONSENT_NOT_FOUND',
      consentVersion: null,
    });
  });

  it('denies a revoked grant, whether the stored or derived status says so', () => {
    const storedRevoked = evaluateConsentRow(effectiveRow({ status: 'revoked' }), 'read_snapshot');
    const derivedRevoked = evaluateConsentRow(
      effectiveRow({ effective_status: 'revoked', is_effective: false }),
      'read_snapshot',
    );

    expect(storedRevoked).toStrictEqual({
      allowed: false,
      denialCode: 'CONSENT_REVOKED',
      consentVersion: null,
    });
    expect(derivedRevoked.denialCode).toBe('CONSENT_REVOKED');
  });

  it('denies an expired grant even if the stored status still says active', () => {
    const decision = evaluateConsentRow(
      effectiveRow({ effective_status: 'expired', is_effective: false }),
      'read_snapshot',
    );

    expect(decision).toStrictEqual({
      allowed: false,
      denialCode: 'CONSENT_EXPIRED',
      consentVersion: null,
    });
  });

  it('denies when the row reports ineffective without an explicit derived status', () => {
    expect(
      evaluateConsentRow(effectiveRow({ is_effective: false }), 'read_snapshot').denialCode,
    ).toBe('CONSENT_EXPIRED');
  });

  it('denies an operation the grant does not list', () => {
    const readOnly = effectiveRow({ allowed_operations: ['read_snapshot'] });

    expect(evaluateConsentRow(readOnly, 'read_snapshot').allowed).toBe(true);
    expect(evaluateConsentRow(readOnly, 'publish_outcome')).toStrictEqual({
      allowed: false,
      denialCode: 'OPERATION_NOT_ALLOWED',
      consentVersion: null,
    });
  });
});

describe('version fence', () => {
  it('accepts a grant still at the version that authorised the work', () => {
    expect(evaluateConsentRow(effectiveRow({ version: 2 }), 'publish_outcome', 2)).toStrictEqual({
      allowed: true,
      denialCode: null,
      consentVersion: 2,
    });
  });

  it('fails a stale fence and reports the current version', () => {
    // A re-grant between dispatch and publication bumps the version, so work dispatched under
    // version 1 can no longer be published once the grant is at version 2.
    expect(evaluateConsentRow(effectiveRow({ version: 2 }), 'publish_outcome', 1)).toStrictEqual({
      allowed: false,
      denialCode: 'CONSENT_VERSION_STALE',
      consentVersion: 2,
    });
  });

  it('treats a null or absent required version as "no fence recorded"', () => {
    const row = effectiveRow({ version: 5 });

    expect(evaluateConsentRow(row, 'publish_outcome', null).allowed).toBe(true);
    expect(evaluateConsentRow(row, 'publish_outcome').allowed).toBe(true);
  });

  it('reports revocation before staleness so the caller sees the real cause', () => {
    const decision = evaluateConsentRow(
      effectiveRow({ status: 'revoked', version: 9 }),
      'publish_outcome',
      1,
    );

    expect(decision.denialCode).toBe('CONSENT_REVOKED');
  });
});

describe('assertConsentAllowed', () => {
  it('is a no-op for an allowed decision', () => {
    const decision = evaluateConsentRow(effectiveRow(), 'read_snapshot');

    expect(() => assertConsentAllowed(decision, 'read_snapshot')).not.toThrow();
  });

  it('throws POLICY_DENIED and keeps the reason out of the client-safe message', () => {
    const decision = evaluateConsentRow(undefined, 'publish_outcome');

    try {
      assertConsentAllowed(decision, 'publish_outcome');
      throw new Error('expected assertConsentAllowed to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe('POLICY_DENIED');
      expect(domainError.publicMessage).toBe('Operation denied by policy');
      expect(domainError.message).toBe('Operation denied by policy');
      // The reason for the denial is internal-only context, never client-visible text.
      expect(domainError.diagnostic).toContain('CONSENT_NOT_FOUND');
    }
  });

  it('does not re-check the operation: that is the evaluator\u2019s job', () => {
    // The assertion helper only turns a decision into a throw. Re-deriving the verdict here
    // would let an allowed decision silently authorise an operation the grant never listed.
    const decision = evaluateConsentRow(
      effectiveRow({ allowed_operations: ['read_snapshot'] }),
      'read_snapshot',
    );

    expect(() => assertConsentAllowed(decision, 'publish_outcome')).not.toThrow();
    expect(
      evaluateConsentRow(effectiveRow({ allowed_operations: ['read_snapshot'] }), 'publish_outcome')
        .allowed,
    ).toBe(false);
  });
});

describe('CONSENT_COLUMNS_SQL', () => {
  it('derives effectiveness from the database clock, never a host timestamp', () => {
    expect(CONSENT_COLUMNS_SQL).toContain('clock_timestamp()');
    expect(CONSENT_COLUMNS_SQL).toContain('effective_status');
    expect(CONSENT_COLUMNS_SQL).toContain('is_effective');
  });
});
