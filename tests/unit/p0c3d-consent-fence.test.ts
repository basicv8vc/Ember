import { SOURCE_READ_SCOPE } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import {
  assertConsentAllowed,
  deriveRowStatus,
  evaluateConsentRow,
  type ConsentGrantRow,
} from '@ember/postgres';
import { describe, expect, it } from 'vitest';

/**
 * Pure evaluation matrix for the durable publication gate.
 *
 * `evaluateConsentRow` is the single verdict used by the API read path, the dispatch gate and the
 * publication gate, so this suite pins the precedence every one of them depends on. The
 * database-backed behaviour is covered by `tests/integration/p0c3d-consent-postgres.test.ts`.
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE = 'fixture.github-release';
const GRANTED_AT = '2026-01-01T00:00:00.000Z';

function row(overrides: Partial<ConsentGrantRow> = {}): ConsentGrantRow {
  return {
    id: GRANT_ID,
    tenant_id: TENANT_ID,
    source_profile_id: PROFILE,
    status: 'active',
    allowed_operations: ['read_snapshot'],
    scopes: [SOURCE_READ_SCOPE],
    granted_at: GRANTED_AT,
    expires_at: null,
    revoked_at: null,
    version: 3,
    created_at: GRANTED_AT,
    updated_at: GRANTED_AT,
    is_expired: false,
    effective_status: 'active',
    ...overrides,
  };
}

const READ = { operation: 'read_snapshot' as const, requiredScopes: [SOURCE_READ_SCOPE] };

describe('P0-C3D: consent row evaluation', () => {
  it('denies a missing grant', () => {
    expect(evaluateConsentRow(undefined, READ)).toEqual({
      allowed: false,
      denialCode: 'CONSENT_NOT_FOUND',
      grantId: null,
      grantVersion: null,
    });
  });

  it('reports revocation ahead of every other condition', () => {
    const decision = evaluateConsentRow(
      row({ status: 'revoked', revoked_at: GRANTED_AT, scopes: [] }),
      { ...READ, fence: { grantId: GRANT_ID, version: 999 }, requireFence: true },
    );

    expect(decision.denialCode).toBe('CONSENT_REVOKED');
  });

  it('derives expiry from the database clock when no clock is supplied', () => {
    const stored = row({ expires_at: '2026-01-01T01:00:00.000Z', is_expired: true });

    expect(deriveRowStatus(stored)).toBe('expired');
    expect(evaluateConsentRow(stored, READ).denialCode).toBe('CONSENT_EXPIRED');
  });

  it('honours an explicit clock instead of the stored flag', () => {
    const stored = row({ expires_at: '2026-11-01T13:00:00.000Z', is_expired: true });

    expect(deriveRowStatus(stored, new Date('2026-11-01T12:00:00.000Z'))).toBe('active');
    expect(deriveRowStatus(stored, new Date('2026-11-01T13:00:00.000Z'))).toBe('expired');
  });

  it('fails closed on an invalid explicit clock', () => {
    expect(deriveRowStatus(row(), new Date('not-a-date'))).toBe('expired');
  });

  it('denies an operation the grant does not allow', () => {
    expect(
      evaluateConsentRow(row({ allowed_operations: ['read_metadata'] }), READ).denialCode,
    ).toBe('OPERATION_NOT_ALLOWED');
  });

  it('denies a read whose grant lacks the required scope', () => {
    expect(evaluateConsentRow(row({ scopes: ['source.readwrite'] }), READ).denialCode).toBe(
      'SCOPE_NOT_GRANTED',
    );
    expect(evaluateConsentRow(row({ scopes: [] }), READ).denialCode).toBe('SCOPE_NOT_GRANTED');
  });

  it('denies publication when no generation was recorded', () => {
    expect(evaluateConsentRow(row(), { fence: null, requireFence: true }).denialCode).toBe(
      'CONSENT_FENCE_MISSING',
    );
  });

  it('allows a pre-read check without a fence', () => {
    expect(evaluateConsentRow(row(), READ)).toMatchObject({ allowed: true });
  });

  it('denies a fence that names a different generation', () => {
    expect(
      evaluateConsentRow(row(), {
        fence: { grantId: '33333333-3333-4333-8333-333333333333', version: 3 },
        requireFence: true,
      }).denialCode,
    ).toBe('CONSENT_GENERATION_MISMATCH');
  });

  it('denies a stale version of the same generation', () => {
    expect(
      evaluateConsentRow(row(), { fence: { grantId: GRANT_ID, version: 2 }, requireFence: true })
        .denialCode,
    ).toBe('CONSENT_FENCE_STALE');
  });

  it('allows a fence that matches the current generation and returns it', () => {
    expect(
      evaluateConsentRow(row(), { fence: { grantId: GRANT_ID, version: 3 }, requireFence: true }),
    ).toEqual({ allowed: true, denialCode: null, grantId: GRANT_ID, grantVersion: 3 });
  });
});

describe('P0-C3D: consent denial presentation', () => {
  it('throws POLICY_DENIED carrying only the reason and operation', () => {
    const decision = evaluateConsentRow(row({ scopes: [] }), READ);

    expect(() => assertConsentAllowed(decision, 'read_snapshot')).toThrowError(DomainError);

    try {
      assertConsentAllowed(decision, 'read_snapshot');
    } catch (error) {
      const thrown = error as DomainError;

      expect(thrown.code).toBe('POLICY_DENIED');
      expect(thrown.diagnostic).toContain('SCOPE_NOT_GRANTED');
      // No identifiers, no content: a denial must not become an oracle.
      expect(thrown.publicMessage).not.toContain(TENANT_ID);
      expect(thrown.diagnostic).not.toContain(TENANT_ID);
      expect(thrown.diagnostic).not.toContain(GRANT_ID);
      expect(thrown.diagnostic).not.toContain(PROFILE);
    }
  });

  it('returns normally for an allowed decision', () => {
    const decision = evaluateConsentRow(row({ id: GRANT_ID }), READ);

    expect(() => assertConsentAllowed(decision, 'read_snapshot')).not.toThrow();
  });
});
