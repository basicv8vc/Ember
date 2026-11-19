import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRttSimulation } from '../../apps/benchmark/src/rtt-simulation.js';
import { runSqliteProbe } from '../../apps/benchmark/src/sqlite-probe.js';
import { runTimingMethodology } from '../../apps/benchmark/src/timing-methodology.js';
import { runV1BaselineBenchmark } from '../../apps/benchmark/src/v1-baseline.js';

describe('V2-M0-D Probes & V1 Baseline (Integration)', () => {
  it('runs the isolated local workerd DO SQLite vs D1 probe with non-zero read/write/alarm/storage measurements', async () => {
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

    const doPrepare = report.operations.find(
      (op) => op.engine === 'do_sqlite' && op.operation === 'normal_turn_prepare',
    );
    expect(doPrepare).toBeDefined();
    expect(doPrepare!.logicalStatementsPerOp).toBeGreaterThanOrEqual(6);
    expect(doPrepare!.logicalMutationsPerOp).toBeGreaterThanOrEqual(5);
    expect(doPrepare!.observedRowsReadMean).toBeGreaterThan(0);
    expect(doPrepare!.observedRowsWrittenMean).toBeGreaterThan(0);
    expect(doPrepare!.setAlarmCallsPerOp).toBe(1);

    const d1Prepare = report.operations.find(
      (op) => op.engine === 'd1_local' && op.operation === 'normal_turn_prepare',
    );
    expect(d1Prepare).toBeDefined();
    expect(d1Prepare!.observedRowsWrittenMean).toBeGreaterThan(0);
  });

  it('measures timing methodology including fail-closed global budget check under contention', async () => {
    const timing = await runTimingMethodology({
      turnIterations: 6,
      streamIterations: 2,
      budgetContentionConcurrency: 8,
      log: () => undefined,
    });

    expect(timing.localTurnTiming.ackMs.p95Ms).toBeGreaterThan(0);
    expect(timing.localTurnTiming.runtimeOverheadMs.p95Ms).toBeGreaterThanOrEqual(
      timing.localTurnTiming.ackMs.p95Ms,
    );

    const failClosed = timing.budgetCheckContention.results.find(
      (r) => r.mode === 'exhaustion_fail_closed',
    );
    expect(failClosed).toBeDefined();
    expect(failClosed!.approvedCount).toBe(10);
    expect(failClosed!.rejectedCount).toBe(10);
    expect(failClosed!.overCommitted).toBe(false);
  });

  it('executes deterministic regional RTT simulation across near and cross-region profiles', async () => {
    const rtt = await runRttSimulation({
      samplesPerScenario: 3,
      concurrency: 3,
      seed: 7,
      log: () => undefined,
    });

    expect(rtt.evidenceKind).toBe('simulated_synthetic');
    const nearCovered = rtt.results.find(
      (r) => r.regionId === 'near-region' && r.architectureMode === 'covered_preallocated_grant',
    );
    expect(nearCovered).toBeDefined();
    expect(nearCovered!.meetsAck250msP95).toBe(true);
    expect(nearCovered!.meetsRuntime200msP95).toBe(true);
  });

  it('measures local V1 baseline (B1 chat, tasks, status reads, and PG logical mutations)', async () => {
    const tempOutDir = mkdtempSync(path.join(os.tmpdir(), 'ember-v1-baseline-test-'));
    try {
      const baseline = await runV1BaselineBenchmark({
        concurrencyLevels: [1, 4],
        requestsPerLevel: 4,
        workerConcurrency: 4,
        enableLocalLoad: false,
        log: () => undefined,
      });

      expect(baseline.scenarioId).toBe('ember-v2-m0-v1-baseline');
      expect(baseline.evidenceKind).toBe('measured_local_pg');
      expect(baseline.concurrencySweep).toHaveLength(2);
      expect(baseline.conversationBenchmarks.length).toBeGreaterThanOrEqual(4);
      expect(baseline.taskBenchmarks.length).toBeGreaterThanOrEqual(4);
      expect(baseline.statusReadBenchmarks.length).toBeGreaterThanOrEqual(4);
      expect(baseline.dbMutationStats.length).toBeGreaterThanOrEqual(4);
      expect(baseline.dbMutationStats[0]!.totalLogicalMutations).toBeGreaterThan(0);
    } finally {
      rmSync(tempOutDir, { recursive: true, force: true });
    }
  });
});
