import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeSandboxProvider } from '@ember/execution';
import { SandboxSmokeRunner } from './runner.js';
import { formatSanitizedError, serializeSafeJson } from './sanitize.js';
import type { SmokeReport } from './types.js';

export const KNOWN_CLOUD_PROVIDERS = ['cloudflare', 'e2b', 'daytona', 'boat'] as const;

function parseStrictTimeoutMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const val = Number(trimmed);
  if (!Number.isSafeInteger(val) || val < 100 || val > 60_000) {
    return null;
  }
  return val;
}

export interface CliOutputStreams {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface ParsedCliArgs {
  readonly provider: 'fake';
  readonly timeoutMs: number;
  readonly format: 'summary' | 'json' | 'both';
}

export function parseCliArgs(
  args: readonly string[],
  output: CliOutputStreams,
): ParsedCliArgs | null {
  let provider = 'fake';
  let timeoutMs = 10_000;
  let format: 'summary' | 'json' | 'both' = 'both';

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }

    if (arg === '--help' || arg === '-h') {
      output.writeStdout(
        `Ember Sandbox Local Smoke Harness

Usage:
  pnpm sandbox:smoke:local [options]

Options:
  --provider <name>       Sandbox provider to test (default: fake; cloud providers are NOT_MEASURED)
  --timeout-ms <number>   Timeout in milliseconds (100 to 60000, default: 10000)
  --format <type>         Output format: 'summary', 'json', or 'both' (default: both)
  --json                  Shortcut for --format json
  --help, -h              Display this help message
`,
      );
      return null;
    }

    if (arg === '--json') {
      format = 'json';
      i += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      const val = arg.slice('--format='.length);
      if (val === 'json' || val === 'summary' || val === 'both') {
        format = val;
        i += 1;
        continue;
      }
      output.writeStderr(
        `[ERROR] Invalid --format value: "${val}". Must be 'summary', 'json', or 'both'.\n`,
      );
      return null;
    }

    if (arg === '--format') {
      const next = args[i + 1];
      if (next === 'json' || next === 'summary' || next === 'both') {
        format = next;
        i += 2;
        continue;
      }
      output.writeStderr(
        `[ERROR] Invalid --format value: "${next}". Must be 'summary', 'json', or 'both'.\n`,
      );
      return null;
    }

    if (arg.startsWith('--provider=')) {
      provider = arg.slice('--provider='.length);
      i += 1;
      continue;
    }

    if (arg === '--provider') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        output.writeStderr('[ERROR] Missing value for --provider.\n');
        return null;
      }
      provider = next;
      i += 2;
      continue;
    }

    if (arg.startsWith('--timeout-ms=') || arg.startsWith('--timeout=')) {
      const prefix = arg.startsWith('--timeout-ms=') ? '--timeout-ms=' : '--timeout=';
      const raw = arg.slice(prefix.length);
      const val = parseStrictTimeoutMs(raw);
      if (val === null) {
        output.writeStderr(
          `[ERROR] Invalid timeout value "${raw}": must be an integer between 100 and 60000 ms.\n`,
        );
        return null;
      }
      timeoutMs = val;
      i += 1;
      continue;
    }

    if (arg === '--timeout-ms' || arg === '--timeout') {
      const next = args[i + 1];
      const val = next !== undefined ? parseStrictTimeoutMs(next) : null;
      if (val === null) {
        output.writeStderr(
          `[ERROR] Invalid timeout value "${next}": must be an integer between 100 and 60000 ms.\n`,
        );
        return null;
      }
      timeoutMs = val;
      i += 2;
      continue;
    }

    output.writeStderr(
      `[ERROR] Unrecognized argument "${arg}". Run with --help for supported options.\n`,
    );
    return null;
  }

  // Validate provider selection
  if (provider === 'fake') {
    return { provider: 'fake', timeoutMs, format };
  }

  if ((KNOWN_CLOUD_PROVIDERS as readonly string[]).includes(provider)) {
    output.writeStderr(
      `[ERROR] Provider "${provider}" is NOT_MEASURED in local smoke harness. Candidate cloud backends require external credentials, budget authorizations, and isolation review. Zero network calls or implicit fallbacks were executed.\n`,
    );
    return null;
  }

  output.writeStderr(
    `[ERROR] Unknown provider "${provider}". Local smoke harness only accepts "fake". Cloud candidates (cloudflare, e2b, daytona, boat) are NOT_MEASURED.\n`,
  );
  return null;
}

export function formatHumanSummary(report: SmokeReport): string {
  const lines: string[] = [
    '================================================================================',
    'Ember Sandbox Smoke Harness (Local Fake Simulation)',
    '================================================================================',
    `Schema Version:        ${report.schemaVersion}`,
    `Test ID:               ${report.testId}`,
    `Provider:              ${report.provider}`,
    `Mode:                  ${report.mode}`,
    `Status:                ${report.status}`,
    `Total Wall Clock:      ${report.timing.totalWallMs.toFixed(2)} ms`,
    '',
    '--- Lifecycle Phases ---',
  ];

  for (const [phase, detail] of Object.entries(report.phases)) {
    const extra = detail.error ? ` [ERROR: ${detail.error}]` : '';
    lines.push(
      `• ${phase.padEnd(16)}: ${detail.status.padEnd(7)} (${detail.durationMs.toFixed(2)} ms)${extra}`,
    );
  }

  lines.push(
    '',
    '--- Resource & Telemetry Footprint ---',
    `Usage Source:          ${report.usageSource}`,
    `CPU Seconds:           ${report.usage?.cpuSeconds.toFixed(6) ?? 'null'}`,
    `Memory GiB*Seconds:    ${report.usage?.memoryGiBSeconds.toFixed(6) ?? 'null'}`,
    `Egress Bytes:          ${report.usage?.egressBytes ?? 'null'}`,
    '',
    '--- Security & Measurement Boundaries ---',
    `Real Isolation:        ${report.realIsolationStatus} (Process memory isolation only; no VM/container)`,
    `Vendor Cold Start:     ${report.vendorColdStartMs ?? 'NOT_MEASURED (null)'}`,
    `Vendor Cost:           ${report.vendorCostUsd ?? 'NOT_MEASURED (null)'}`,
    `Cost Source:           ${report.costSource}`,
    '',
    '--- Cleanup Status ---',
    `Stop Status:           ${report.cleanup.stopStatus}`,
    `Destroy Status:        ${report.cleanup.destroyStatus}`,
    `Resource Verification: ${report.cleanup.resourceVerification}`,
    `Leak Status:           ${report.cleanup.leakStatus}`,
    `Sandbox Stopped:       ${report.cleanup.stopSucceeded}`,
    `Sandbox Destroyed:     ${report.cleanup.destroySucceeded}`,
    `Resources Leaked:      ${report.cleanup.resourcesLeaked}`,
  );

  if (report.cleanup.stopError) {
    lines.push(`Stop Error:            ${report.cleanup.stopError}`);
  }
  if (report.cleanup.destroyError) {
    lines.push(`Destroy Error:         ${report.cleanup.destroyError}`);
  }

  if (report.error) {
    lines.push('', `[RUN FAILURE]:         ${report.error}`);
  }

  lines.push('', '--- Important Limitations ---');
  for (const limitation of report.limitations) {
    lines.push(`• ${limitation}`);
  }
  lines.push('================================================================================');

  return lines.join('\n');
}

export async function runCli(
  args: readonly string[],
  output: CliOutputStreams = {
    writeStdout: (t) => process.stdout.write(t),
    writeStderr: (t) => process.stderr.write(t),
  },
): Promise<number> {
  const parsed = parseCliArgs(args, output);
  if (parsed === null) {
    // If help was printed (--help was passed), return 0.
    if (args.includes('--help') || args.includes('-h')) {
      return 0;
    }
    return 1;
  }

  try {
    const tenantId = randomUUID();
    const provider = new FakeSandboxProvider({ tenantId });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run({
      tenantId,
      timeoutMs: parsed.timeoutMs,
    });

    if (parsed.format === 'summary' || parsed.format === 'both') {
      output.writeStdout(`${formatHumanSummary(report)}\n`);
    }

    if (parsed.format === 'both') {
      output.writeStdout('\n--- Machine-Readable JSON Report ---\n');
    }

    if (parsed.format === 'json' || parsed.format === 'both') {
      output.writeStdout(`${serializeSafeJson(report)}\n`);
    }

    return report.status === 'PASS' ? 0 : 1;
  } catch (err) {
    output.writeStderr(`[FATAL ERROR]: ${formatSanitizedError(err)}\n`);
    return 1;
  }
}

// Direct CLI execution guard
const currentFilePath = fileURLToPath(import.meta.url);
const entryArg = process.argv[1];
if (
  entryArg &&
  (resolve(entryArg) === currentFilePath || entryArg.endsWith('sandbox-smoke/cli.ts'))
) {
  void runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`[FATAL ERROR]: ${formatSanitizedError(err)}\n`);
      process.exit(1);
    });
}
