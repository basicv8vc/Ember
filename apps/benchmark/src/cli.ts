import { assertValidConcurrencyLevels } from './local-guard.js';
import {
  runV2BenchmarkSuite,
  type V2BenchmarkSuiteName,
  type V2SuiteRunOptions,
} from './v2-suite.js';

const VALID_V2_SUITES = new Set<V2BenchmarkSuiteName>([
  'sqlite-probe',
  'timing',
  'rtt-sim',
  'cost-model',
  'model-routing',
  'm1-harness-smoke',
  'm1-cost-reestimate',
  'm1-full-runtime',
  'all',
]);

function printHelp(): void {
  console.log(`
Usage: pnpm bench:local --suite <name> [options]

Ember V2 Benchmark Runner

Suite Selection:
  --suite <name>            Run a V2-M0-D or V2-M1-D suite (default: m1-harness-smoke):
                            sqlite-probe | timing | rtt-sim |
                            cost-model | model-routing | m1-harness-smoke |
                            m1-cost-reestimate | m1-full-runtime | all

V2 Suite Options:
  --seed <n>                Deterministic PRNG seed for reproducible run (default: 42)
  --out-dir <path>          Directory to save benchmark reports
  --enable-local-load       Explicit flag required for heavy load
  --concurrency-levels <cs> Comma-separated concurrency levels
  --requests-per-level <n>  Requests per concurrency level
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
  readonly suite: V2BenchmarkSuiteName;
  readonly v2: Omit<V2SuiteRunOptions, 'suite'>;
}

function parseCliArgs(args: readonly string[]): ParsedCli {
  const v2: {
    -readonly [K in keyof Omit<V2SuiteRunOptions, 'suite'>]?: Omit<V2SuiteRunOptions, 'suite'>[K];
  } = {};
  let suite: V2BenchmarkSuiteName = 'm1-harness-smoke';

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
    } else if (arg === '--seed') {
      v2.seed = parseInt(args[++i]!, 10);
    } else if (arg === '--out-dir') {
      v2.outDir = args[++i]!;
    } else if (arg === '--enable-local-load') {
      v2.enableLocalLoad = true;
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

  return { suite, v2 };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  try {
    const bundle = await runV2BenchmarkSuite({
      suite: parsed.suite,
      ...parsed.v2,
    });
    console.log(`\n[V2 Bench] Completed suite "${parsed.suite}" (gitSha: ${bundle.gitSha})`);
    if (bundle.customCostCalculation) {
      console.log(
        `  Custom Cost Run (MAU=${bundle.customCostCalculation.input.mau}): Cloud=$${bundle.customCostCalculation.cloudRuntime.totalUsd}, Combined=$${bundle.customCostCalculation.combinedMonthlyUsd}`,
      );
    }
    process.exit(0);
  } catch (error) {
    console.error('\nBenchmark execution failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void main();
