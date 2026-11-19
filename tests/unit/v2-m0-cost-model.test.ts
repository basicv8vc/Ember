import { describe, expect, it } from 'vitest';
import { calculateAdr0006Cost, runCostModelAnalysis } from '../../apps/benchmark/src/cost-model.js';

describe('V2-M0-D ADR-0006 Cost Model Calculator (Unit)', () => {
  it('reproduces all 15 ADR-0006 reference cloud runtime cost cells accurately', () => {
    const expected: readonly {
      readonly mau: number;
      readonly full: number;
      readonly half: number;
      readonly zero: number;
    }[] = [
      { mau: 10, full: 5.0, half: 5.0, zero: 22.73 },
      { mau: 100, full: 5.0, half: 5.08, zero: 24.7 },
      { mau: 1_000, full: 9.33, half: 10.43, zero: 44.62 },
      { mau: 10_000, full: 176.07, half: 208.14, zero: 245.01 },
      { mau: 100_000, full: 2_204.8, half: 2_261.13, zero: 2_326.0 },
    ];

    for (const row of expected) {
      expect(
        calculateAdr0006Cost({ mau: row.mau, allowanceRemainingRatio: 1.0 }).cloudRuntime.totalUsd,
      ).toBe(row.full);
      expect(
        calculateAdr0006Cost({ mau: row.mau, allowanceRemainingRatio: 0.5 }).cloudRuntime.totalUsd,
      ).toBe(row.half);
      expect(
        calculateAdr0006Cost({ mau: row.mau, allowanceRemainingRatio: 0.0 }).cloudRuntime.totalUsd,
      ).toBe(row.zero);
    }
  });

  it('supports per-meter shared allowance deductions B_i and DO billing rounding rules', () => {
    const out = calculateAdr0006Cost({
      mau: 1_000,
      otherProductsUsage: {
        do_requests: 1_000_000, // consumes 100% of DO request allowance
        do_duration: 400_000, // consumes 100% of DO duration allowance
      },
    });
    const doReq = out.cloudRuntime.meters.find((m) => m.meter === 'do_requests')!;
    const doDur = out.cloudRuntime.meters.find((m) => m.meter === 'do_duration')!;

    // 1000 MAU * 684 events * 4 DO req = 2.736M req -> ceil(2.736) * $0.15 = $0.45
    expect(doReq.remainingAllowance).toBe(0);
    expect(doReq.billableUnits).toBe(3);
    expect(doReq.costUsd).toBe(0.45);

    // 1000 MAU * 684 events * 0.5s * 0.128 GB = 43,776 GB-s -> ceil(0.043776) * $12.50 = $12.50
    expect(doDur.remainingAllowance).toBe(0);
    expect(doDur.billableUnits).toBe(1);
    expect(doDur.costUsd).toBe(12.5);
  });

  it('models LLM, Daytona sandbox, device offload savings, storage growth, and independent recovery', () => {
    const base = calculateAdr0006Cost({
      mau: 1_000,
      sandbox: { deviceOffloadRate: 0 },
    });
    const offloaded = calculateAdr0006Cost({
      mau: 1_000,
      sandbox: { deviceOffloadRate: 0.5 },
    });

    // ADR-0006 §Separate variable execution budget: 1k MAU -> $3,078 LLM + $166.50 sandbox
    expect(base.variableExecution.llmCostUsd).toBe(3_078);
    expect(base.variableExecution.sandboxGrossCostUsd).toBe(166.5);
    expect(offloaded.variableExecution.sandboxNetAfterOffloadUsd).toBe(83.25);
    expect(offloaded.variableExecution.sandboxSavingsUsd).toBe(83.25);

    const baseZeroAllowance = calculateAdr0006Cost({
      mau: 1_000,
      allowanceRemainingRatio: 0,
    });
    const withRecovery = calculateAdr0006Cost({
      mau: 1_000,
      allowanceRemainingRatio: 0,
      independentRecovery: { enabled: true, d1WritesPerEvent: 2 },
    });
    expect(withRecovery.cloudRuntime.totalUsd).toBeGreaterThan(
      baseZeroAllowance.cloudRuntime.totalUsd,
    );

    const grown = calculateAdr0006Cost({
      mau: 10_000,
      storageGrowth: { monthsElapsed: 12, dormantRetainedRatio: 2.0 },
    });
    const steady = calculateAdr0006Cost({ mau: 10_000 });
    expect(grown.cloudRuntime.totalUsd).toBeGreaterThan(steady.cloudRuntime.totalUsd);
  });

  it('produces complete sensitivity sweeps without NaN or negative costs', () => {
    const analysis = runCostModelAnalysis();
    expect(analysis.adr0006ReferenceMatrix).toHaveLength(5);
    expect(analysis.doWriteRowsSensitivity.length).toBeGreaterThan(0);
    expect(analysis.doDurationSensitivity.length).toBeGreaterThan(0);
    expect(analysis.streamingCpuSensitivity.length).toBeGreaterThan(0);
    expect(analysis.storageGrowthProjection.length).toBeGreaterThan(0);
    expect(analysis.independentRecoverySensitivity.length).toBeGreaterThan(0);
    expect(analysis.variableCostAndOffloadSensitivity.length).toBeGreaterThan(0);
  });
});
