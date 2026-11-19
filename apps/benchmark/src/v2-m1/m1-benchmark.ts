import { calculateAdr0006Cost } from '../cost-model.js';
import { resolveBenchmarkGitSha } from '../evidence.js';
import { calculateDistribution } from '../metrics.js';
import { DEFAULT_REGIONAL_RTT_PROFILES } from '../rtt-simulation.js';
import type { LatencyDistribution } from '../types.js';
import type { CostModelOutput, RegionalRttProfile } from '../v2-types.js';
import { resolveAbRuntimeTarget } from './acceptance-matrix.js';
import { V2LocalRuntimeHarness } from './local-runtime-harness.js';
import { assertValidConcurrencyLevels } from './local-v2-guard.js';

export const V2_M1_ENGINEERING_TARGETS = Object.freeze({
  nearRegionAckP95Ms: 250,
  runtimeOverheadP95Ms: 200,
  globalBudgetCheckP95Ms: 50, // reserve + authorize cumulative critical path, inside runtimeOverhead
  coveredPathSyncD1Io: 0,
  duplicateCommitCount: 0,
  silentTaskLossCount: 0,
  unauthorizedBudgetReserveCount: 0,
});

export interface DistributionSummaryWithRates {
  readonly sampleCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly successRate: number;
  readonly errorRate: number;
  readonly latencyMs: LatencyDistribution;
}

export interface V2M1HarnessSmokeBenchmarkReport {
  readonly scenarioId: 'ember-v2-m1-harness-smoke-benchmark';
  readonly evidenceKind: 'harness_infra_smoke_only';
  readonly abFullRuntimeStatus: 'blocked_awaiting_ab_m1';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly wranglerVersion: string;
  readonly engineeringTargets: typeof V2_M1_ENGINEERING_TARGETS;
  readonly localHarnessMeasurements: {
    readonly doPing: DistributionSummaryWithRates;
    readonly globalBudgetCheck: DistributionSummaryWithRates;
    readonly d1Lookup: DistributionSummaryWithRates;
    readonly fakeGatewayComplete: DistributionSummaryWithRates;
    readonly fakeGatewayStreamSse: DistributionSummaryWithRates;
    readonly queueEnqueue: DistributionSummaryWithRates;
    readonly scheduledCron: DistributionSummaryWithRates;
  };
  readonly pendingAbFullRuntimeMetrics: readonly string[];
  readonly pendingCloudCanaryMetrics: readonly string[];
}

export interface V2M1CostReestimationRow {
  readonly label: string;
  readonly mau: number;
  readonly doRowsWrittenPerEvent: number;
  readonly doRowsReadPerEvent: number;
  readonly d1WritesPerEvent: number;
  readonly independentRecoveryEnabled: boolean;
  readonly monthsElapsed: number;
  readonly dormantRetainedRatio: number;
  readonly cloudRuntimeUsd: number;
  readonly cloudMonthlyBreakdown: CostModelOutput['cloudRuntime'];
}

export interface V2M1CostReestimationReport {
  readonly scenarioId: 'ember-v2-m1-cost-reestimation';
  readonly evidenceKind: 'estimated_adr0006_formula';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly fixed20RowsConstraintEnforced: false;
  readonly note: string;
  readonly rows: readonly V2M1CostReestimationRow[];
}

export interface V2M1FullRuntimeBenchmarkOptions {
  readonly configPath?: string;
  readonly concurrencyLevels?: readonly number[];
  readonly requestsPerLevel?: number;
  readonly enable1000AgentFeasibility?: boolean;
  readonly regionalProfiles?: readonly RegionalRttProfile[];
}

function summarize(
  latencies: readonly number[],
  successCount: number,
  errorCount: number,
): DistributionSummaryWithRates {
  const sampleCount = successCount + errorCount;
  return {
    sampleCount,
    successCount,
    errorCount,
    successRate: sampleCount > 0 ? Number((successCount / sampleCount).toFixed(4)) : 0,
    errorRate: sampleCount > 0 ? Number((errorCount / sampleCount).toFixed(4)) : 0,
    latencyMs: calculateDistribution(latencies),
  };
}

async function measureLoop(
  iterations: number,
  fn: (i: number) => Promise<boolean>,
): Promise<DistributionSummaryWithRates> {
  const latencies: number[] = [];
  let ok = 0;
  let err = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      const success = await fn(i);
      latencies.push(performance.now() - t0);
      if (success) ok += 1;
      else err += 1;
    } catch {
      latencies.push(performance.now() - t0);
      err += 1;
    }
  }
  return summarize(latencies, ok, err);
}

/**
 * Run a real local `workerd` infrastructure benchmark against the V2 M1 Harness smoke target.
 * Explicitly tagged `harness_infra_smoke_only` — never replaces full A/B E2E runtime measurements.
 */
export async function runV2M1HarnessSmokeBenchmark(
  iterations = 15,
): Promise<V2M1HarnessSmokeBenchmarkReport> {
  const harness = await V2LocalRuntimeHarness.start({
    target: { kind: 'harness_smoke' },
  });

  try {
    // Warmup
    await harness.fetch('/harness-smoke/do?agent=warmup');
    await harness.fetch('/harness-smoke/budget');
    await harness.fetch('/harness-smoke/d1');

    const doPing = await measureLoop(iterations, async (i) => {
      const r = await harness.fetch(`/harness-smoke/do?agent=smoke-${i % 4}`);
      return r.ok;
    });

    const globalBudgetCheck = await measureLoop(iterations, async () => {
      const r = await harness.fetch('/harness-smoke/budget');
      return r.ok;
    });

    const d1Lookup = await measureLoop(iterations, async () => {
      const r = await harness.fetch('/harness-smoke/d1');
      return r.ok;
    });

    const fakeGatewayComplete = await measureLoop(iterations, async (i) => {
      const res = await fetch(`${harness.fakeGateway.url}/v2/fake-model/complete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ember-operation-id': `smoke-op-${i}`,
        },
        body: JSON.stringify({ prompt: `Smoke prompt #${i}` }),
      });
      await res.arrayBuffer();
      return res.ok;
    });

    const fakeGatewayStreamSse = await measureLoop(iterations, async (i) => {
      const res = await fetch(`${harness.fakeGateway.url}/v2/fake-model/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ember-operation-id': `smoke-stream-op-${i}`,
        },
        body: JSON.stringify({ prompt: `Stream smoke prompt #${i}`, stream: true }),
      });
      await res.text();
      return res.ok;
    });

    const queueEnqueue = await measureLoop(iterations, async (i) => {
      const res = await harness.fetchJson('/harness-smoke/queue', {
        queue: i % 2 === 0 ? 'durable_turn' : 'agent_task',
        payload: { smokeIter: i },
      });
      return res.status === 200;
    });

    const scheduledCron = await measureLoop(Math.min(5, iterations), async () => {
      const res = await harness.triggerScheduled(Date.now(), '* * * * *');
      return res.outcome === 'ok';
    });

    return {
      scenarioId: 'ember-v2-m1-harness-smoke-benchmark',
      evidenceKind: 'harness_infra_smoke_only',
      abFullRuntimeStatus: 'blocked_awaiting_ab_m1',
      gitSha: resolveBenchmarkGitSha(),
      timestamp: new Date().toISOString(),
      wranglerVersion: harness.wranglerVersion,
      engineeringTargets: V2_M1_ENGINEERING_TARGETS,
      localHarnessMeasurements: {
        doPing,
        globalBudgetCheck,
        d1Lookup,
        fakeGatewayComplete,
        fakeGatewayStreamSse,
        queueEnqueue,
        scheduledCron,
      },
      pendingAbFullRuntimeMetrics: [
        '3-RPC Fast Path Covered ACK & Uncovered ACK (P50/P95/P99/Max)',
        'Runtime Overhead excluding FakeModelGateway wait time (target P95 <= 200ms)',
        'GlobalBudgetDO reserveGlobal + authorizeGlobalSend cumulative critical path (target P95 <= 50ms)',
        'Streaming SSE CPU & wall-clock duration across Edge API Worker + DO',
        'Actual A/B AgentHeadDO + GlobalBudgetDO SQLite rowsRead / rowsWritten per event',
        'Actual D1 v2_recovery_registry reads/writes & Queue delivery/retry amplification',
        'Concurrency sweep (1/10/25/50) & 1,000 Agent / 100 concurrency feasibility on full A/B runtime',
      ],
      pendingCloudCanaryMetrics: [
        ...DEFAULT_REGIONAL_RTT_PROFILES.map(
          (p) => `Cloud Canary validation for region ${p.regionId} (${p.label})`,
        ),
        'Real DO hibernation wakeup latency, real Workers CPU billing, and Cloudflare billing invoice reconciliation',
      ],
    };
  } finally {
    await harness.dispose();
  }
}

/**
 * Re-estimate ADR-0006 monthly runtime budgets across realistic observed/modeled row amplification
 * vectors without enforcing 20 rows/event as a hard constraint.
 */
export function runV2M1CostReestimation(): V2M1CostReestimationReport {
  const scenarios: Array<{
    readonly label: string;
    readonly mau: number;
    readonly doRowsWrittenPerEvent: number;
    readonly doRowsReadPerEvent: number;
    readonly d1WritesPerEvent: number;
    readonly independentRecoveryEnabled: boolean;
    readonly monthsElapsed: number;
    readonly dormantRetainedRatio: number;
  }> = [
    {
      label: 'adr0006_planning_20rows_1k',
      mau: 1_000,
      doRowsWrittenPerEvent: 20,
      doRowsReadPerEvent: 200,
      d1WritesPerEvent: 0.2,
      independentRecoveryEnabled: false,
      monthsElapsed: 0,
      dormantRetainedRatio: 0,
    },
    {
      label: 'm0_joint_seam_31rows_recovery_1k',
      mau: 1_000,
      doRowsWrittenPerEvent: 31,
      doRowsReadPerEvent: 220,
      d1WritesPerEvent: 1.0,
      independentRecoveryEnabled: true,
      monthsElapsed: 6,
      dormantRetainedRatio: 1.0,
    },
    {
      label: 'adr0006_planning_20rows_10k',
      mau: 10_000,
      doRowsWrittenPerEvent: 20,
      doRowsReadPerEvent: 200,
      d1WritesPerEvent: 0.2,
      independentRecoveryEnabled: false,
      monthsElapsed: 0,
      dormantRetainedRatio: 0,
    },
    {
      label: 'm0_joint_seam_31rows_recovery_10k',
      mau: 10_000,
      doRowsWrittenPerEvent: 31,
      doRowsReadPerEvent: 220,
      d1WritesPerEvent: 1.0,
      independentRecoveryEnabled: true,
      monthsElapsed: 6,
      dormantRetainedRatio: 1.0,
    },
    {
      label: 'uncoalesced_45rows_recovery_10k',
      mau: 10_000,
      doRowsWrittenPerEvent: 45,
      doRowsReadPerEvent: 280,
      d1WritesPerEvent: 2.0,
      independentRecoveryEnabled: true,
      monthsElapsed: 12,
      dormantRetainedRatio: 2.0,
    },
    {
      label: 'm0_joint_seam_31rows_recovery_100k',
      mau: 100_000,
      doRowsWrittenPerEvent: 31,
      doRowsReadPerEvent: 220,
      d1WritesPerEvent: 1.0,
      independentRecoveryEnabled: true,
      monthsElapsed: 6,
      dormantRetainedRatio: 1.0,
    },
    {
      label: 'uncoalesced_45rows_recovery_100k',
      mau: 100_000,
      doRowsWrittenPerEvent: 45,
      doRowsReadPerEvent: 280,
      d1WritesPerEvent: 2.0,
      independentRecoveryEnabled: true,
      monthsElapsed: 12,
      dormantRetainedRatio: 2.0,
    },
  ];

  const rows: V2M1CostReestimationRow[] = scenarios.map((s) => {
    const out = calculateAdr0006Cost({
      mau: s.mau,
      perEvent: {
        doRowsWrittenPerEvent: s.doRowsWrittenPerEvent,
        doRowsReadPerEvent: s.doRowsReadPerEvent,
        d1RowsWrittenPerEvent: s.d1WritesPerEvent,
      },
      independentRecovery: {
        enabled: s.independentRecoveryEnabled,
        d1WritesPerEvent: s.d1WritesPerEvent,
      },
      storageGrowth: {
        monthsElapsed: s.monthsElapsed,
        dormantRetainedRatio: s.dormantRetainedRatio,
      },
    });
    return {
      label: s.label,
      mau: s.mau,
      doRowsWrittenPerEvent: s.doRowsWrittenPerEvent,
      doRowsReadPerEvent: s.doRowsReadPerEvent,
      d1WritesPerEvent: s.d1WritesPerEvent,
      independentRecoveryEnabled: s.independentRecoveryEnabled,
      monthsElapsed: s.monthsElapsed,
      dormantRetainedRatio: s.dormantRetainedRatio,
      cloudRuntimeUsd: out.cloudRuntime.totalUsd,
      cloudMonthlyBreakdown: out.cloudRuntime,
    };
  });

  return {
    scenarioId: 'ember-v2-m1-cost-reestimation',
    evidenceKind: 'estimated_adr0006_formula',
    gitSha: resolveBenchmarkGitSha(),
    timestamp: new Date().toISOString(),
    fixed20RowsConstraintEnforced: false,
    note: 'ADR-0006 20 rows/event is treated purely as a planning assumption, not a fixed engineering constraint. Real M1 SQLite rowsRead/rowsWritten from A/B AgentHeadDO + GlobalBudgetDO will replace the 31/45-row placeholder vectors once A/B runtime merges.',
    rows,
  };
}

/**
 * Entry point for full A/B V2 M1 Runtime performance & cost measurement (D3).
 * Refuses to execute synthetic/probe substitutes when A/B's M1 runtime is not yet merged.
 */
export function runV2M1FullRuntimeBenchmark(
  options: V2M1FullRuntimeBenchmarkOptions = {},
): Promise<never> {
  const levels = options.concurrencyLevels ?? [1, 10, 25, 50];
  assertValidConcurrencyLevels(levels, 100);

  const resolved = options.configPath
    ? { available: true, configPath: options.configPath, reason: 'explicit' }
    : resolveAbRuntimeTarget();

  if (!resolved.available || resolved.configPath === null) {
    return Promise.reject(
      new Error(
        `D3 Full Runtime Benchmark is blocked: ${resolved.reason} M0 probes are never substituted for full A/B E2E measurements.`,
      ),
    );
  }

  return Promise.reject(
    new Error(
      `Full A/B Runtime D3 runner expects A/B HTTP/SSE endpoints at ${resolved.configPath}; wire exact A/B B1/V2 HTTP routes once A/B M1 PR lands.`,
    ),
  );
}
