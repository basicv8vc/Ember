import { describe, expect, it } from 'vitest';
import { runRttSimulation } from '../../apps/benchmark/src/rtt-simulation.js';
import { runSqliteProbe } from '../../apps/benchmark/src/sqlite-probe.js';
import { runTimingMethodology } from '../../apps/benchmark/src/timing-methodology.js';

describe('V2-M0-D Probes (Integration)', () => {
  it('runs the isolated local workerd DO SQLite, GlobalBudgetDO, and D1 probe', async () => {
    const report = await runSqliteProbe({
      iterations: 5,
      storageTurnsMax: 30,
      log: () => undefined,
    });

    expect(report.scenarioId).toBe('ember-v2-m0-sqlite-d1-probe');
    expect(report.evidenceKind).toBe('measured_local_workerd');
    expect(report.alarmRealFireVerified).toBe(true);
    expect(report.storageGrowth.points.length).toBeGreaterThanOrEqual(4);
    expect(report.storageGrowth.doNetBytesPerTurn).toBeGreaterThan(0);
    expect(report.jointAbSeamOps.length).toBeGreaterThanOrEqual(7);
    expect(report.m1MeasurementGap.missingInM0Probe.length).toBeGreaterThan(0);

    const doPrepare = report.operations.find(
      (op) => op.engine === 'do_sqlite' && op.operation === 'normal_turn_prepare',
    )!;
    expect(doPrepare.logicalStatementsPerOp).toBeGreaterThanOrEqual(6);
    expect(doPrepare.logicalMutationsPerOp).toBeGreaterThanOrEqual(5);
    expect(doPrepare.observedRowsReadMean).toBeGreaterThan(0);
    expect(doPrepare.observedRowsWrittenMean).toBeGreaterThan(0);
    expect(doPrepare.setAlarmCallsPerOp).toBe(1);

    const gbReserve = report.jointAbSeamOps.find((o) => o.operation === 'global_budget_reserve')!;
    expect(gbReserve.rowsWrittenMean).toBeGreaterThan(0);

    const d1Reg = report.jointAbSeamOps.find((o) => o.operation === 'd1_recovery_register')!;
    expect(d1Reg.rowsWrittenMean).toBeGreaterThan(0);
  });

  it('measures simplified 2-RPC and joint A/B 3-RPC timing plus fail-closed budget contention', async () => {
    const timing = await runTimingMethodology({
      turnIterations: 6,
      streamIterations: 2,
      budgetContentionConcurrency: 8,
      log: () => undefined,
    });

    expect(timing.simplified2RpcMicrobenchmark.successCount).toBe(6);
    expect(timing.simplified2RpcMicrobenchmark.errorCount).toBe(0);
    expect(timing.jointAbSeamTiming.successCount).toBe(6);
    expect(timing.jointAbSeamTiming.errorCount).toBe(0);
    expect(timing.jointAbSeamTiming.runtimeOverheadUncoveredMs.p95Ms).toBeGreaterThanOrEqual(
      timing.jointAbSeamTiming.ackCoveredMs.p95Ms,
    );

    const doFailClosed = timing.budgetCheckContention.results.find(
      (r) => r.targetAuthority === 'global_budget_do' && r.mode === 'exhaustion_fail_closed',
    )!;
    expect(doFailClosed.approvedCount).toBe(10);
    expect(doFailClosed.deniedExpectedCount).toBe(10);
    expect(doFailClosed.errorCount).toBe(0);
    expect(doFailClosed.overCommitted).toBe(false);
  });

  it('executes deterministic regional RTT simulation across joint A/B modes', async () => {
    const rtt = await runRttSimulation({
      samplesPerScenario: 3,
      concurrency: 3,
      seed: 7,
      log: () => undefined,
    });

    expect(rtt.evidenceKind).toBe('simulated_synthetic');
    const nearColocated = rtt.results.find(
      (r) =>
        r.regionId === 'near-region' && r.architectureMode === 'm0_covered_joint_seam_colocated',
    )!;
    expect(nearColocated.isApprovedM0Contract).toBe(true);
    expect(nearColocated.successCount).toBe(3);
    expect(nearColocated.errorCount).toBe(0);
    expect(nearColocated.withinTargetAck250msP95).toBe(true);
    expect(nearColocated.withinTargetRuntime200msP95).toBe(true);
  });
});
