import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { calculateAdr0006Cost, runCostModelAnalysis } from './cost-model.js';
import { resolveBenchmarkGitSha } from './evidence.js';
import { runModelRoutingMatrix } from './model-routing-matrix.js';
import { runRttSimulation } from './rtt-simulation.js';
import { runSqliteProbe } from './sqlite-probe.js';
import { runTimingMethodology } from './timing-methodology.js';
import {
  runV2M1CostReestimation,
  runV2M1FullRuntimeBenchmark,
  runV2M1HarnessSmokeBenchmark,
  type V2M1CostReestimationReport,
  type V2M1FullRuntimeBenchmarkReport,
  type V2M1HarnessSmokeBenchmarkReport,
} from './v2-m1/m1-benchmark.js';
import type {
  CostModelOutput,
  CostSensitivityReport,
  ModelRoutingMatrixReport,
  RttSimulationReport,
  SqliteProbeReport,
  TimingMethodologyReport,
} from './v2-types.js';

export type V2BenchmarkSuiteName =
  | 'sqlite-probe'
  | 'timing'
  | 'rtt-sim'
  | 'cost-model'
  | 'model-routing'
  | 'm1-harness-smoke'
  | 'm1-cost-reestimate'
  | 'm1-full-runtime'
  | 'all';

export interface V2SuiteRunOptions {
  readonly suite: V2BenchmarkSuiteName;
  readonly outDir?: string;
  readonly databaseUrl?: string;
  readonly enableLocalLoad?: boolean;
  readonly concurrencyLevels?: readonly number[];
  readonly requestsPerLevel?: number;
  readonly probeIterations?: number;
  readonly rttSamples?: number;
  readonly seed?: number;
  readonly mau?: number;
  readonly allowanceRemainingRatio?: number;
  readonly doRowsWrittenPerEvent?: number;
  readonly doDurationSecPerEvent?: number;
  readonly deviceOffloadRate?: number;
  readonly log?: (message: string) => void;
}

export interface V2SuiteBundleResult {
  readonly scenarioId: 'ember-v2-m0-benchmark-bundle';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly suite: V2BenchmarkSuiteName;
  readonly sqliteProbe?: SqliteProbeReport;
  readonly timingMethodology?: TimingMethodologyReport;
  readonly rttSimulation?: RttSimulationReport;
  readonly costModel?: CostSensitivityReport;
  readonly customCostCalculation?: CostModelOutput;
  readonly modelRoutingMatrix?: ModelRoutingMatrixReport;
  readonly m1HarnessSmoke?: V2M1HarnessSmokeBenchmarkReport;
  readonly m1CostReestimation?: V2M1CostReestimationReport;
  readonly m1FullRuntime?: V2M1FullRuntimeBenchmarkReport;
}

/**
 * Execute one or all V2-M0-D benchmark suites and persist raw JSON artifacts.
 */
export async function runV2BenchmarkSuite(
  options: V2SuiteRunOptions,
): Promise<V2SuiteBundleResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const isM1Suite =
    options.suite === 'm1-harness-smoke' ||
    options.suite === 'm1-cost-reestimate' ||
    options.suite === 'm1-full-runtime';
  const outDir = options.outDir ?? (isM1Suite ? 'benchmarks/v2-m1' : 'benchmarks/v2-m0');
  mkdirSync(outDir, { recursive: true });

  const shouldRunM0 = (
    name: Exclude<
      V2BenchmarkSuiteName,
      'all' | 'm1-harness-smoke' | 'm1-cost-reestimate' | 'm1-full-runtime'
    >,
  ): boolean => options.suite === 'all' || options.suite === name;

  let sqliteProbe: SqliteProbeReport | undefined;
  let timingMethodology: TimingMethodologyReport | undefined;
  let rttSimulation: RttSimulationReport | undefined;
  let costModel: CostSensitivityReport | undefined;
  let customCostCalculation: CostModelOutput | undefined;
  let modelRoutingMatrix: ModelRoutingMatrixReport | undefined;
  let m1HarnessSmoke: V2M1HarnessSmokeBenchmarkReport | undefined;
  let m1CostReestimation: V2M1CostReestimationReport | undefined;
  let m1FullRuntime: V2M1FullRuntimeBenchmarkReport | undefined;

  if (shouldRunM0('sqlite-probe')) {
    sqliteProbe = await runSqliteProbe({
      ...(options.probeIterations !== undefined ? { iterations: options.probeIterations } : {}),
      log,
    });
    writeFileSync(
      path.join(outDir, 'sqlite-probe.json'),
      JSON.stringify(sqliteProbe, null, 2),
      'utf8',
    );
  }

  if (shouldRunM0('timing')) {
    timingMethodology = await runTimingMethodology({
      ...(options.probeIterations !== undefined ? { turnIterations: options.probeIterations } : {}),
      log,
    });
    writeFileSync(
      path.join(outDir, 'timing-methodology.json'),
      JSON.stringify(timingMethodology, null, 2),
      'utf8',
    );
  }

  if (shouldRunM0('rtt-sim')) {
    rttSimulation = await runRttSimulation({
      ...(options.rttSamples !== undefined ? { samplesPerScenario: options.rttSamples } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      log,
    });
    writeFileSync(
      path.join(outDir, 'rtt-simulation.json'),
      JSON.stringify(rttSimulation, null, 2),
      'utf8',
    );
  }

  if (shouldRunM0('cost-model')) {
    costModel = runCostModelAnalysis();
    writeFileSync(path.join(outDir, 'cost-model.json'), JSON.stringify(costModel, null, 2), 'utf8');

    if (
      options.mau !== undefined ||
      options.allowanceRemainingRatio !== undefined ||
      options.doRowsWrittenPerEvent !== undefined ||
      options.doDurationSecPerEvent !== undefined ||
      options.deviceOffloadRate !== undefined
    ) {
      customCostCalculation = calculateAdr0006Cost({
        mau: options.mau ?? 1_000,
        ...(options.allowanceRemainingRatio !== undefined
          ? { allowanceRemainingRatio: options.allowanceRemainingRatio }
          : {}),
        ...(options.doRowsWrittenPerEvent !== undefined ||
        options.doDurationSecPerEvent !== undefined
          ? {
              perEvent: {
                ...(options.doRowsWrittenPerEvent !== undefined
                  ? { doRowsWrittenPerEvent: options.doRowsWrittenPerEvent }
                  : {}),
                ...(options.doDurationSecPerEvent !== undefined
                  ? { doBillableDurationSecPerEvent: options.doDurationSecPerEvent }
                  : {}),
              },
            }
          : {}),
        ...(options.deviceOffloadRate !== undefined
          ? { sandbox: { deviceOffloadRate: options.deviceOffloadRate } }
          : {}),
      });
      writeFileSync(
        path.join(outDir, 'cost-custom-run.json'),
        JSON.stringify(customCostCalculation, null, 2),
        'utf8',
      );
    }
  }

  if (shouldRunM0('model-routing')) {
    modelRoutingMatrix = runModelRoutingMatrix();
    writeFileSync(
      path.join(outDir, 'model-routing-matrix.json'),
      JSON.stringify(modelRoutingMatrix, null, 2),
      'utf8',
    );
  }

  if (options.suite === 'm1-harness-smoke') {
    m1HarnessSmoke = await runV2M1HarnessSmokeBenchmark(options.probeIterations ?? 15);
    writeFileSync(
      path.join(outDir, 'm1-harness-smoke.json'),
      JSON.stringify(m1HarnessSmoke, null, 2),
      'utf8',
    );
  }

  if (options.suite === 'm1-full-runtime') {
    m1FullRuntime = await runV2M1FullRuntimeBenchmark({
      configPath:
        process.env.EMBER_V2_RUNTIME_CONFIG ??
        'tests/integration/support/v2-m1-full-runtime/wrangler.jsonc',
      ...(options.concurrencyLevels !== undefined
        ? { concurrencyLevels: options.concurrencyLevels }
        : {}),
      ...(options.requestsPerLevel !== undefined
        ? { requestsPerLevel: options.requestsPerLevel }
        : {}),
      ...(options.enableLocalLoad !== undefined
        ? { enable1000AgentFeasibility: options.enableLocalLoad }
        : {}),
      log,
    });
    writeFileSync(
      path.join(outDir, 'm1-full-runtime.json'),
      JSON.stringify(m1FullRuntime, null, 2),
      'utf8',
    );
    const covStats = m1FullRuntime.measuredPerEventOps.coveredB1DurablePath;
    const uncovStats = m1FullRuntime.measuredPerEventOps.uncoveredB1DurablePath;
    m1CostReestimation = runV2M1CostReestimation({
      measuredAgentHeadRowsReadPerEvent: covStats.agentHeadRowsReadMean,
      measuredAgentHeadRowsWrittenPerEvent: covStats.agentHeadRowsWrittenMean,
      measuredGlobalBudgetRowsReadPerEvent: covStats.globalBudgetRowsReadPerTurn,
      measuredGlobalBudgetRowsWrittenPerEvent: covStats.globalBudgetRowsWrittenPerTurn,
      measuredD1WritesPerEvent: Number(
        (0.8 * covStats.d1RowsWrittenMean + 0.2 * uncovStats.d1RowsWrittenMean).toFixed(2),
      ),
      measuredQueueOpsPerEvent: covStats.queueSendsMean,
    });
    writeFileSync(
      path.join(outDir, 'm1-cost-reestimation.json'),
      JSON.stringify(m1CostReestimation, null, 2),
      'utf8',
    );
  }

  if (options.suite === 'm1-cost-reestimate') {
    m1CostReestimation = runV2M1CostReestimation();
    writeFileSync(
      path.join(outDir, 'm1-cost-reestimation.json'),
      JSON.stringify(m1CostReestimation, null, 2),
      'utf8',
    );
  }

  const bundle: V2SuiteBundleResult = {
    scenarioId: 'ember-v2-m0-benchmark-bundle',
    gitSha: resolveBenchmarkGitSha(),
    timestamp: new Date().toISOString(),
    suite: options.suite,
    ...(sqliteProbe !== undefined ? { sqliteProbe } : {}),
    ...(timingMethodology !== undefined ? { timingMethodology } : {}),
    ...(rttSimulation !== undefined ? { rttSimulation } : {}),
    ...(costModel !== undefined ? { costModel } : {}),
    ...(customCostCalculation !== undefined ? { customCostCalculation } : {}),
    ...(modelRoutingMatrix !== undefined ? { modelRoutingMatrix } : {}),
    ...(m1HarnessSmoke !== undefined ? { m1HarnessSmoke } : {}),
    ...(m1CostReestimation !== undefined ? { m1CostReestimation } : {}),
    ...(m1FullRuntime !== undefined ? { m1FullRuntime } : {}),
  };

  writeFileSync(
    path.join(outDir, isM1Suite ? `${options.suite}-bundle.json` : `v2-m0-${options.suite}.json`),
    JSON.stringify(bundle, null, 2),
    'utf8',
  );
  log(`[V2-M0 Bench] Artifacts saved under ${outDir}/`);

  return bundle;
}
