import { describe, expect, it } from 'vitest';
import {
  V2LocalRuntimeHarness,
  V2_M1_ACCEPTANCE_MATRIX,
  resolveAbRuntimeTarget,
} from '../../apps/benchmark/src/v2-m1/index.js';

const abTarget = resolveAbRuntimeTarget();

describe('V2-M1-D Acceptance Matrix Contract (Gate Check)', () => {
  it('registers all F-1..F-23 and FI-01..FI-16 scenarios without substituting M0 probes', () => {
    const fScenarios = V2_M1_ACCEPTANCE_MATRIX.filter((s) => s.family === 'M0A_F');
    const fiScenarios = V2_M1_ACCEPTANCE_MATRIX.filter((s) => s.family === 'M0B_FI');
    expect(fScenarios.map((s) => s.id)).toEqual(
      Array.from({ length: 23 }, (_, idx) => `F-${idx + 1}`),
    );
    expect(fiScenarios.map((s) => s.id)).toEqual(
      Array.from({ length: 16 }, (_, idx) => `FI-${String(idx + 1).padStart(2, '0')}`),
    );
  });
});

describe.skipIf(!abTarget.available)(
  'V2-M1-D Full A/B Runtime End-to-End Acceptance (F-1..F-23 & FI-01..FI-16)',
  () => {
    it('boot sanity only (NOT F-1..F-23/FI-01..FI-16 proof): boots A/B real Wrangler runtime with B D1 migrations verified', async () => {
      const harness = await V2LocalRuntimeHarness.start({
        target: {
          kind: 'ab_runtime',
          configPath: abTarget.configPath!,
        },
      });
      try {
        const res = await harness.fetch('/v1/health');
        expect(res.ok).toBe(true);
      } finally {
        await harness.dispose();
      }
    });
  },
);
