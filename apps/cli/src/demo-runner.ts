import { DemoCluster } from './cluster.js';
import { runCrashResumeScenario } from './scenarios/crash-resume.js';
import { runFastScenario } from './scenarios/fast.js';
import { runStandardScenario } from './scenarios/standard.js';
import { runTenantIsolationScenario } from './scenarios/tenant-isolation.js';
import { DemoUI, type ScenarioResult } from './ui.js';

export type DemoScenarioName = 'fast' | 'standard' | 'crash-resume' | 'tenant-isolation' | 'all';

export interface DemoRunnerOptions {
  readonly scenario?: DemoScenarioName;
  readonly databaseUrl?: string;
  readonly quiet?: boolean;
}

export async function runDemo(options: DemoRunnerOptions = {}): Promise<boolean> {
  const ui = new DemoUI({ quiet: options.quiet });
  const scenarioName = options.scenario ?? 'all';

  ui.banner('Ember P0-B Local Demo CLI — Full Real HTTP + Worker Closed Loop');

  let cluster: DemoCluster | undefined;
  const results: ScenarioResult[] = [];

  try {
    process.stdout.write(
      '  Initializing isolated PostgreSQL schema and local loopback API/Worker cluster ... ',
    );
    cluster = await DemoCluster.start({ databaseUrl: options.databaseUrl });
    process.stdout.write(`READY (${cluster.apiUrl})\n`);

    if (scenarioName === 'all' || scenarioName === 'fast') {
      const res = await runFastScenario(cluster, ui);
      results.push(res);
    }

    if (scenarioName === 'all' || scenarioName === 'standard') {
      const res = await runStandardScenario(cluster, ui);
      results.push(res);
    }

    if (scenarioName === 'all' || scenarioName === 'crash-resume') {
      const res = await runCrashResumeScenario(cluster, ui);
      results.push(res);
    }

    if (scenarioName === 'all' || scenarioName === 'tenant-isolation') {
      const res = await runTenantIsolationScenario(cluster, ui);
      results.push(res);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n❌ Fatal demo error: ${message}\n`);
    return false;
  } finally {
    if (cluster) {
      process.stdout.write(
        '\n  Gracefully tearing down local demo cluster, dropping schema and temp blobs ... ',
      );
      await cluster.stop();
      process.stdout.write('DONE\n');
    }
  }

  return ui.summary(results);
}
