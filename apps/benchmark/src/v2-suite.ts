import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { calculateAdr0006Cost, runCostModelAnalysis } from './cost-model.js';
import { resolveBenchmarkGitSha } from './evidence.js';
import { runModelRoutingMatrix } from './model-routing-matrix.js';
import { runRttSimulation } from './rtt-simulation.js';
import { runSqliteProbe } from './sqlite-probe.js';
import { runTimingMethodology } from './timing-methodology.js';
import { runV1BaselineBenchmark } from './v1-baseline.js';
import type {
  CostModelOutput,
  CostSensitivityReport,
  ModelRoutingMatrixReport,
  RttSimulationReport,
  SqliteProbeReport,
  TimingMethodologyReport,
  V1BaselineReport,
} from './v2-types.js';

export type V2BenchmarkSuiteName =
  'v1-baseline' | 'sqlite-probe' | 'timing' | 'rtt-sim' | 'cost-model' | 'model-routing' | 'all';

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
  readonly v1Baseline?: V1BaselineReport;
  readonly sqliteProbe?: SqliteProbeReport;
  readonly timingMethodology?: TimingMethodologyReport;
  readonly rttSimulation?: RttSimulationReport;
  readonly costModel?: CostSensitivityReport;
  readonly customCostCalculation?: CostModelOutput;
  readonly modelRoutingMatrix?: ModelRoutingMatrixReport;
}

/**
 * Execute one or all V2-M0-D benchmark suites and persist raw JSON artifacts.
 */
export async function runV2BenchmarkSuite(
  options: V2SuiteRunOptions,
): Promise<V2SuiteBundleResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const outDir = options.outDir ?? 'benchmarks/v2-m0';
  mkdirSync(outDir, { recursive: true });

  const shouldRun = (name: Exclude<V2BenchmarkSuiteName, 'all'>): boolean =>
    options.suite === 'all' || options.suite === name;

  let v1Baseline: V1BaselineReport | undefined;
  let sqliteProbe: SqliteProbeReport | undefined;
  let timingMethodology: TimingMethodologyReport | undefined;
  let rttSimulation: RttSimulationReport | undefined;
  let costModel: CostSensitivityReport | undefined;
  let customCostCalculation: CostModelOutput | undefined;
  let modelRoutingMatrix: ModelRoutingMatrixReport | undefined;

  if (shouldRun('v1-baseline')) {
    v1Baseline = await runV1BaselineBenchmark({
      ...(options.databaseUrl !== undefined ? { databaseUrl: options.databaseUrl } : {}),
      ...(options.enableLocalLoad !== undefined
        ? { enableLocalLoad: options.enableLocalLoad }
        : {}),
      ...(options.concurrencyLevels !== undefined
        ? { concurrencyLevels: options.concurrencyLevels }
        : {}),
      ...(options.requestsPerLevel !== undefined
        ? { requestsPerLevel: options.requestsPerLevel }
        : {}),
      log,
    });
    writeFileSync(
      path.join(outDir, 'v1-baseline.json'),
      JSON.stringify(v1Baseline, null, 2),
      'utf8',
    );
  }

  if (shouldRun('sqlite-probe')) {
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

  if (shouldRun('timing')) {
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

  if (shouldRun('rtt-sim')) {
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

  if (shouldRun('cost-model')) {
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

  if (shouldRun('model-routing')) {
    modelRoutingMatrix = runModelRoutingMatrix();
    writeFileSync(
      path.join(outDir, 'model-routing-matrix.json'),
      JSON.stringify(modelRoutingMatrix, null, 2),
      'utf8',
    );
  }

  const bundle: V2SuiteBundleResult = {
    scenarioId: 'ember-v2-m0-benchmark-bundle',
    gitSha: resolveBenchmarkGitSha(),
    timestamp: new Date().toISOString(),
    suite: options.suite,
    ...(v1Baseline !== undefined ? { v1Baseline } : {}),
    ...(sqliteProbe !== undefined ? { sqliteProbe } : {}),
    ...(timingMethodology !== undefined ? { timingMethodology } : {}),
    ...(rttSimulation !== undefined ? { rttSimulation } : {}),
    ...(costModel !== undefined ? { costModel } : {}),
    ...(customCostCalculation !== undefined ? { customCostCalculation } : {}),
    ...(modelRoutingMatrix !== undefined ? { modelRoutingMatrix } : {}),
  };

  writeFileSync(
    path.join(outDir, `v2-m0-${options.suite}.json`),
    JSON.stringify(bundle, null, 2),
    'utf8',
  );
  log(`[V2-M0 Bench] Artifacts saved under ${outDir}/`);

  return bundle;
}
