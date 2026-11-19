import { describe, expect, it } from 'vitest';
import { runModelRoutingMatrix } from '../../apps/benchmark/src/model-routing-matrix.js';

describe('V2-M0-D Model Routing Matrix (Unit)', () => {
  it('derives repo rates/approvals, enforces privacy eligibility, and excludes pending routes from fallbacks', () => {
    const report = runModelRoutingMatrix(new Date('2026-11-19T12:00:00Z'));

    expect(report.scenarioId).toBe('ember-v2-m0-model-routing');
    expect(report.evidenceKind).toBe('simulated_synthetic');
    expect(report.evaluationDateUtc).toBe('2026-11-19');
    expect(report.evalCaseCount).toBe(8);
    expect(report.candidates.length).toBeGreaterThanOrEqual(5);

    const nemotron = report.candidates.find((c) => c.routeId === 'cloud-fast-zdr-nemotron')!;
    expect(nemotron.inputUsdPerMillion).toBe(0.06);
    expect(nemotron.outputUsdPerMillion).toBe(0.16);
    expect(nemotron.rateProvenance).toBe('official_price_verified');
    expect(nemotron.approvalStatus).toBe('smoke_expired_internal_staging_only');
    expect(nemotron.authorizationEligible).toBe(true);
    expect(nemotron.privacy.zdr).toBe(true);
    expect(nemotron.privacy.dataCollectionDeny).toBe(true);
    // Cloud routes must not be privacy-eligible for local-only private inputs (7 of 8 cases)
    expect(nemotron.privacyEligibleCount).toBe(7);

    const deepseek = report.candidates.find((c) => c.routeId === 'cloud-vision-tools-deepseek')!;
    expect(deepseek.capabilities.visionInput).toBe(true);
    expect(deepseek.capabilities.toolCalling).toBe(true);
    expect(deepseek.approvalStatus).toBe('smoke_expired_internal_staging_only');
    expect(deepseek.privacyEligibleCount).toBe(7);

    const luna = report.candidates.find((c) => c.routeId === 'cloud-reasoning-gpt56-luna')!;
    expect(luna.approvalStatus).toBe('pending_cto_approval');
    expect(luna.authorizationEligible).toBe(false);
    expect(luna.rateProvenance).toBe('unverified');

    const local = report.candidates.find((c) => c.routeId === 'device-local-mlx-small')!;
    expect(local.placement).toBe('device_local');
    expect(local.approvalStatus).toBe('research_only');
    expect(local.authorizationEligible).toBe(false);
    expect(local.privacy.localOnly).toBe(true);
    expect(local.privacyEligibleCount).toBe(8);
    expect(local.costPerSuccessfulTaskUsd).toBe(0);

    // Operational fallbacks must never reference pending or unapproved research routes
    for (const rule of report.routingPolicySummary) {
      expect(rule.fallbackRouteId).not.toBe('cloud-reasoning-gpt56-luna');
      expect(rule.fallbackRouteId).not.toBe('cloud-adr0006-illustrative');
    }
  });
});
