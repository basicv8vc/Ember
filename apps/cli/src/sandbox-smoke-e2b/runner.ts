import { createHash, randomUUID } from 'node:crypto';
import type { SandboxCapabilities, SandboxSpec } from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import {
  E2B_DEFAULT_NETWORK_POLICY_ID,
  E2B_PINNED_SDK_VERSION,
  E2B_SANDBOX_LIMITS,
} from '@ember/sandbox-e2b';
import type { E2BSandboxProvider } from '@ember/sandbox-e2b';
import { formatE2bSmokeError, sanitizeText } from './sanitize.js';
import {
  E2B_SMOKE_LIMITATIONS,
  E2B_SMOKE_SCHEMA_VERSION,
  E2B_SMOKE_STEPS,
  type E2bEgressProbeTarget,
  type E2bSmokeCleanup,
  type E2bSmokeEnvironment,
  type E2bSmokeReport,
  type E2bSmokeStep,
  type E2bSmokeStepDetail,
  type E2bSmokeStatus,
  type E2bUsageBasis,
  validateE2bSmokeReport,
} from './types.js';

/** The assertion target of the required minimum smoke. */
export const HELLO_EMBER_EXPECTED_STDOUT = 'hello ember';

export const HELLO_EMBER_ARGV: readonly string[] = Object.freeze([
  'python3',
  '-c',
  "print('hello ember')",
]);

export const TIMEOUT_PROBE_ARGV: readonly string[] = Object.freeze([
  'python3',
  '-c',
  'import time; time.sleep(30)',
]);

/** Bounded, stdlib-only egress probe. Emits `CONNECTED` or `BLOCKED:<errno class>`. */
function egressProbeScript(host: string, port: number): string {
  return [
    'import socket,sys',
    'try:',
    `    c=socket.create_connection(("${host}",${port}),timeout=2)`,
    '    c.close()',
    '    print("CONNECTED")',
    'except OSError as e:',
    '    print("BLOCKED:"+type(e).__name__)',
    '    sys.exit(3)',
  ].join('\n');
}

export interface E2bEgressTarget {
  readonly host: string;
  readonly port: number;
  readonly label: string;
}

/**
 * Targets chosen to answer the security question the task actually asks: can a sandbox reach
 * cloud instance metadata or the host's private network?
 */
export const DEFAULT_EGRESS_TARGETS: readonly E2bEgressTarget[] = Object.freeze([
  { host: '169.254.169.254', port: 80, label: 'cloud-metadata (IMDSv1/v2)' },
  { host: '100.100.100.200', port: 80, label: 'alibaba-metadata' },
  { host: '1.1.1.1', port: 443, label: 'public-internet control' },
]);

export interface E2bPriceTable {
  /** USD per vCPU-second of sandbox uptime. */
  readonly usdPerVcpuSecond: number;
  /** USD per GiB-second of sandbox uptime. */
  readonly usdPerGiBSecond: number;
  readonly note: string;
}

export interface E2bSmokeRunOptions {
  readonly environment: E2bSmokeEnvironment;
  readonly spec?: Partial<SandboxSpec>;
  readonly readyDeadlineMs?: number;
  readonly execTimeoutMs?: number;
  /** Timeout for the dedicated timeout probe. Must be far below sandbox lifetime. */
  readonly timeoutProbeMs?: number;
  readonly networkPolicyId?: string;
  readonly egressTargets?: readonly E2bEgressTarget[];
  readonly priceTable?: E2bPriceTable;
  readonly signal?: AbortSignal;
}

interface TimedResult<T> {
  readonly value: T;
  readonly durationMs: number;
}

const clock = (): number => performance.now();

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Runs the required minimum E2B smoke against a live provider.
 *
 * Ordering is deliberate: the timeout probe runs *after* the success-path probes so a stuck
 * sandbox cannot consume the whole budget before the primary assertions are recorded, and the
 * egress probe runs last so a network fault cannot mask a lifecycle failure.
 */
export class E2bSmokeRunner {
  private readonly provider: E2BSandboxProvider;

  constructor(provider: E2BSandboxProvider) {
    this.provider = provider;
  }

  async run(options: E2bSmokeRunOptions): Promise<E2bSmokeReport> {
    const testId = randomUUID();
    const runId = randomUUID();
    const readyDeadlineMs = Math.min(
      options.readyDeadlineMs ?? 30_000,
      E2B_SANDBOX_LIMITS.maxReadyDeadlineMs,
    );
    const execTimeoutMs = Math.min(
      options.execTimeoutMs ?? 20_000,
      E2B_SANDBOX_LIMITS.maxExecTimeoutMs,
    );
    const timeoutProbeMs = Math.min(options.timeoutProbeMs ?? 2_000, execTimeoutMs);
    const networkPolicyId = options.networkPolicyId ?? E2B_DEFAULT_NETWORK_POLICY_ID;
    const egressTargets = options.egressTargets ?? DEFAULT_EGRESS_TARGETS;

    const steps = emptySteps();
    const startedAt = clock();

    let sandboxId: string | null = null;
    let capabilities: SandboxCapabilities | null = null;
    let primaryError: unknown = null;

    let createLatencyMs: number | null = null;
    let readyLatencyMs: number | null = null;
    let firstCommandLatencyMs: number | null = null;
    let warmCommandLatencyMs: number | null = null;
    let stopLatencyMs: number | null = null;
    let destroyLatencyMs: number | null = null;
    let cleanupVerifyLatencyMs: number | null = null;

    let allocatedCpuCount: number | null = null;
    let allocatedMemoryMiB: number | null = null;
    let observedAllowInternetAccess: boolean | null = null;

    let helloStdout: string | null = null;
    let helloStderr: string | null = null;
    let helloExitCode: number | null = null;
    let fileWrittenBytes: number | null = null;
    let fileReadMatches: boolean | null = null;
    let fileVisibleInSandbox: boolean | null = null;

    let timeoutProbeRequestedMs: number | null = null;
    let timeoutProbeElapsedMs: number | null = null;
    let timeoutProbeExitCode: number | null = null;
    let timeoutProbeObserved = false;

    const egressProbes: E2bEgressProbeTarget[] = [];
    let usageRecord: Awaited<ReturnType<E2BSandboxProvider['usage']>> | null = null;
    let usageBasis: E2bUsageBasis = 'NOT_MEASURED';

    let stopStatus: E2bSmokeCleanup['stopStatus'] = 'NOT_ATTEMPTED';
    let destroyStatus: E2bSmokeCleanup['destroyStatus'] = 'NOT_ATTEMPTED';
    let stopError: string | undefined;
    let destroyError: string | undefined;

    const spec: SandboxSpec = {
      tenantId: this.provider.tenant,
      runId,
      imageDigest: options.environment.templateDigest,
      cpuMilli: 1_000,
      memoryMiB: 512,
      maxLifetimeSec: Math.min(120, E2B_SANDBOX_LIMITS.maxSandboxLifetimeSec),
      networkPolicyId,
      ...options.spec,
    };

    // Preflight is asserted by the caller (key presence, SDK pin); record it as a step so the
    // report has no gaps.
    steps.preflight = {
      step: 'preflight',
      status: 'PASS',
      durationMs: 0,
      details: {
        apiKeyPresent: options.environment.apiKeyPresent,
        sdkPinned: options.environment.sdkVersion === E2B_PINNED_SDK_VERSION,
        template: options.environment.template,
      },
    };

    const execute = async <T>(step: E2bSmokeStep, action: () => Promise<T>): Promise<T> => {
      const stepStartedAt = clock();

      try {
        const value = await action();
        steps[step] = {
          step,
          status: 'PASS',
          durationMs: round(clock() - stepStartedAt),
        };
        return value;
      } catch (error) {
        steps[step] = {
          step,
          status: 'FAIL',
          durationMs: round(clock() - stepStartedAt),
          error: describeError(error),
        };
        throw error;
      }
    };

    const failStep = (step: E2bSmokeStep, durationMs: number, error: unknown): void => {
      steps[step] = {
        step,
        status: 'FAIL',
        durationMs: round(durationMs),
        error: describeError(error),
      };
    };

    const runCommand = async (
      argv: readonly string[],
      timeoutMs: number,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      if (sandboxId === null) {
        throw new Error('sandbox missing');
      }

      const result = await this.provider.exec(sandboxId, argv, timeoutMs);
      const stdout = await this.provider.readOutput(sandboxId, result.stdoutRef);
      const stderr = await this.provider.readOutput(sandboxId, result.stderrRef);
      return { exitCode: result.exitCode, stdout, stderr };
    };

    try {
      capabilities = await execute('capabilities', () => this.provider.capabilities());

      const created: TimedResult<{ sandboxId: string }> = await timed(() =>
        this.provider.create(spec),
      );
      const activeSandboxId = created.value.sandboxId;
      sandboxId = activeSandboxId;
      createLatencyMs = round(created.durationMs);
      steps.create = {
        step: 'create',
        status: 'PASS',
        durationMs: createLatencyMs,
        details: { sandboxId: activeSandboxId, template: options.environment.template },
      };

      const ready: TimedResult<void> = await timed(() =>
        this.provider.waitReady(activeSandboxId, readyDeadlineMs),
      );
      readyLatencyMs = round(ready.durationMs);

      const measured = this.provider.measuredResources(activeSandboxId);
      allocatedCpuCount = measured.cpuCount;
      allocatedMemoryMiB = measured.memoryMiB;
      observedAllowInternetAccess = measured.allowInternetAccess;

      steps.waitReady = {
        step: 'waitReady',
        status: 'PASS',
        durationMs: readyLatencyMs,
        details: {
          pollProbe: 'control-plane Sandbox.getInfo state === running',
          allocatedCpuCount,
          allocatedMemoryMiB,
          observedAllowInternetAccess,
        },
      };

      // --- Step: execute `python -c print('hello ember')` and capture stdio + exit code ---
      const hello: TimedResult<{ exitCode: number; stdout: string; stderr: string }> = await timed(
        () => runCommand(HELLO_EMBER_ARGV, execTimeoutMs),
      );
      firstCommandLatencyMs = round(hello.durationMs);
      helloExitCode = hello.value.exitCode;
      helloStdout = hello.value.stdout;
      helloStderr = hello.value.stderr;

      const stdoutMatches = hello.value.stdout.trim() === HELLO_EMBER_EXPECTED_STDOUT;

      if (hello.value.exitCode !== 0 || !stdoutMatches || hello.value.stderr !== '') {
        const assertion = new Error('hello assertion failed');
        failStep('execHello', firstCommandLatencyMs, assertion);
        steps.execHello = {
          ...steps.execHello,
          details: {
            argv: HELLO_EMBER_ARGV,
            exitCode: helloExitCode,
            stdoutSha256: sha256(helloStdout ?? ''),
            stdoutMatches,
            stderrEmpty: helloStderr === '',
          },
        };
        throw assertion;
      }

      steps.execHello = {
        step: 'execHello',
        status: 'PASS',
        durationMs: firstCommandLatencyMs,
        details: {
          argv: HELLO_EMBER_ARGV,
          exitCode: helloExitCode,
          stdout: sanitizeText((helloStdout ?? '').slice(0, 200)),
          stderr: sanitizeText((helloStderr ?? '').slice(0, 200)),
          stdoutSha256: sha256(helloStdout ?? ''),
        },
      };

      // --- Step: write and read a temporary file, then prove it is visible in-sandbox ---
      const fileStartedAt = clock();
      const payload = `ember-e2b-smoke:${testId}`;
      const relativePath = `smoke/${testId}.txt`;

      await this.provider.putTextFile(activeSandboxId, relativePath, payload);
      const readBack = await this.provider.getTextFile(activeSandboxId, relativePath);
      fileWrittenBytes = Buffer.byteLength(payload, 'utf8');
      fileReadMatches = readBack === payload;

      const cat = await runCommand(['cat', `/tmp/ember/${relativePath}`], execTimeoutMs);
      fileVisibleInSandbox = cat.exitCode === 0 && cat.stdout === payload;

      if (!fileReadMatches || !fileVisibleInSandbox) {
        const assertion = new Error('file round-trip assertion failed');
        failStep('fileRoundTrip', clock() - fileStartedAt, assertion);
        throw assertion;
      }

      steps.fileRoundTrip = {
        step: 'fileRoundTrip',
        status: 'PASS',
        durationMs: round(clock() - fileStartedAt),
        details: {
          path: `/tmp/ember/${relativePath}`,
          bytes: fileWrittenBytes,
          contentSha256: sha256(payload),
          readMatches: fileReadMatches,
          visibleInSandbox: fileVisibleInSandbox,
        },
      };

      // --- Warm path sample: a second command after the sandbox is hot ---
      const warm: TimedResult<{ exitCode: number; stdout: string; stderr: string }> = await timed(
        () => runCommand(['python3', '-c', "print('warm')"], execTimeoutMs),
      );
      warmCommandLatencyMs = round(warm.durationMs);

      // --- Step: bounded timeout probe (must time out, and must not hang the sandbox) ---
      timeoutProbeRequestedMs = timeoutProbeMs;
      const probeStartedAt = clock();
      let timedOutAsExpected = false;

      try {
        await runCommand(TIMEOUT_PROBE_ARGV, timeoutProbeMs);
        timeoutProbeExitCode = 0;
      } catch (error) {
        timeoutProbeElapsedMs = round(clock() - probeStartedAt);

        if (isDomainError(error) && error.code === 'EXECUTION_TIMEOUT') {
          timedOutAsExpected = true;
          timeoutProbeExitCode = 124;
        } else if (isDomainError(error)) {
          timeoutProbeExitCode = null;
          throw error;
        } else {
          throw error;
        }
      }

      if (timeoutProbeElapsedMs === null) {
        timeoutProbeElapsedMs = round(clock() - probeStartedAt);
      }

      if (!timedOutAsExpected) {
        const assertion = new Error('timeout probe did not time out');
        failStep('execTimeout', timeoutProbeElapsedMs, assertion);
        throw assertion;
      }

      timeoutProbeObserved = true;

      steps.execTimeout = {
        step: 'execTimeout',
        status: 'PASS',
        durationMs: timeoutProbeElapsedMs,
        details: {
          requestedTimeoutMs: timeoutProbeMs,
          observedElapsedMs: timeoutProbeElapsedMs,
          overshootMs: round(Math.max(0, timeoutProbeElapsedMs - timeoutProbeMs)),
          observedExitCode: timeoutProbeExitCode,
          timedOut: true,
        },
      };

      // --- Step: egress probe under the configured (default deny-all) policy ---
      const egressStartedAt = clock();

      for (const target of egressTargets) {
        const probeStarted = clock();

        try {
          const result = await runCommand(
            ['python3', '-c', egressProbeScript(target.host, target.port)],
            Math.max(5_000, timeoutProbeMs),
          );

          egressProbes.push({
            target: target.label,
            port: target.port,
            connected: result.exitCode === 0 && result.stdout.includes('CONNECTED'),
            elapsedMs: round(clock() - probeStarted),
            failureClass: result.exitCode === 0 ? null : 'NONZERO_EXIT',
          });
        } catch (error) {
          const deniedByTimeout = isDomainError(error) && error.code === 'EXECUTION_TIMEOUT';

          egressProbes.push({
            target: target.label,
            port: target.port,
            connected: deniedByTimeout ? false : null,
            elapsedMs: round(clock() - probeStarted),
            failureClass: deniedByTimeout ? 'TIMEOUT' : 'PROBE_ERROR',
          });
        }
      }

      const denyAll = networkPolicyId === 'deny-all';
      const egressDeniedAsExpected = denyAll
        ? egressProbes.every((probe) => probe.connected === false)
        : null;

      steps.egressProbe = {
        step: 'egressProbe',
        status: denyAll && egressDeniedAsExpected !== true ? 'FAIL' : 'PASS',
        durationMs: round(clock() - egressStartedAt),
        details: {
          networkPolicyId,
          denyAll,
          probes: egressProbes,
        },
      };

      if (denyAll && egressDeniedAsExpected !== true) {
        throw new Error('egress was reachable under deny-all policy');
      }

      // --- Step: usage telemetry ---
      usageRecord = await execute('usage', () => this.provider.usage(activeSandboxId));
      usageBasis = this.provider.usageBasis(activeSandboxId) ?? 'NOT_MEASURED';

      if (
        !Number.isFinite(usageRecord.cpuSeconds) ||
        usageRecord.cpuSeconds < 0 ||
        !Number.isFinite(usageRecord.memoryGiBSeconds) ||
        usageRecord.memoryGiBSeconds < 0
      ) {
        const assertion = new Error('usage telemetry invalid');
        failStep('usage', steps.usage.durationMs ?? 0, assertion);
        throw assertion;
      }

      steps.usage = {
        step: 'usage',
        status: 'PASS',
        durationMs: steps.usage.durationMs ?? 0,
        details: {
          basis: usageBasis,
          cpuSeconds: usageRecord.cpuSeconds,
          memoryGiBSeconds: usageRecord.memoryGiBSeconds,
          egressBytes: 'NOT_MEASURED',
        },
      };
    } catch (error) {
      primaryError = error;
    } finally {
      if (sandboxId !== null) {
        const stopStartedAt = clock();

        try {
          await this.provider.stop(sandboxId);
          stopLatencyMs = round(clock() - stopStartedAt);
          stopStatus = 'COMPLETED';
          steps.stop = { step: 'stop', status: 'PASS', durationMs: stopLatencyMs };
        } catch (error) {
          stopLatencyMs = round(clock() - stopStartedAt);
          stopStatus = 'FAILED';
          stopError = describeError(error);
          steps.stop = {
            step: 'stop',
            status: 'FAIL',
            durationMs: stopLatencyMs,
            error: stopError,
          };
        }

        const destroyStartedAt = clock();

        try {
          await this.provider.destroy(sandboxId);
          destroyLatencyMs = round(clock() - destroyStartedAt);
          destroyStatus = 'COMPLETED';
          steps.destroy = { step: 'destroy', status: 'PASS', durationMs: destroyLatencyMs };
        } catch (error) {
          destroyLatencyMs = round(clock() - destroyStartedAt);
          destroyStatus = 'FAILED';
          destroyError = describeError(error);
          steps.destroy = {
            step: 'destroy',
            status: 'FAIL',
            durationMs: destroyLatencyMs,
            error: destroyError,
          };
        }
      }
    }

    // --- Step: independent cleanup verification against the vendor control plane ---
    let liveSandboxIds: readonly string[] = [];
    let resourceVerification: E2bSmokeCleanup['resourceVerification'] = 'NOT_ATTEMPTED';

    if (sandboxId !== null) {
      const verifyStartedAt = clock();

      try {
        const audit = await this.provider.verifyNoLiveSandboxes({ ember_run_id: runId });
        cleanupVerifyLatencyMs = round(clock() - verifyStartedAt);
        liveSandboxIds = audit.liveSandboxIds;
        resourceVerification =
          liveSandboxIds.length === 0 ? 'VERIFIED_ZERO' : 'ACTIVE_RESOURCES_DETECTED';
        steps.cleanupVerify = {
          step: 'cleanupVerify',
          status: liveSandboxIds.length === 0 ? 'PASS' : 'FAIL',
          durationMs: cleanupVerifyLatencyMs,
          details: {
            liveSandboxIds,
            checkedMetadata: audit.checkedMetadata,
          },
        };
      } catch (error) {
        cleanupVerifyLatencyMs = round(clock() - verifyStartedAt);
        resourceVerification = 'CHECK_FAILED';
        steps.cleanupVerify = {
          step: 'cleanupVerify',
          status: 'FAIL',
          durationMs: cleanupVerifyLatencyMs,
          error: describeError(error),
        };
      }
    } else {
      steps.cleanupVerify = {
        step: 'cleanupVerify',
        status: 'SKIPPED',
        durationMs: 0,
        details: { reason: 'no sandbox was allocated' },
      };
    }

    const leakStatus =
      resourceVerification === 'VERIFIED_ZERO'
        ? 'VERIFIED_CLEAN'
        : resourceVerification === 'ACTIVE_RESOURCES_DETECTED'
          ? 'CONFIRMED_LEAK'
          : 'UNKNOWN';

    const totalWallMs = round(clock() - startedAt);
    const allStepsPass = E2B_SMOKE_STEPS.every((step) => steps[step].status === 'PASS');
    const status: E2bSmokeStatus =
      primaryError === null &&
      allStepsPass &&
      leakStatus === 'VERIFIED_CLEAN' &&
      steps.execTimeout.status === 'PASS' &&
      timeoutProbeObserved
        ? 'PASS'
        : 'FAIL';

    const priceTable = options.priceTable;
    const estimatedSandboxUsd =
      priceTable !== undefined && usageRecord !== null
        ? Math.round(
            (usageRecord.cpuSeconds * priceTable.usdPerVcpuSecond +
              usageRecord.memoryGiBSeconds * priceTable.usdPerGiBSecond) *
              1_000_000,
          ) / 1_000_000
        : null;

    const report: E2bSmokeReport = {
      schemaVersion: E2B_SMOKE_SCHEMA_VERSION,
      testId,
      provider: 'e2b',
      mode: 'REAL_REMOTE',
      status,
      blockedReason: null,
      environment: options.environment,
      steps,
      timing: {
        totalWallMs,
        createLatencyMs,
        readyLatencyMs,
        firstCommandLatencyMs,
        warmCommandLatencyMs,
        stopLatencyMs,
        destroyLatencyMs,
        cleanupVerifyLatencyMs,
      },
      measurements: {
        createLatencyMs,
        readyLatencyMs,
        firstCommandLatencyMs,
        secondCommandLatencyMs: warmCommandLatencyMs,
        stopLatencyMs,
        destroyLatencyMs,
        timeoutProbe: {
          requestedTimeoutMs: timeoutProbeRequestedMs,
          observedElapsedMs: timeoutProbeElapsedMs,
          observedExitCode: timeoutProbeExitCode,
          timedOut: timeoutProbeObserved ? true : null,
          overshootMs:
            timeoutProbeElapsedMs === null || timeoutProbeRequestedMs === null
              ? null
              : round(Math.max(0, timeoutProbeElapsedMs - timeoutProbeRequestedMs)),
        },
        allocatedCpuCount,
        allocatedMemoryMiB,
        requestedCpuMilli: spec.cpuMilli,
        requestedMemoryMiB: spec.memoryMiB,
        sandboxLifetimeSec: spec.maxLifetimeSec,
      },
      usage: {
        usage: usageRecord,
        basis: usageBasis,
        egressBytes: null,
        egressSource: 'NOT_MEASURED',
      },
      isolation: {
        requestedAllowInternetAccess: networkPolicyId === 'deny-all' ? false : null,
        observedAllowInternetAccess,
        networkPolicyId,
        egressProbes,
        egressDeniedAsExpected:
          networkPolicyId === 'deny-all'
            ? egressProbes.length > 0 && egressProbes.every((probe) => probe.connected === false)
            : null,
      },
      cost: {
        estimatedSandboxUsd,
        actualBilledUsd: null,
        remainingCreditUsd: null,
        source: priceTable === undefined ? 'VENDOR_CONSOLE_REQUIRED' : 'USER_SUPPLIED_PRICE_TABLE',
        priceTableNote: priceTable?.note ?? null,
      },
      cleanup: {
        stopStatus,
        destroyStatus,
        leakStatus,
        resourceVerification,
        liveSandboxIds,
        ...(stopError === undefined ? {} : { stopError }),
        ...(destroyError === undefined ? {} : { destroyError }),
      },
      evidence: {
        helloStdout,
        helloStderr,
        helloExitCode,
        helloStdoutMatches:
          helloStdout === null ? null : helloStdout.trim() === HELLO_EMBER_EXPECTED_STDOUT,
        fileWrittenBytes,
        fileReadMatches,
        fileVisibleInSandbox,
      },
      capabilities,
      error: primaryError === null ? null : describeError(primaryError),
      limitations: E2B_SMOKE_LIMITATIONS,
    };

    const violations = validateE2bSmokeReport(report);

    if (violations.length > 0) {
      // Fail closed: an internally inconsistent PASS must never leave the process.
      return {
        ...report,
        status: 'FAIL',
        error: `report failed its own PASS invariants: ${violations.join('; ')}`,
      };
    }

    return report;
  }
}

async function timed<T>(action: () => Promise<T>): Promise<TimedResult<T>> {
  const startedAt = clock();
  const value = await action();
  return { value, durationMs: clock() - startedAt };
}

function skipped(step: E2bSmokeStep): E2bSmokeStepDetail {
  return { step, status: 'SKIPPED', durationMs: 0 };
}

/** Fully explicit so the compiler proves the table is exhaustive over `E2B_SMOKE_STEPS`. */
function emptySteps(): Record<E2bSmokeStep, E2bSmokeStepDetail> {
  return {
    preflight: skipped('preflight'),
    capabilities: skipped('capabilities'),
    create: skipped('create'),
    waitReady: skipped('waitReady'),
    execHello: skipped('execHello'),
    fileRoundTrip: skipped('fileRoundTrip'),
    execTimeout: skipped('execTimeout'),
    egressProbe: skipped('egressProbe'),
    usage: skipped('usage'),
    stop: skipped('stop'),
    destroy: skipped('destroy'),
    cleanupVerify: skipped('cleanupVerify'),
  };
}

/**
 * Converts a thrown value into report text.
 *
 * Domain errors contribute only their fixed public message and code; anything else becomes a
 * generic provider failure. Vendor messages never appear in a report.
 */
export function describeError(error: unknown): string {
  if (isDomainError(error)) {
    return sanitizeText(`${error.publicMessage} [${error.code}]`);
  }

  if (error instanceof Error && error.message === 'hello assertion failed') {
    return 'command executed but stdout/stderr/exit code did not match the expectation [ERR_ASSERTION_FAILED]';
  }

  if (error instanceof Error && error.message === 'file round-trip assertion failed') {
    return 'file write/read round-trip did not match the payload [ERR_ASSERTION_FAILED]';
  }

  if (error instanceof Error && error.message === 'timeout probe did not time out') {
    return 'the bounded command completed instead of timing out [ERR_ASSERTION_FAILED]';
  }

  if (error instanceof Error && error.message === 'egress was reachable under deny-all policy') {
    return 'a network destination was reachable while egress was denied [ERR_ASSERTION_FAILED]';
  }

  if (error instanceof Error && error.message === 'usage telemetry invalid') {
    return formatE2bSmokeError('ERR_USAGE_INVALID');
  }

  return formatE2bSmokeError('ERR_PROVIDER_EXECUTION');
}

/** Builds a report for a run that never reached the vendor. */
export function buildBlockedE2bSmokeReport(
  environment: E2bSmokeEnvironment,
  reason: string,
): E2bSmokeReport {
  const steps = emptySteps();

  for (const step of E2B_SMOKE_STEPS) {
    steps[step] = {
      step,
      status: step === 'preflight' ? 'BLOCKED' : 'SKIPPED',
      durationMs: 0,
    };
  }

  steps.preflight = {
    step: 'preflight',
    status: 'BLOCKED',
    durationMs: 0,
    error: reason,
    details: {
      apiKeyPresent: environment.apiKeyPresent,
      sdkVersion: environment.sdkVersion,
      pinnedSdkVersion: environment.pinnedSdkVersion,
    },
  };

  return {
    schemaVersion: E2B_SMOKE_SCHEMA_VERSION,
    testId: randomUUID(),
    provider: 'e2b',
    mode: 'REAL_REMOTE',
    status: 'BLOCKED',
    blockedReason: reason,
    environment,
    steps,
    timing: {
      totalWallMs: 0,
      createLatencyMs: null,
      readyLatencyMs: null,
      firstCommandLatencyMs: null,
      warmCommandLatencyMs: null,
      stopLatencyMs: null,
      destroyLatencyMs: null,
      cleanupVerifyLatencyMs: null,
    },
    measurements: {
      createLatencyMs: null,
      readyLatencyMs: null,
      firstCommandLatencyMs: null,
      secondCommandLatencyMs: null,
      stopLatencyMs: null,
      destroyLatencyMs: null,
      timeoutProbe: {
        requestedTimeoutMs: null,
        observedElapsedMs: null,
        observedExitCode: null,
        timedOut: null,
        overshootMs: null,
      },
      allocatedCpuCount: null,
      allocatedMemoryMiB: null,
      requestedCpuMilli: null,
      requestedMemoryMiB: null,
      sandboxLifetimeSec: null,
    },
    usage: {
      usage: null,
      basis: 'NOT_MEASURED',
      egressBytes: null,
      egressSource: 'NOT_MEASURED',
    },
    isolation: {
      requestedAllowInternetAccess: null,
      observedAllowInternetAccess: null,
      networkPolicyId: null,
      egressProbes: [],
      egressDeniedAsExpected: null,
    },
    cost: {
      estimatedSandboxUsd: null,
      actualBilledUsd: null,
      remainingCreditUsd: null,
      source: 'NOT_MEASURED',
      priceTableNote: null,
    },
    cleanup: {
      stopStatus: 'NOT_ATTEMPTED',
      destroyStatus: 'NOT_ATTEMPTED',
      leakStatus: 'UNKNOWN',
      resourceVerification: 'NOT_ATTEMPTED',
      liveSandboxIds: [],
    },
    evidence: {
      helloStdout: null,
      helloStderr: null,
      helloExitCode: null,
      helloStdoutMatches: null,
      fileWrittenBytes: null,
      fileReadMatches: null,
      fileVisibleInSandbox: null,
    },
    capabilities: null,
    error: reason,
    limitations: E2B_SMOKE_LIMITATIONS,
  };
}
