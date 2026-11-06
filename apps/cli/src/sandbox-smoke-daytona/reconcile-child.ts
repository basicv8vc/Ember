#!/usr/bin/env node
/**
 * Standalone orphan reconciler.
 *
 * Invoked as a **separate OS process** by the smoke harness so that the crash-recovery claim
 * is made against a process that shares no memory with the one that created the sandbox. It is
 * also the shape a restarted worker would use at boot, before accepting new work.
 */
import { DaytonaSdkSandboxClient, sweepOrphanedSandboxes } from '@ember/sandbox-daytona';

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<number> {
  const apiKey = process.env.DAYTONA_API_KEY?.trim();

  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write('reconciler: DAYTONA_API_KEY is not set\n');
    return 3;
  }

  const owner = readFlag('owner');
  const tenantId = readFlag('tenant');

  if (owner === undefined || tenantId === undefined) {
    process.stderr.write('reconciler: --owner and --tenant are required\n');
    return 2;
  }

  const rawMinAge = readFlag('min-age-ms');
  const minAgeMs = rawMinAge === undefined ? 30_000 : Number.parseInt(rawMinAge, 10);

  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
    process.stderr.write(`reconciler: invalid --min-age-ms ${String(rawMinAge)}\n`);
    return 2;
  }

  const apiUrl = readFlag('api-url');
  const target = readFlag('target');

  const client = new DaytonaSdkSandboxClient({
    apiKey,
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(target === undefined ? {} : { target }),
  });

  const result = await sweepOrphanedSandboxes({
    client,
    owner,
    tenantId,
    minAgeMs,
    keepSandboxIds: [],
  });

  process.stdout.write(`${JSON.stringify({ processId: String(process.pid), result })}\n`);

  return result.failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `reconciler: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
    );
    process.exitCode = 1;
  });
