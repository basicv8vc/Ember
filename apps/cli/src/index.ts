import { runDemo, type DemoScenarioName } from './demo-runner.js';

function printHelp(): void {
  process.stdout.write(`
Ember P0-B Local Demo CLI

Usage:
  pnpm demo [options]

Options:
  --scenario <name>     Run a specific scenario: fast, standard, crash-resume, tenant-isolation, all (default: all)
  --database-url <url>  PostgreSQL connection string (defaults to DATABASE_URL or TEST_DATABASE_URL)
  --help, -h            Show this help message

Scenarios:
  fast              Scenario A: Fast path (no sandbox allocated, FakeLLM streaming output)
  standard          Scenario B: Standard path (FakeSandbox lifecycle, workspace CAS & artifact store)
  crash-resume      Scenario C: Simulated lease expiration, Checkpoint resume & fencing
  tenant-isolation  Scenario D: Multi-tenant boundary, zero-knowledge 404 & auth 401
\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let scenario: DemoScenarioName = 'all';
  let databaseUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--scenario' && i + 1 < args.length) {
      scenario = args[++i] as DemoScenarioName;
    }
    if (arg === '--database-url' && i + 1 < args.length) {
      databaseUrl = args[++i];
    }
  }

  const passed = await runDemo({ scenario, databaseUrl });
  process.exit(passed ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
