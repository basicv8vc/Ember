import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CostSensitivityReport,
  ModelRoutingMatrixReport,
  RttSimulationReport,
  SqliteProbeReport,
  TimingMethodologyReport,
  V1BaselineReport,
} from '../../apps/benchmark/src/v2-types.js';

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS_DIR = path.join(ROOT, 'benchmarks/v2-m0');
const REPORT_PATH = path.join(ROOT, 'docs/architecture/v2-m0-benchmark-report.md');

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, filename), 'utf8')) as T;
}

describe('V2-M0-D Benchmark Report Reconciliation (Unit)', () => {
  it('reconciles report metrics verbatim against raw JSON artifacts', () => {
    const report = fs.readFileSync(REPORT_PATH, 'utf8');
    const v1 = readJson<V1BaselineReport>('v1-baseline.json');
    const probe = readJson<SqliteProbeReport>('sqlite-probe.json');
    const timing = readJson<TimingMethodologyReport>('timing-methodology.json');
    const rtt = readJson<RttSimulationReport>('rtt-simulation.json');
    const cost = readJson<CostSensitivityReport>('cost-model.json');
    const routing = readJson<ModelRoutingMatrixReport>('model-routing-matrix.json');

    expect(report).toContain(v1.gitSha);

    for (const row of v1.concurrencySweep) {
      expect(report).toContain(`${row.chatAckP50Ms.toFixed(2)} / ${row.chatAckP95Ms.toFixed(2)}`);
      expect(report).toContain(`${row.taskAckP50Ms.toFixed(2)} / ${row.taskAckP95Ms.toFixed(2)}`);
    }

    for (const stat of v1.dbMutationStats) {
      expect(report).toContain(`${stat.exactNetRowsPerOperation.toFixed(2)}`);
    }

    for (const cmp of probe.comparisonSummary) {
      expect(report).toContain(cmp.operation);
      expect(report).toContain(cmp.doRowsWrittenMean.toFixed(2));
      expect(report).toContain(cmp.d1RowsWrittenMean.toFixed(2));
    }
    for (const jop of probe.jointAbSeamOps) {
      expect(report).toContain(jop.operation);
      expect(report).toContain(jop.rowsWrittenMean.toFixed(2));
    }
    expect(report).toContain(`${probe.storageGrowth.doNetBytesPerTurn.toFixed(1)} bytes/turn`);

    expect(report).toContain(`**${timing.simplified2RpcMicrobenchmark.ackMs.p95Ms.toFixed(2)}**`);
    expect(report).toContain(`**${timing.jointAbSeamTiming.ackCoveredMs.p95Ms.toFixed(2)}**`);
    expect(report).toContain(
      `**${timing.jointAbSeamTiming.runtimeOverheadCoveredMs.p95Ms.toFixed(2)}**`,
    );
    expect(report).toContain(
      `**${timing.jointAbSeamTiming.runtimeOverheadUncoveredMs.p95Ms.toFixed(2)}**`,
    );

    const nearColocated = rtt.results.find(
      (r) =>
        r.regionId === 'near-region' && r.architectureMode === 'm0_covered_joint_seam_colocated',
    )!;
    expect(report).toContain(
      `${nearColocated.ackMs.p50Ms.toFixed(2)} / ${nearColocated.ackMs.p95Ms.toFixed(2)}`,
    );

    const tier10k = cost.adr0006ReferenceMatrix.find((r) => r.mau === 10_000)!;
    expect(report).toContain(`$${tier10k.fullAllowanceUsd.toFixed(2)}`);
    expect(report).toContain(`$${tier10k.zeroAllowanceUsd.toFixed(2)}`);

    for (const cand of routing.candidates) {
      expect(report).toContain(cand.routeId);
      if (cand.costPerSuccessfulTaskUsd !== null) {
        expect(report).toContain(`$${cand.costPerSuccessfulTaskUsd.toFixed(6)}`);
      }
    }
  });
});
