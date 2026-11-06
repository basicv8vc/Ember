import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  E2B_DEFAULT_NETWORK_POLICY_ID,
  E2B_INSTALLED_SDK_VERSION,
  E2B_PINNED_SDK_VERSION,
  E2BSandboxProvider,
  E2bSdkSandboxClient,
} from '@ember/sandbox-e2b';
import { buildBlockedE2bSmokeReport, E2bSmokeRunner, type E2bPriceTable } from './runner.js';
import { describeBlockedReason, sanitizeText, serializeSafeJson } from './sanitize.js';
import type { E2bSmokeEnvironment, E2bSmokeReport } from './types.js';

/** Distinct exit codes so CI can never mistake "blocked" for "passed". */
export const E2B_SMOKE_EXIT = {
  pass: 0,
  fail: 1,
  blocked: 3,
} as const;

export interface CliOutputStreams {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface ParsedE2bArgs {
  readonly template: string;
  readonly templateDigest: string;
  readonly execTimeoutMs: number;
  readonly readyDeadlineMs: number;
  readonly timeoutProbeMs: number;
  readonly networkPolicyId: string;
  readonly format: 'summary' | 'json' | 'both';
  readonly outPath: string | null;
  readonly sweepOrphans: boolean;
  readonly priceTable: E2bPriceTable | null;
}

const HELP = `Ember E2B Sandbox Smoke Harness (real remote run)

Usage:
  pnpm sandbox:smoke:e2b [options]

Requires:
  E2B_API_KEY in the environment. Without it the run is reported BLOCKED (exit 3)
  and no vendor call is attempted.

Options:
  --template <name>              E2B template name or id (default: base)
  --digest <value>               Digest bound to SandboxSpec.imageDigest (default: template name)
  --exec-timeout-ms <number>     Per-command timeout, 100..60000 (default: 20000)
  --ready-deadline-ms <number>   Readiness deadline, 1..60000 (default: 30000)
  --timeout-probe-ms <number>    Timeout probe budget (default: 2000)
  --network-policy <id>          Egress policy; only 'deny-all' is accepted (default: deny-all)
  --format <summary|json|both>   Output format (default: both)
  --json                         Shortcut for --format json
  --out <path>                   Also write the JSON report to a file
  --sweep-orphans                Before the run, kill sandboxes left over from earlier runs
  --price-per-vcpu-second <usd>  Optional price table for an estimated cost figure
  --price-per-gib-second <usd>   Optional price table for an estimated cost figure
  --price-note <text>            Provenance note stored with the estimate
  --help, -h                     Show this help
`;

function parsePositiveInt(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }

  const value = Number(raw.trim());

  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return null;
  }

  return value;
}

function parsePrice(raw: string): number | null {
  const value = Number(raw.trim());

  if (!Number.isFinite(value) || value < 0 || value > 1_000) {
    return null;
  }

  return value;
}

export function parseE2bArgs(
  args: readonly string[],
  output: CliOutputStreams,
): ParsedE2bArgs | null {
  let template = 'base';
  let templateDigest: string | null = null;
  let execTimeoutMs = 20_000;
  let readyDeadlineMs = 30_000;
  let timeoutProbeMs = 2_000;
  let networkPolicyId = E2B_DEFAULT_NETWORK_POLICY_ID;
  let format: 'summary' | 'json' | 'both' = 'both';
  let outPath: string | null = null;
  let sweepOrphans = false;
  let pricePerVcpuSecond: number | null = null;
  let pricePerGibSecond: number | null = null;
  let priceNote: string | null = null;

  let index = 0;

  const takeValue = (flag: string): string | null => {
    const next = args[index + 1];

    if (next === undefined || next.startsWith('-')) {
      output.writeStderr(`[ERROR] Missing value for ${flag}.\n`);
      return null;
    }

    index += 2;
    return next;
  };

  while (index < args.length) {
    const arg = args[index];

    if (arg === undefined) {
      break;
    }

    if (arg === '--help' || arg === '-h') {
      output.writeStdout(HELP);
      return null;
    }

    if (arg === '--json') {
      format = 'json';
      index += 1;
      continue;
    }

    if (arg === '--sweep-orphans') {
      sweepOrphans = true;
      index += 1;
      continue;
    }

    if (arg === '--template') {
      const value = takeValue('--template');

      if (value === null) {
        return null;
      }

      template = value;
      continue;
    }

    if (arg === '--digest') {
      const value = takeValue('--digest');

      if (value === null) {
        return null;
      }

      templateDigest = value;
      continue;
    }

    if (arg === '--format') {
      const value = takeValue('--format');

      if (value === null) {
        return null;
      }

      if (value !== 'summary' && value !== 'json' && value !== 'both') {
        output.writeStderr(`[ERROR] Invalid --format value "${value}".\n`);
        return null;
      }

      format = value;
      continue;
    }

    if (arg === '--out') {
      const value = takeValue('--out');

      if (value === null) {
        return null;
      }

      outPath = value;
      continue;
    }

    if (arg === '--network-policy') {
      const value = takeValue('--network-policy');

      if (value === null) {
        return null;
      }

      // Only the deny-all policy is available to this PoC: a smoke run must not be able to
      // open egress "just to see what happens".
      if (value !== 'deny-all') {
        output.writeStderr(
          `[ERROR] Only --network-policy deny-all is permitted for this PoC; "${value}" was refused.\n`,
        );
        return null;
      }

      networkPolicyId = value;
      continue;
    }

    if (arg === '--exec-timeout-ms') {
      const value = takeValue('--exec-timeout-ms');
      const parsed = value === null ? null : parsePositiveInt(value, 100, 60_000);

      if (parsed === null) {
        output.writeStderr('[ERROR] Invalid --exec-timeout-ms (100..60000).\n');
        return null;
      }

      execTimeoutMs = parsed;
      continue;
    }

    if (arg === '--ready-deadline-ms') {
      const value = takeValue('--ready-deadline-ms');
      const parsed = value === null ? null : parsePositiveInt(value, 1, 60_000);

      if (parsed === null) {
        output.writeStderr('[ERROR] Invalid --ready-deadline-ms (1..60000).\n');
        return null;
      }

      readyDeadlineMs = parsed;
      continue;
    }

    if (arg === '--timeout-probe-ms') {
      const value = takeValue('--timeout-probe-ms');
      const parsed = value === null ? null : parsePositiveInt(value, 100, 60_000);

      if (parsed === null) {
        output.writeStderr('[ERROR] Invalid --timeout-probe-ms (100..60000).\n');
        return null;
      }

      timeoutProbeMs = parsed;
      continue;
    }

    if (arg === '--price-per-vcpu-second') {
      const value = takeValue('--price-per-vcpu-second');
      const parsed = value === null ? null : parsePrice(value);

      if (parsed === null) {
        output.writeStderr('[ERROR] Invalid --price-per-vcpu-second.\n');
        return null;
      }

      pricePerVcpuSecond = parsed;
      continue;
    }

    if (arg === '--price-per-gib-second') {
      const value = takeValue('--price-per-gib-second');
      const parsed = value === null ? null : parsePrice(value);

      if (parsed === null) {
        output.writeStderr('[ERROR] Invalid --price-per-gib-second.\n');
        return null;
      }

      pricePerGibSecond = parsed;
      continue;
    }

    if (arg === '--price-note') {
      const value = takeValue('--price-note');

      if (value === null) {
        return null;
      }

      priceNote = value;
      continue;
    }

    output.writeStderr(`[ERROR] Unrecognized argument "${arg}". Run with --help.\n`);
    return null;
  }

  const priceTable =
    pricePerVcpuSecond !== null && pricePerGibSecond !== null
      ? {
          usdPerVcpuSecond: pricePerVcpuSecond,
          usdPerGiBSecond: pricePerGibSecond,
          note: priceNote ?? 'operator-supplied price table; not a vendor invoice',
        }
      : null;

  return {
    template,
    templateDigest: templateDigest ?? template,
    execTimeoutMs,
    readyDeadlineMs,
    timeoutProbeMs,
    networkPolicyId,
    format,
    outPath,
    sweepOrphans,
    priceTable,
  };
}

function readSdkVersion(): string {
  return E2B_INSTALLED_SDK_VERSION;
}

function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 6);
}

export function buildEnvironment(
  params: { template: string; templateDigest: string },
  apiKey: string | null,
): E2bSmokeEnvironment {
  return {
    sdkVersion: readSdkVersion(),
    pinnedSdkVersion: E2B_PINNED_SDK_VERSION,
    template: params.template,
    templateDigest: params.templateDigest,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    apiKeyPresent: apiKey !== null && apiKey.trim() !== '',
    apiKeyFingerprint: apiKey === null || apiKey.trim() === '' ? null : keyFingerprint(apiKey),
  };
}

export function formatMeasurementTable(report: E2bSmokeReport): string {
  const { measurements, timing, usage, cost, cleanup, isolation } = report;
  const fmt = (value: number | null, suffix = 'ms'): string =>
    value === null ? 'NOT_MEASURED' : `${value.toFixed(2)} ${suffix}`;

  const lines: string[] = [
    '================================================================================',
    'Ember E2B Sandbox Smoke Harness (Real Remote)',
    '================================================================================',
    `Schema Version:        ${report.schemaVersion}`,
    `Test ID:               ${report.testId}`,
    `Provider / Mode:       ${report.provider} / ${report.mode}`,
    `Status:                ${report.status}`,
    `Template:              ${report.environment.template}`,
    `SDK:                   ${report.environment.sdkVersion} (pinned ${report.environment.pinnedSdkVersion})`,
    `Runtime:               ${report.environment.nodeVersion} on ${report.environment.platform}`,
    `API Key:               ${report.environment.apiKeyPresent ? `present (fp ${report.environment.apiKeyFingerprint})` : 'absent'}`,
    '',
    '--- Step Results ---',
  ];

  for (const step of Object.values(report.steps)) {
    const extra = step.error ? ` [ERROR: ${step.error}]` : '';
    const duration = step.durationMs === null ? 'n/a' : `${step.durationMs.toFixed(2)} ms`;
    lines.push(`• ${step.step.padEnd(15)}: ${step.status.padEnd(7)} (${duration})${extra}`);
  }

  lines.push(
    '',
    '--- Measurement Table ---',
    `Create latency:            ${fmt(measurements.createLatencyMs)}`,
    `Ready latency:             ${fmt(measurements.readyLatencyMs)}`,
    `First command latency:     ${fmt(measurements.firstCommandLatencyMs)}`,
    `Warm command latency:      ${fmt(measurements.secondCommandLatencyMs)}`,
    `Stop latency:              ${fmt(measurements.stopLatencyMs)}`,
    `Destroy latency:           ${fmt(measurements.destroyLatencyMs)}`,
    `Cleanup verify latency:    ${fmt(timing.cleanupVerifyLatencyMs)}`,
    `Total wall clock:          ${fmt(timing.totalWallMs)}`,
    '',
    '--- Timeout Behaviour ---',
    `Requested timeout:         ${fmt(measurements.timeoutProbe.requestedTimeoutMs)}`,
    `Observed elapsed:          ${fmt(measurements.timeoutProbe.observedElapsedMs)}`,
    `Overshoot:                 ${fmt(measurements.timeoutProbe.overshootMs)}`,
    `Observed exit code:        ${measurements.timeoutProbe.observedExitCode ?? 'NOT_MEASURED'}`,
    '',
    '--- Resources ---',
    `Requested:                 ${measurements.requestedCpuMilli ?? 'n/a'} mCPU / ${measurements.requestedMemoryMiB ?? 'n/a'} MiB`,
    `Allocated (vendor):        ${measurements.allocatedCpuCount ?? 'n/a'} vCPU / ${measurements.allocatedMemoryMiB ?? 'n/a'} MiB`,
    `Sandbox lifetime:          ${measurements.sandboxLifetimeSec ?? 'n/a'} s`,
    '',
    '--- Usage & Cost ---',
    `Usage basis:               ${usage.basis}`,
    `CPU seconds:               ${usage.usage?.cpuSeconds ?? 'NOT_MEASURED'}`,
    `Memory GiB*seconds:        ${usage.usage?.memoryGiBSeconds ?? 'NOT_MEASURED'}`,
    `Egress bytes:              ${usage.egressBytes ?? 'NOT_MEASURED'} (source: ${usage.egressSource})`,
    `Estimated sandbox USD:     ${cost.estimatedSandboxUsd ?? 'NOT_MEASURED'} (source: ${cost.source})`,
    `Actual billed USD:         ${cost.actualBilledUsd ?? 'NOT_MEASURED (E2B console required)'}`,
    `Remaining credit USD:      ${cost.remainingCreditUsd ?? 'NOT_MEASURED (E2B console required)'}`,
    '',
    '--- Isolation ---',
    `Network policy:            ${isolation.networkPolicyId ?? 'n/a'}`,
    `Requested allow internet:  ${isolation.requestedAllowInternetAccess ?? 'n/a'}`,
    `Observed allow internet:   ${isolation.observedAllowInternetAccess ?? 'NOT_MEASURED'}`,
    `Egress denied as expected: ${isolation.egressDeniedAsExpected ?? 'NOT_MEASURED'}`,
  );

  for (const probe of isolation.egressProbes) {
    lines.push(
      `  • ${probe.target.padEnd(34)} port ${probe.port}: connected=${probe.connected ?? 'unknown'} (${probe.failureClass ?? 'n/a'})`,
    );
  }

  lines.push(
    '',
    '--- Cleanup ---',
    `Stop / Destroy:            ${cleanup.stopStatus} / ${cleanup.destroyStatus}`,
    `Resource verification:     ${cleanup.resourceVerification}`,
    `Leak status:               ${cleanup.leakStatus}`,
    `Live sandbox ids:          ${cleanup.liveSandboxIds.length === 0 ? 'none' : cleanup.liveSandboxIds.join(', ')}`,
  );

  if (report.blockedReason) {
    lines.push('', `[BLOCKED]: ${report.blockedReason}`);
  }

  if (report.error) {
    lines.push('', `[ERROR]: ${report.error}`);
  }

  lines.push('', '--- Limitations ---');

  for (const limitation of report.limitations) {
    lines.push(`• ${limitation}`);
  }

  lines.push('================================================================================');

  return lines.join('\n');
}

export async function runE2bCli(
  args: readonly string[],
  output: CliOutputStreams = {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseE2bArgs(args, output);

  if (parsed === null) {
    return args.includes('--help') || args.includes('-h')
      ? E2B_SMOKE_EXIT.pass
      : E2B_SMOKE_EXIT.fail;
  }

  const apiKey = typeof env.E2B_API_KEY === 'string' ? env.E2B_API_KEY : null;
  const environment = buildEnvironment(
    { template: parsed.template, templateDigest: parsed.templateDigest },
    apiKey,
  );

  const emit = (report: E2bSmokeReport): void => {
    if (parsed.format === 'summary' || parsed.format === 'both') {
      output.writeStdout(`${formatMeasurementTable(report)}\n`);
    }

    if (parsed.format === 'both') {
      output.writeStdout('\n--- Machine-Readable JSON Report ---\n');
    }

    if (parsed.format === 'json' || parsed.format === 'both') {
      output.writeStdout(`${serializeSafeJson(report)}\n`);
    }

    if (parsed.outPath !== null) {
      writeFileSync(resolve(parsed.outPath), `${serializeSafeJson(report)}\n`, 'utf8');
      output.writeStderr(`[INFO] report written to ${parsed.outPath}\n`);
    }
  };

  // Preflight 1: SDK pin. A drifted SDK invalidates every measurement, so refuse to run.
  if (environment.sdkVersion !== environment.pinnedSdkVersion) {
    const reason = `${describeBlockedReason('sdk-version')} (installed ${environment.sdkVersion}, pinned ${environment.pinnedSdkVersion})`;
    const report = buildBlockedE2bSmokeReport(environment, reason);
    emit(report);
    return E2B_SMOKE_EXIT.blocked;
  }

  // Preflight 2: credential. Blocked, never "failed", and never a simulated result.
  if (apiKey === null || apiKey.trim() === '') {
    const report = buildBlockedE2bSmokeReport(environment, describeBlockedReason('missing-key'));
    emit(report);
    return E2B_SMOKE_EXIT.blocked;
  }

  const client = new E2bSdkSandboxClient({ apiKey, requestTimeoutMs: 30_000 });
  const provider = new E2BSandboxProvider({
    tenantId: randomUUID(),
    client,
    template: parsed.template,
    templateDigest: parsed.templateDigest,
  });

  if (parsed.sweepOrphans) {
    try {
      const killed = await provider.sweepOrphanedSandboxes();
      output.writeStderr(`[INFO] orphan sweep killed ${killed.length} sandbox(es)\n`);
    } catch (error) {
      output.writeStderr(`[WARN] orphan sweep failed: ${sanitizeText(String(error))}\n`);
    }
  }

  const runner = new E2bSmokeRunner(provider);

  let report: E2bSmokeReport;

  try {
    report = await runner.run({
      environment,
      readyDeadlineMs: parsed.readyDeadlineMs,
      execTimeoutMs: parsed.execTimeoutMs,
      timeoutProbeMs: parsed.timeoutProbeMs,
      networkPolicyId: parsed.networkPolicyId,
      ...(parsed.priceTable === null ? {} : { priceTable: parsed.priceTable }),
    });
  } catch (error) {
    const aborted = buildBlockedE2bSmokeReport(
      environment,
      `harness aborted before completing the run: ${sanitizeText(String(error))}`,
    );
    report = { ...aborted, status: 'FAIL' };
    emit(report);
    return E2B_SMOKE_EXIT.fail;
  }

  emit(report);

  return report.status === 'PASS' ? E2B_SMOKE_EXIT.pass : E2B_SMOKE_EXIT.fail;
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryArg = process.argv[1];

if (
  entryArg &&
  (resolve(entryArg) === currentFilePath || entryArg.endsWith('sandbox-smoke-e2b/cli.ts'))
) {
  void runE2bCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      process.stderr.write(`[FATAL ERROR]: ${sanitizeText(String(error))}\n`);
      process.exit(E2B_SMOKE_EXIT.fail);
    });
}
