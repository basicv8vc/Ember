import { assertValidConcurrencyLevels } from './local-guard.js';
import { printConsoleSummary } from './report.js';
import { runBenchmark } from './runner.js';
import type { BenchmarkOptions } from './types.js';
import {
  runV2BenchmarkSuite,
  type V2BenchmarkSuiteName,
  type V2SuiteRunOptions,
} from './v2-suite.js';

const VALID_V2_SUITES = new Set<V2BenchmarkSuiteName>([
  'v1-baseline',
  'sqlite-probe',
  'timing',
  'rtt-sim',
  'cost-model',
  'model-routing',
  'all',
]);

function parseDuration(val: string): number {
  const match = val.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);
  if (!match) {
    const num = Number(val);
    if (!Number.isNaN(num)) return num;
    throw new Error(`invalid duration: "${val}"`);
  }
  const amount = parseFloat(match[1]!);
  const unit = (match[2] || 'ms').toLowerCase();
  if (unit === 's') return Math.round(amount * 1000);
  if (unit === 'm') return Math.round(amount * 60 * 1000);
  return Math.round(amount);
}

function printHelp(): void {
  console.log(`
Usage: pnpm bench:local [options]

Ember P0B-09C & V2-M0-D Benchmark Runner

Suite Selection:
  --suite <name>            Run a V2-M0-D suite instead of legacy load benchmark:
                            v1-baseline | sqlite-probe | timing | rtt-sim |
                            cost-model | model-routing | all

V1 Task Load Options (default mode):
  --agents <n>              Number of persistent logical agents to create (default: 1000)
  --concurrency <n>         Max concurrent HTTP requests in flight (default: 100)
  --task-mix <mix>          Ratio of task kinds, e.g. "fast:70,standard:30" (default: "fast:70,standard:30")
  --warmup <n>              Warmup requests before benchmark measurement (default: 50)
  --total-requests, -n <n>  Total number of requests to execute (default: 1000)
  --duration <time>         Benchmark duration, e.g. "30s", "1m" (overrides total-requests)
  --seed <n>                Deterministic PRNG seed for reproducible run (default: 42)
  --out-dir <path>          Directory to save benchmark reports (default: "benchmarks/results" or "benchmarks/v2-m0")
  --database-url <url>      PostgreSQL database URL (defaults to TEST_DATABASE_URL or DATABASE_URL)
  --no-isolated-schema      Do not create an isolated schema, run on public schema
  --keep-db                 Do not drop the isolated test schema after benchmark completion
  --enable-local-load       Explicit flag required for heavy load (>50 agents or >20 concurrency)
  --worker-concurrency <n>  Worker execution concurrency slots (default: 100)
  --disable-pg-sampling     Disable periodic PostgreSQL activity sampling (for A/B overhead analysis)
  --api-url <url>           External Ember API URL (if omitted, boots local ephemeral server)

V2-M0 Suite Options:
  --concurrency-levels <cs> Comma-separated concurrency levels for v1-baseline (default: "1,10,25,50")
  --requests-per-level <n>  Requests per concurrency level for v1-baseline (default: 40)
  --probe-iterations <n>    Iterations per operation for sqlite-probe / timing (default: 30)
  --rtt-samples <n>         Samples per region/mode for rtt-sim (default: 15)
  --mau <n>                 MAU parameter for cost-model custom calculation
  --allowance-ratio <f>     Remaining shared allowance fraction [0..1] for cost-model
  --do-write-rows <n>       Assumed DO SQLite rows written per event for cost-model
  --do-duration-s <n>       Assumed DO billable active seconds per event for cost-model
  --device-offload <f>      Device offload rate [0..1] for Daytona sandbox cost-model
  -h, --help                Show this help message
`);
}

interface ParsedCli {
  readonly suite?: V2BenchmarkSuiteName;
  readonly legacy: BenchmarkOptions;
  readonly v2: Omit<V2SuiteRunOptions, 'suite'>;
}

function parseCliArgs(args: readonly string[]): ParsedCli {
  const legacy: { -readonly [K in keyof BenchmarkOptions]?: BenchmarkOptions[K] } = {};
  const v2: {
    -readonly [K in keyof Omit<V2SuiteRunOptions, 'suite'>]?: Omit<V2SuiteRunOptions, 'suite'>[K];
  } = {};
  let suite: V2BenchmarkSuiteName | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--suite') {
      const val = args[++i] as V2BenchmarkSuiteName;
      if (!VALID_V2_SUITES.has(val)) {
        throw new Error(`invalid --suite "${val}"`);
      }
      suite = val;
    } else if (arg === '--agents') {
      legacy.agents = parseInt(args[++i]!, 10);
    } else if (arg === '--concurrency') {
      legacy.concurrency = parseInt(args[++i]!, 10);
    } else if (arg === '--task-mix') {
      legacy.taskMix = args[++i]! as unknown as BenchmarkOptions['taskMix'];
    } else if (arg === '--warmup') {
      legacy.warmup = parseInt(args[++i]!, 10);
    } else if (arg === '--total-requests' || arg === '-n') {
      legacy.totalRequests = parseInt(args[++i]!, 10);
    } else if (arg === '--duration') {
      legacy.durationMs = parseDuration(args[++i]!);
    } else if (arg === '--seed') {
      const s = parseInt(args[++i]!, 10);
      legacy.seed = s;
      v2.seed = s;
    } else if (arg === '--out-dir') {
      const dir = args[++i]!;
      legacy.outDir = dir;
      v2.outDir = dir;
    } else if (arg === '--database-url') {
      const db = args[++i]!;
      legacy.databaseUrl = db;
      v2.databaseUrl = db;
    } else if (arg === '--no-isolated-schema') {
      legacy.isolatedSchema = false;
    } else if (arg === '--keep-db') {
      legacy.keepDb = true;
    } else if (arg === '--enable-local-load') {
      legacy.enableLocalLoad = true;
      v2.enableLocalLoad = true;
    } else if (arg === '--worker-concurrency') {
      legacy.workerConcurrency = parseInt(args[++i]!, 10);
    } else if (arg === '--disable-pg-sampling') {
      legacy.disablePgSampling = true;
    } else if (arg === '--api-url') {
      legacy.apiUrl = args[++i]!;
    } else if (arg === '--concurrency-levels') {
      const raw = args[++i]!;
      const levels = raw.split(',').map((s) => {
        const trimmed = s.trim();
        if (!/^\d+$/.test(trimmed)) {
          throw new Error(`invalid --concurrency-levels entry "${trimmed}"`);
        }
        return Number(trimmed);
      });
      assertValidConcurrencyLevels(levels, 100);
      v2.concurrencyLevels = levels;
    } else if (arg === '--requests-per-level') {
      v2.requestsPerLevel = parseInt(args[++i]!, 10);
    } else if (arg === '--probe-iterations') {
      v2.probeIterations = parseInt(args[++i]!, 10);
    } else if (arg === '--rtt-samples') {
      v2.rttSamples = parseInt(args[++i]!, 10);
    } else if (arg === '--mau') {
      v2.mau = parseInt(args[++i]!, 10);
    } else if (arg === '--allowance-ratio') {
      v2.allowanceRemainingRatio = parseFloat(args[++i]!);
    } else if (arg === '--do-write-rows') {
      v2.doRowsWrittenPerEvent = parseFloat(args[++i]!);
    } else if (arg === '--do-duration-s') {
      v2.doDurationSecPerEvent = parseFloat(args[++i]!);
    } else if (arg === '--device-offload') {
      v2.deviceOffloadRate = parseFloat(args[++i]!);
    }
  }

  return {
    ...(suite !== undefined ? { suite } : {}),
    legacy,
    v2,
  };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  try {
    if (parsed.suite !== undefined) {
      const bundle = await runV2BenchmarkSuite({
        suite: parsed.suite,
        ...parsed.v2,
      });
      console.log(`\n[V2-M0 Bench] Completed suite "${parsed.suite}" (gitSha: ${bundle.gitSha})`);
      if (bundle.customCostCalculation) {
        console.log(
          `  Custom Cost Run (MAU=${bundle.customCostCalculation.input.mau}): Cloud=$${bundle.customCostCalculation.cloudRuntime.totalUsd}, Combined=$${bundle.customCostCalculation.combinedMonthlyUsd}`,
        );
      }
      process.exit(0);
    }

    const result = await runBenchmark(parsed.legacy);
    printConsoleSummary(result);
    process.exit(0);
  } catch (error) {
    console.error('\nBenchmark execution failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void main();
