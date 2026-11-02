import { describe, expect, it } from 'vitest';
import {
  assertConsentConformance,
  CONSENT_CONFORMANCE_CASES,
  ConsentConformanceViolation,
  FakeConsentRegistry,
  runConsentConformanceSuite,
  type ConsentConformanceAdapter,
  type ConsentGrant,
  type GrantConsentParams,
} from '@ember/connectors';

/**
 * P0-C3C: the frozen Consent contract must hold for every implementation. These tests certify the
 * test-only `FakeConsentRegistry` through the same adapter port that Agent A's durable PostgreSQL
 * repository must implement.
 */
function baseAdapter(registry: FakeConsentRegistry): ConsentConformanceAdapter {
  return {
    name: 'FakeConsentRegistry',
    reset: () => {
      registry.clear();
    },
    grant: (params: GrantConsentParams, now: Date): ConsentGrant => registry.grant(params, now),
    get: (tenantId, sourceProfileId, now) => registry.get(tenantId, sourceProfileId, now),
    revoke: (tenantId, sourceProfileId, now) => registry.revoke(tenantId, sourceProfileId, now),
    list: (tenantId, now) => registry.list(tenantId, now),
    resolveGeneration: (tenantId, sourceProfileId, now) =>
      registry.resolveGeneration(tenantId, sourceProfileId, now),
  };
}

function createAdapter(): ConsentConformanceAdapter {
  return baseAdapter(new FakeConsentRegistry());
}

describe('P0-C3C: frozen Consent contract conformance suite', () => {
  it('publishes a complete, immutable requirement matrix', () => {
    expect(CONSENT_CONFORMANCE_CASES).toHaveLength(12);
    expect(Object.isFrozen(CONSENT_CONFORMANCE_CASES)).toBe(true);

    const ids = CONSENT_CONFORMANCE_CASES.map((testCase) => testCase.id);
    expect(ids).toEqual([
      'C-01',
      'C-02',
      'C-03',
      'C-04',
      'C-05',
      'C-06',
      'C-07',
      'C-08',
      'C-09',
      'C-10',
      'C-11',
      'C-12',
    ]);

    const requirements = CONSENT_CONFORMANCE_CASES.map((testCase) => testCase.requirement);
    expect(new Set(requirements).size).toBe(requirements.length);
  });

  it('certifies FakeConsentRegistry against every case', async () => {
    const results = await runConsentConformanceSuite(createAdapter());

    expect(results).toHaveLength(CONSENT_CONFORMANCE_CASES.length);
    for (const result of results) {
      expect(`${result.id}: ${result.error ?? 'passed'}`).toBe(`${result.id}: passed`);
    }
  });

  it('exposes assertConsentConformance for durable implementations (Agent A port)', async () => {
    const results = await assertConsentConformance(createAdapter());
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it('detects an implementation whose revocation does not take effect', async () => {
    const registry = new FakeConsentRegistry();
    const mutant: ConsentConformanceAdapter = {
      ...baseAdapter(registry),
      name: 'NonRevokingRegistry',
      // Ignores revocation entirely: the grant stays active forever.
      revoke: (tenantId, sourceProfileId, now) => {
        const current = registry.get(tenantId, sourceProfileId, now);
        if (current === null) {
          throw new Error('Consent grant not found');
        }
        return current;
      },
    };

    const rejection = await assertConsentConformance(mutant).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(ConsentConformanceViolation);
    const violation = rejection as ConsentConformanceViolation;
    const failedIds = violation.results
      .filter((result) => !result.passed)
      .map((result) => result.id);
    expect(failedIds).toContain('C-02');
    expect(violation.message).toContain('C-02');
  });

  it('detects an implementation that inflates versions on idempotent re-affirmation', async () => {
    const registry = new FakeConsentRegistry();
    const mutant: ConsentConformanceAdapter = {
      ...baseAdapter(registry),
      name: 'VersionInflatingRegistry',
      // Every grant call mints a new generation, breaking retry safety.
      grant: (params: GrantConsentParams, now: Date): ConsentGrant => {
        if (registry.get(params.tenantId, params.sourceProfileId, now) !== null) {
          registry.revoke(params.tenantId, params.sourceProfileId, now);
        }
        return registry.grant(params, now);
      },
    };

    const results = await runConsentConformanceSuite(mutant);
    const failures = results.filter((result) => !result.passed).map((result) => result.id);
    expect(failures).toContain('C-09');
  });
});
