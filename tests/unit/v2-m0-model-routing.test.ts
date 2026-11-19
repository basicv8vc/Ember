import { describe, expect, it } from 'vitest';
import { runModelRoutingMatrix } from '../../apps/benchmark/src/model-routing-matrix.js';

describe('V2-M0-D Model Routing Matrix (Unit)', () => {
  it('evaluates candidate routes using verified repo rates and privacy attributes without live LLM calls', () => {
    const report = runModelRoutingMatrix();

    expect(report.scenarioId).toBe('ember-v2-m0-model-routing');
    expect(report.evidenceKind).toBe('simulated_synthetic');
    expect(report.evalCaseCount).toBeGreaterThan(0);
    expect(report.candidates.length).toBeGreaterThanOrEqual(5);

    const nemotron = report.candidates.find((c) => c.routeId === 'cloud-fast-zdr-nemotron');
    expect(nemotron).toBeDefined();
    expect(nemotron?.inputUsdPerMillion).toBe(0.06);
    expect(nemotron?.outputUsdPerMillion).toBe(0.16);
    expect(nemotron?.privacy.zdr).toBe(true);
    expect(nemotron?.privacy.dataCollectionDeny).toBe(true);
    expect(nemotron?.costPerSuccessfulTaskUsd).toBeGreaterThan(0);

    const deepseek = report.candidates.find((c) => c.routeId === 'cloud-vision-tools-deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek?.capabilities.visionInput).toBe(true);
    expect(deepseek?.capabilities.toolCalling).toBe(true);
    expect(deepseek?.privacy.zdr).toBe(true);

    const local = report.candidates.find((c) => c.routeId === 'device-local-mlx-small');
    expect(local).toBeDefined();
    expect(local?.placement).toBe('device_local');
    expect(local?.privacy.localOnly).toBe(true);
    expect(local?.costPerSuccessfulTaskUsd).toBe(0);

    expect(report.routingPolicySummary.length).toBeGreaterThanOrEqual(4);
  });
});
