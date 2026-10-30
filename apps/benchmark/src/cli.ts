import { printConsoleSummary } from './report.js';
import { runBenchmark } from './runner.js';
import type { BenchmarkOptions } from './types.js';

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

Ember P0B-09C: Local Load Benchmark Runner

Options:
  --agents <n>              Number of persistent logical agents to create (default: 1000)
  --concurrency <n>         Max concurrent HTTP requests in flight (default: 100)
  --task-mix <mix>          Ratio of task kinds, e.g. "fast:70,standard:30" (default: "fast:70,standard:30")
  --warmup <n>              Warmup requests before benchmark measurement (default: 50)
  --total-requests, -n <n>  Total number of requests to execute (default: 1000)
  --duration <time>         Benchmark duration, e.g. "30s", "1m" (overrides total-requests)
  --seed <n>                Deterministic PRNG seed for reproducible run (default: 42)
  --out-dir <path>          Directory to save benchmark reports (default: "benchmarks/results")
  --database-url <url>      PostgreSQL database URL (defaults to TEST_DATABASE_URL or DATABASE_URL)
  --no-isolated-schema      Do not create an isolated schema, run on public schema
  --keep-db                 Do not drop the isolated test schema after benchmark completion
  --enable-local-load       Explicit flag required for heavy load (>50 agents or >20 concurrency)
  --worker-concurrency <n>  Worker execution concurrency slots (default: 100)
  --api-url <url>           External Ember API URL (if omitted, boots local ephemeral server)
  -h, --help                Show this help message
`);
}

function parseCliArgs(args: readonly string[]): BenchmarkOptions {
  const options: { -readonly [K in keyof BenchmarkOptions]?: BenchmarkOptions[K] } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--agents') {
      options.agents = parseInt(args[++i]!, 10);
    } else if (arg === '--concurrency') {
      options.concurrency = parseInt(args[++i]!, 10);
    } else if (arg === '--task-mix') {
      options.taskMix = args[++i]! as unknown as BenchmarkOptions['taskMix'];
    } else if (arg === '--warmup') {
      options.warmup = parseInt(args[++i]!, 10);
    } else if (arg === '--total-requests' || arg === '-n') {
      options.totalRequests = parseInt(args[++i]!, 10);
    } else if (arg === '--duration') {
      options.durationMs = parseDuration(args[++i]!);
    } else if (arg === '--seed') {
      options.seed = parseInt(args[++i]!, 10);
    } else if (arg === '--out-dir') {
      options.outDir = args[++i]!;
    } else if (arg === '--database-url') {
      options.databaseUrl = args[++i]!;
    } else if (arg === '--no-isolated-schema') {
      options.isolatedSchema = false;
    } else if (arg === '--keep-db') {
      options.keepDb = true;
    } else if (arg === '--enable-local-load') {
      options.enableLocalLoad = true;
    } else if (arg === '--worker-concurrency') {
      options.workerConcurrency = parseInt(args[++i]!, 10);
    } else if (arg === '--api-url') {
      options.apiUrl = args[++i]!;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  try {
    const result = await runBenchmark(options);
    printConsoleSummary(result);
    process.exit(0);
  } catch (error) {
    console.error('\nBenchmark execution failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void main();
