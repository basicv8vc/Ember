#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DAYTONA_INSTALLED_SDK_VERSION,
  DAYTONA_PINNED_SDK_VERSION,
  DAYTONA_SANDBOX_PROFILES,
  DaytonaSdkSandboxClient,
  type DaytonaSandboxClient,
  type DaytonaSandboxProfile,
} from '@ember/sandbox-daytona';

import { apiHostOf, redactSecret, sanitizeText } from './sanitize.js';
import {
  DaytonaSmokeRunner,
  validateDaytonaSmokeReport,
  type DaytonaReconcileOutcome,
} from './runner.js';
import {
  DAYTONA_SMOKE_EXIT,
  DAYTONA_SMOKE_STEPS,
  type DaytonaSmokeEnvironment,
  type DaytonaSmokeReport,
  type DaytonaSmokeStepDetail,
} from './types.js';

const execFileAsync = promisify(execFile);

export interface DaytonaCliStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface DaytonaCliDeps {
  readonly createClient?: (options: {
    apiKey: string;
    apiUrl?: string;
    target?: string;
  }) => DaytonaSandboxClient;
  readonly reconcile?: (input: {
    owner: string;
    tenantId: string;
  }) => Promise<DaytonaReconcileOutcome>;
  readonly clock?: () => number;
}

interface ParsedArgs {
  readonly profileId: string;
  readonly format: 'json' | 'summary' | 'both';
  readonly outPath: string | null;
  readonly jsonOutPath: string | null;
  readonly lifetimeSec: number;
  readonly execTimeoutMs: number;
  readonly owner: string;
  readonly apiUrl: string | undefined;
  readonly target: string | undefined;
}

const DEFAULT_API_URL = 'https://app.daytona.io/api';

/**
 * Daytona smoke entry point.
 *
 * Exits 3 (`BLOCKED`) when the environment cannot produce a real measurement. It never falls
 * back to synthetic numbers: an unmeasured run is reported as unmeasured.
 */
export async function runDaytonaCli(
  argv: readonly string[],
  streams: DaytonaCliStreams,
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: DaytonaCliDeps = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  const profile = resolveProfile(parsed.profileId);
  const apiKey = env.DAYTONA_API_KEY?.trim();
  const apiUrl = parsed.apiUrl ?? env.DAYTONA_API_URL ?? DEFAULT_API_URL;
  const target = parsed.target ?? env.DAYTONA_TARGET;

  const environment = buildEnvironment({
    profile,
    profileId: parsed.profileId,
    owner: parsed.owner,
    apiUrl,
    target,
  });

  if (apiKey === undefined || apiKey.length === 0) {
    const report = buildBlockedReport(
      environment,
      'DAYTONA_API_KEY is not set; no vendor call was attempted and no measurement exists',
    );
    emit(report, parsed, streams);

    return DAYTONA_SMOKE_EXIT.blocked;
  }

  if (DAYTONA_INSTALLED_SDK_VERSION !== DAYTONA_PINNED_SDK_VERSION) {
    const report = buildBlockedReport(
      environment,
      `installed @daytonaio/sdk is ${DAYTONA_INSTALLED_SDK_VERSION} but the adapter is pinned to ${DAYTONA_PINNED_SDK_VERSION}; latency measurements would not describe the reviewed transport`,
    );
    emit(report, parsed, streams);

    return DAYTONA_SMOKE_EXIT.blocked;
  }

  const client = (deps.createClient ?? defaultCreateClient)({
    apiKey,
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(target === undefined ? {} : { target }),
  });

  const runner = new DaytonaSmokeRunner({
    client,
    environment,
    snapshot: profile.snapshot,
    sandboxClass: profile.sandboxClass,
    diskGiB: profile.diskGiB,
    owner: parsed.owner,
    lifetimeSec: parsed.lifetimeSec,
    execTimeoutMs: parsed.execTimeoutMs,
    reconcile: deps.reconcile ?? defaultReconcile(apiUrl, target),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });

  let report: DaytonaSmokeReport;

  try {
    report = await runner.run();
  } catch (error) {
    report = buildBlockedReport(
      environment,
      `harness aborted before producing a report: ${redactSecret(String(error), apiKey)}`,
    );
    emit(report, parsed, streams);

    return DAYTONA_SMOKE_EXIT.fail;
  }

  const problems = validateDaytonaSmokeReport(report);

  for (const problem of problems) {
    streams.stderr(`report validation: ${problem}\n`);
  }

  const finalReport: DaytonaSmokeReport =
    problems.length === 0
      ? report
      : {
          ...report,
          status: 'FAIL',
          findings: [...report.findings, ...problems.map((problem) => `validation: ${problem}`)],
        };

  emit(finalReport, parsed, streams);

  return finalReport.status === 'PASS' ? DAYTONA_SMOKE_EXIT.pass : DAYTONA_SMOKE_EXIT.fail;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined) {
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`);
    }

    const [rawKey, inlineValue] = splitFlag(token);
    const next = argv[index + 1];

    if (inlineValue === undefined && next !== undefined && !next.startsWith('--')) {
      values.set(rawKey, next);
      index += 1;
    } else if (inlineValue !== undefined) {
      values.set(rawKey, inlineValue);
    } else {
      flags.add(rawKey);
    }
  }

  const format = values.get('format') ?? (flags.has('json') ? 'json' : 'both');

  if (format !== 'json' && format !== 'summary' && format !== 'both') {
    throw new Error(`unsupported --format: ${format}`);
  }

  return {
    profileId: values.get('profile') ?? 'container-small',
    format,
    outPath: values.get('out') ?? null,
    jsonOutPath: values.get('json-out') ?? null,
    lifetimeSec: parseInteger(values.get('lifetime-sec'), 120, 10, 120),
    execTimeoutMs: parseInteger(values.get('exec-timeout-ms'), 30_000, 100, 60_000),
    owner: values.get('owner') ?? `daytona-poc:${randomUUID().slice(0, 8)}`,
    apiUrl: values.get('api-url'),
    target: values.get('target'),
  };
}

function splitFlag(token: string): [string, string | undefined] {
  const withoutPrefix = token.slice(2);
  const equals = withoutPrefix.indexOf('=');

  if (equals === -1) {
    return [withoutPrefix, undefined];
  }

  return [withoutPrefix.slice(0, equals), withoutPrefix.slice(equals + 1)];
}

function parseInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`value out of range: ${raw} (expected ${min}..${max})`);
  }

  return parsed;
}

function resolveProfile(profileId: string): DaytonaSandboxProfile {
  const profile = DAYTONA_SANDBOX_PROFILES[profileId];

  if (profile === undefined) {
    throw new Error(
      `unknown profile ${profileId}; expected one of ${Object.keys(DAYTONA_SANDBOX_PROFILES).join(', ')}`,
    );
  }

  return profile;
}

function defaultCreateClient(options: {
  apiKey: string;
  apiUrl?: string;
  target?: string;
}): DaytonaSandboxClient {
  return new DaytonaSdkSandboxClient(options);
}

/**
 * Runs the orphan sweep in a genuinely separate OS process.
 *
 * This is the only form of the crash-recovery test worth reporting: an in-process sweep would
 * still have the adapter's own maps available, which is precisely what a restarted worker does
 * not have.
 */
function defaultReconcile(
  apiUrl: string | undefined,
  target: string | undefined,
): (input: { owner: string; tenantId: string }) => Promise<DaytonaReconcileOutcome> {
  return async (input) => {
    const scriptPath = fileURLToPath(new URL('./reconcile-child.ts', import.meta.url));
    const args = [
      '--import',
      'tsx',
      scriptPath,
      '--owner',
      input.owner,
      '--tenant',
      input.tenantId,
      // No grace period: the orphan was created seconds ago and is provably unclaimed.
      '--min-age-ms',
      '0',
      ...(apiUrl === undefined ? [] : ['--api-url', apiUrl]),
      ...(target === undefined ? [] : ['--target', target]),
    ];

    const { stdout } = await execFileAsync(process.execPath, args, {
      env: process.env,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const payload = parseChildOutput(stdout);

    return {
      swept: payload.result.destroyed.length,
      failures: payload.result.failed.length,
      processId: payload.processId,
      elapsedMs: payload.result.elapsedMs,
    };
  };
}

interface ChildPayload {
  readonly processId: string;
  readonly result: {
    readonly destroyed: readonly string[];
    readonly failed: readonly unknown[];
    readonly elapsedMs: number;
  };
}

function parseChildOutput(stdout: string): ChildPayload {
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'));

  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as Partial<ChildPayload>;

      if (typeof parsed.processId === 'string' && parsed.result !== undefined) {
        return parsed as ChildPayload;
      }
    } catch {
      // Not the payload line; keep looking.
    }
  }

  throw new Error('reconciler child process produced no parsable result');
}

function buildEnvironment(input: {
  profile: DaytonaSandboxProfile;
  profileId: string;
  owner: string;
  apiUrl: string;
  target: string | undefined;
}): DaytonaSmokeEnvironment {
  return {
    sdkVersion: DAYTONA_INSTALLED_SDK_VERSION,
    pinnedSdkVersion: DAYTONA_PINNED_SDK_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    apiHost: apiHostOf(input.apiUrl),
    target: input.target ?? null,
    snapshot: input.profile.snapshot,
    sandboxClass: input.profile.sandboxClass,
    profileId: input.profileId,
    owner: input.owner,
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    tierNote:
      'tier is a dashboard fact, not an API field; new accounts are Tier 1 (10 vCPU / 10 GiB) with vendor-restricted egress',
    startedAt: new Date().toISOString(),
  };
}

function buildBlockedReport(
  environment: DaytonaSmokeEnvironment,
  reason: string,
): DaytonaSmokeReport {
  const steps = {} as Record<string, DaytonaSmokeStepDetail>;

  for (const step of DAYTONA_SMOKE_STEPS) {
    steps[step] = { step, status: 'SKIP', durationMs: 0 };
  }

  const now = new Date().toISOString();

  return {
    schemaVersion: '1.0',
    status: 'BLOCKED',
    blockedReason: sanitizeText(reason),
    startedAt: environment.startedAt,
    finishedAt: now,
    elapsedMs: 0,
    environment,
    steps: steps as DaytonaSmokeReport['steps'],
    measurements: null,
    isolation: null,
    cleanup: null,
    usage: null,
    cost: null,
    limits: {
      requestedCpu: 1,
      requestedMemoryMiB: 1_024,
      maxLifetimeSec: 120,
      vendorTtlMinutes: 2,
      idleStopMinutes: 2,
      concurrencyCap: 2,
    },
    findings: [],
  };
}

function emit(report: DaytonaSmokeReport, parsed: ParsedArgs, streams: DaytonaCliStreams): void {
  if (parsed.format !== 'json') {
    streams.stdout(renderSummary(report));
  }

  if (parsed.format !== 'summary') {
    streams.stdout(`${JSON.stringify(report, null, 2)}\n`);
  }

  if (parsed.outPath !== null) {
    writeArtifact(parsed.outPath, renderSummary(report));
  }

  if (parsed.jsonOutPath !== null) {
    writeArtifact(parsed.jsonOutPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}

function writeArtifact(path: string, content: string): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function renderSummary(report: DaytonaSmokeReport): string {
  const lines: string[] = [];
  const divider = '─'.repeat(72);

  lines.push(divider);
  lines.push(`Daytona sandbox smoke — ${report.status}`);
  lines.push(divider);
  lines.push(`profile      ${report.environment.profileId}`);
  lines.push(
    `snapshot     ${report.environment.snapshot} (class ${report.environment.sandboxClass})`,
  );
  lines.push(
    `sdk          ${report.environment.sdkVersion} (pinned ${report.environment.pinnedSdkVersion})`,
  );
  lines.push(`api host     ${report.environment.apiHost}`);
  lines.push(`owner        ${report.environment.owner}`);
  lines.push(`elapsed      ${(report.elapsedMs / 1_000).toFixed(1)}s`);
  lines.push(`fingerprint  ${reportFingerprint(report)}`);

  if (report.blockedReason !== undefined) {
    lines.push('');
    lines.push(`BLOCKED: ${report.blockedReason}`);
  }

  lines.push('');
  lines.push('steps');

  for (const step of DAYTONA_SMOKE_STEPS) {
    const detail = report.steps[step];
    const marker = detail.status === 'PASS' ? 'PASS' : detail.status;
    lines.push(`  ${step.padEnd(22)} ${marker.padEnd(6)} ${detail.durationMs}ms`);

    if (detail.error !== undefined) {
      lines.push(`    ! ${detail.error}`);
    }
  }

  if (report.measurements !== null) {
    lines.push('');
    lines.push('measurements (ms)');

    for (const [key, value] of Object.entries(report.measurements)) {
      lines.push(`  ${key.padEnd(24)} ${value === null ? 'not measured' : String(value)}`);
    }
  }

  if (report.isolation !== null) {
    lines.push('');
    lines.push('isolation');

    for (const [key, value] of Object.entries(report.isolation)) {
      lines.push(`  ${key.padEnd(28)} ${value === null ? 'not measured' : String(value)}`);
    }
  }

  if (report.cleanup !== null) {
    lines.push('');
    lines.push('cleanup');

    for (const [key, value] of Object.entries(report.cleanup)) {
      lines.push(`  ${key.padEnd(28)} ${value === null ? 'not measured' : String(value)}`);
    }
  }

  if (report.cost !== null) {
    lines.push('');
    lines.push(`estimated cost   $${report.cost.estimatedUsd.toFixed(6)} (this run)`);
    lines.push(`                 $${report.cost.estimatedPerMinuteUsd.toFixed(6)} / minute`);
  }

  if (report.findings.length > 0) {
    lines.push('');
    lines.push('findings');
    for (const finding of report.findings) {
      lines.push(`  - ${finding}`);
    }
  }

  lines.push(divider);

  return `${lines.join('\n')}\n`;
}

/** Stable digest of the decision-relevant fields, so two runs can be compared by eye. */
function reportFingerprint(report: DaytonaSmokeReport): string {
  const material = JSON.stringify({
    status: report.status,
    profile: report.environment.profileId,
    measurements: report.measurements,
    isolation: report.isolation,
    cleanup: report.cleanup,
  });

  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

const entryPoint = process.argv[1];

if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  runDaytonaCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `daytona smoke: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = DAYTONA_SMOKE_EXIT.fail;
    });
}
