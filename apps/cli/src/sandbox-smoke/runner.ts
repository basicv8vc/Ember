import { randomUUID } from 'node:crypto';
import type {
  SandboxCapabilities,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import {
  formatSanitizedError,
  SmokeHarnessError,
  isSmokeHarnessError,
  UntrustedProviderError,
} from './sanitize.js';
import {
  SMOKE_LIMITATIONS,
  SMOKE_SCHEMA_VERSION,
  type SmokeCleanupReport,
  type SmokeCleanupStepStatus,
  type SmokeLeakStatus,
  type SmokeResourceVerificationStatus,
  type SmokePhase,
  type SmokePhaseDetail,
  type SmokePhaseStatus,
  type SmokeReport,
  type SmokeRunnerOptions,
  type SmokeTimingReport,
} from './types.js';

export const EXPECTED_HELLO_EMBER_SHA256 =
  '5a7f924557ee634c065ca4fc1074847e6cbdb53db18ffa5bea647a62e3c6fcf0';

export const DEFAULT_FAKE_IMAGE_DIGEST = 'sha256:ember-fake-sandbox-v1';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_EXEC_ARGV = Object.freeze(['sha256', 'hello ember']);

/**
 * Wraps a SandboxProvider instance at the invocation boundary with explicit try/catch guards.
 * Ensures that any error (synchronous exception or asynchronous promise rejection)
 * originating from a Provider method is unconditionally converted into an UntrustedProviderError.
 * This guarantees that Provider exceptions can NEVER enter internal harness error branches
 * or masquerade as trusted internal signals.
 */
export function createBoundaryGuardedProvider(provider: SandboxProvider): SandboxProvider {
  const guardAsync = <Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
  ): ((...args: Args) => Promise<R>) => {
    return async (...args: Args): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err: unknown) {
        throw new UntrustedProviderError(err);
      }
    };
  };

  const guardSync = <Args extends unknown[], R>(
    fn: (...args: Args) => R,
  ): ((...args: Args) => R) => {
    return (...args: Args): R => {
      try {
        return fn(...args);
      } catch (err: unknown) {
        throw new UntrustedProviderError(err);
      }
    };
  };

  const maybeLive = provider as unknown as { liveSandboxCount?: unknown };
  const guarded: SandboxProvider & { liveSandboxCount?: () => number } = {
    capabilities: guardAsync((...args) => provider.capabilities(...args)),
    create: guardAsync((...args) => provider.create(...args)),
    waitReady: guardAsync((...args) => provider.waitReady(...args)),
    exec: guardAsync((...args) => provider.exec(...args)),
    readOutput: guardAsync((...args) => provider.readOutput(...args)),
    putFile: guardAsync((...args) => provider.putFile(...args)),
    getFile: guardAsync((...args) => provider.getFile(...args)),
    stop: guardAsync((...args) => provider.stop(...args)),
    destroy: guardAsync((...args) => provider.destroy(...args)),
    usage: guardAsync((...args) => provider.usage(...args)),
  };

  if (typeof maybeLive.liveSandboxCount === 'function') {
    const liveFn = maybeLive.liveSandboxCount.bind(provider) as () => number;
    guarded.liveSandboxCount = guardSync(liveFn);
  }

  return guarded;
}

/**
 * Wraps an asynchronous operation with an effective wall-clock timeout and AbortSignal race.
 * Prevents unresolving or hanging promises from hanging the runner indefinitely.
 */
async function withBoundedTimeout<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  phaseName: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new SmokeHarnessError('ERR_OPERATION_ABORTED', { phase: phaseName });
  }

  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SmokeHarnessError('ERR_PHASE_TIMEOUT', { phase: phaseName, timeoutMs }));
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal) {
      abortHandler = () => {
        reject(new SmokeHarnessError('ERR_OPERATION_ABORTED', { phase: phaseName }));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  try {
    return await Promise.race([action(), timeoutPromise, abortPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
}

export class SandboxSmokeRunner {
  private readonly provider: SandboxProvider;

  constructor(provider: SandboxProvider) {
    this.provider = createBoundaryGuardedProvider(provider);
  }

  async run(options: Omit<SmokeRunnerOptions, 'provider'> = {}): Promise<SmokeReport> {
    const testId = randomUUID();
    const tenantId = options.tenantId ?? randomUUID();
    const runId = options.runId ?? randomUUID();
    const imageDigest = options.imageDigest ?? DEFAULT_FAKE_IMAGE_DIGEST;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const readyDeadlineMs = options.readyDeadlineMs ?? Math.min(timeoutMs, 5_000);
    const execTimeoutMs = options.execTimeoutMs ?? Math.min(timeoutMs, 5_000);
    const cleanupTimeoutMs = Math.min(timeoutMs, 3_000);
    const argv = options.argv ?? DEFAULT_EXEC_ARGV;
    const expectedSha256 = options.expectedSha256 ?? EXPECTED_HELLO_EMBER_SHA256;
    const signal = options.signal;

    const startWall = performance.now();
    const phaseDurations: Record<SmokePhase, number> = {
      capabilities: 0,
      create: 0,
      waitReady: 0,
      exec: 0,
      readOutput: 0,
      usage: 0,
      stop: 0,
      destroy: 0,
    };

    const phaseDetails: Record<SmokePhase, SmokePhaseDetail> = {
      capabilities: { phase: 'capabilities', status: 'SKIPPED', durationMs: 0 },
      create: { phase: 'create', status: 'SKIPPED', durationMs: 0 },
      waitReady: { phase: 'waitReady', status: 'SKIPPED', durationMs: 0 },
      exec: { phase: 'exec', status: 'SKIPPED', durationMs: 0 },
      readOutput: { phase: 'readOutput', status: 'SKIPPED', durationMs: 0 },
      usage: { phase: 'usage', status: 'SKIPPED', durationMs: 0 },
      stop: { phase: 'stop', status: 'SKIPPED', durationMs: 0 },
      destroy: { phase: 'destroy', status: 'SKIPPED', durationMs: 0 },
    };

    let sandboxId: Id | null = null;
    let createAttempted = false;
    let capabilitiesResult: SandboxCapabilities | null = null;
    let usageResult: SandboxUsageRecord | null = null;
    let primaryError: unknown = null;
    let failedPhase: SmokePhase | null = null;
    let stopError: unknown = undefined;
    let destroyError: unknown = undefined;
    let stopStatus: SmokeCleanupStepStatus = 'NOT_ATTEMPTED';
    let destroyStatus: SmokeCleanupStepStatus = 'NOT_ATTEMPTED';

    const executePhase = async <T>(
      phase: SmokePhase,
      phaseTimeoutMs: number,
      action: () => Promise<T>,
      detailsExtractor?: (result: T) => Record<string, unknown>,
    ): Promise<T> => {
      if (signal?.aborted) {
        throw new SmokeHarnessError('ERR_OPERATION_ABORTED', { phase });
      }
      const phaseStart = performance.now();
      try {
        const result = await withBoundedTimeout(action, phaseTimeoutMs, phase, signal);
        const durationMs = Math.round((performance.now() - phaseStart) * 100) / 100;
        phaseDurations[phase] = durationMs;
        phaseDetails[phase] = {
          phase,
          status: 'PASS',
          durationMs,
          details: detailsExtractor ? detailsExtractor(result) : undefined,
        };
        return result;
      } catch (err) {
        failedPhase = phase;
        const durationMs = Math.round((performance.now() - phaseStart) * 100) / 100;
        phaseDurations[phase] = durationMs;
        phaseDetails[phase] = {
          phase,
          status: 'FAIL',
          durationMs,
          error: formatSanitizedError(err, phase),
        };
        throw err;
      }
    };

    try {
      // Phase 1: Capabilities discovery
      capabilitiesResult = await executePhase(
        'capabilities',
        Math.min(timeoutMs, 5_000),
        () => this.provider.capabilities(),
        (caps) => ({
          shell: caps.shell,
          browser: caps.browser,
          filesystemSnapshot: caps.filesystemSnapshot,
          memoryResume: caps.memoryResume,
          diskSurvivesStop: caps.diskSurvivesStop,
          forkFromSnapshot: caps.forkFromSnapshot,
          persistentVolume: caps.persistentVolume,
          networkPolicy: caps.networkPolicy,
        }),
      );

      // Phase 2: Create sandbox instance
      const spec: SandboxSpec = {
        tenantId,
        runId,
        imageDigest,
        cpuMilli: 1_000,
        memoryMiB: 512,
        maxLifetimeSec: 60,
        networkPolicyId: 'policy-smoke-default',
        ...options.specOverrides,
      };

      createAttempted = true;
      const createRes = await executePhase(
        'create',
        Math.min(timeoutMs, 5_000),
        () => this.provider.create(spec),
        (res) => ({
          sandboxId: res.sandboxId,
        }),
      );
      sandboxId = createRes.sandboxId;

      // Phase 3: Wait for ready
      await executePhase('waitReady', readyDeadlineMs, () =>
        this.provider.waitReady(createRes.sandboxId, readyDeadlineMs),
      );

      // Phase 4: Allowlisted Exec
      const execRes = await executePhase(
        'exec',
        execTimeoutMs,
        async () => {
          const res = await this.provider.exec(createRes.sandboxId, argv, execTimeoutMs);
          if (res.exitCode !== 0) {
            throw new SmokeHarnessError('ERR_EXEC_FAILED', { exitCode: res.exitCode });
          }
          return res;
        },
        (res) => ({
          exitCode: res.exitCode,
          operation: 'sha256',
        }),
      );

      // Phase 5: Read stdout and stderr output
      await executePhase(
        'readOutput',
        Math.min(timeoutMs, 5_000),
        async () => {
          const stdout = await this.provider.readOutput(createRes.sandboxId, execRes.stdoutRef);
          const stderr = await this.provider.readOutput(createRes.sandboxId, execRes.stderrRef);

          if (stdout !== expectedSha256) {
            throw new SmokeHarnessError('DIGEST_MISMATCH', { phase: 'readOutput' });
          }
          return { stdout, stderr };
        },
        (output) => ({
          stdoutDigestMatches: output.stdout === expectedSha256,
          stderrEmpty: output.stderr.length === 0,
        }),
      );

      // Phase 6: Usage telemetry
      usageResult = await executePhase(
        'usage',
        Math.min(timeoutMs, 5_000),
        async () => {
          const usage = await this.provider.usage(createRes.sandboxId);
          if (
            !Number.isFinite(usage.cpuSeconds) ||
            usage.cpuSeconds < 0 ||
            !Number.isFinite(usage.memoryGiBSeconds) ||
            usage.memoryGiBSeconds < 0 ||
            !Number.isFinite(usage.egressBytes) ||
            usage.egressBytes < 0
          ) {
            throw new SmokeHarnessError('ERR_INVALID_USAGE', { phase: 'usage' });
          }
          return usage;
        },
        (usage) => ({
          cpuSeconds: usage.cpuSeconds,
          memoryGiBSeconds: usage.memoryGiBSeconds,
          egressBytes: usage.egressBytes,
        }),
      );
    } catch (err) {
      primaryError = err;
    } finally {
      // Phases 7 & 8: Guaranteed cleanup on all paths
      if (sandboxId !== null) {
        // Attempt stop
        const stopStart = performance.now();
        try {
          await withBoundedTimeout(() => this.provider.stop(sandboxId!), cleanupTimeoutMs, 'stop');
          const durationMs = Math.round((performance.now() - stopStart) * 100) / 100;
          phaseDurations.stop = durationMs;
          phaseDetails.stop = { phase: 'stop', status: 'PASS', durationMs };
          stopStatus = 'COMPLETED';
        } catch (err) {
          stopError = err;
          const durationMs = Math.round((performance.now() - stopStart) * 100) / 100;
          phaseDurations.stop = durationMs;
          phaseDetails.stop = {
            phase: 'stop',
            status: 'FAIL',
            durationMs,
            error: formatSanitizedError(err, 'stop'),
          };
          stopStatus =
            isSmokeHarnessError(err) && err.code === 'ERR_PHASE_TIMEOUT' ? 'UNKNOWN' : 'FAILED';
        }

        // Always attempt destroy, even if stop failed
        const destroyStart = performance.now();
        try {
          await withBoundedTimeout(
            () => this.provider.destroy(sandboxId!),
            cleanupTimeoutMs,
            'destroy',
          );
          const durationMs = Math.round((performance.now() - destroyStart) * 100) / 100;
          phaseDurations.destroy = durationMs;
          phaseDetails.destroy = { phase: 'destroy', status: 'PASS', durationMs };
          destroyStatus = 'COMPLETED';
        } catch (err) {
          destroyError = err;
          const durationMs = Math.round((performance.now() - destroyStart) * 100) / 100;
          phaseDurations.destroy = durationMs;
          phaseDetails.destroy = {
            phase: 'destroy',
            status: 'FAIL',
            durationMs,
            error: formatSanitizedError(err, 'destroy'),
          };
          destroyStatus =
            isSmokeHarnessError(err) && err.code === 'ERR_PHASE_TIMEOUT' ? 'UNKNOWN' : 'FAILED';
        }
      }
    }

    // Determine cleanup step success and leak status with fail-closed semantics
    let stopSucceeded = false;
    let destroySucceeded = false;
    let leakStatus: SmokeLeakStatus = 'UNKNOWN';
    let resourceVerification: SmokeResourceVerificationStatus = 'NOT_ATTEMPTED';

    if (sandboxId === null) {
      if (createAttempted) {
        // create() was attempted on the provider but failed/timed out before returning an ID.
        // The provider may have initiated or allocated an untracked resource; state is UNKNOWN.
        stopStatus = 'NOT_ATTEMPTED';
        destroyStatus = 'NOT_ATTEMPTED';
        stopSucceeded = false;
        destroySucceeded = false;
        leakStatus = 'UNKNOWN';
        resourceVerification = 'NOT_ATTEMPTED';
      } else {
        // create() was never invoked (e.g. capabilities check failed); verified no sandbox exists.
        stopStatus = 'NOT_ATTEMPTED';
        destroyStatus = 'NOT_ATTEMPTED';
        stopSucceeded = true;
        destroySucceeded = true;
        leakStatus = 'VERIFIED_CLEAN';
        resourceVerification = 'NOT_ATTEMPTED';
      }
    } else {
      stopSucceeded = stopStatus === 'COMPLETED';
      destroySucceeded = destroyStatus === 'COMPLETED';

      if (destroyStatus === 'COMPLETED') {
        // Destroy confirmation succeeded. Now attempt independent resource verification.
        const maybeProvider = this.provider as unknown as { liveSandboxCount?: unknown };
        if (typeof maybeProvider.liveSandboxCount === 'function') {
          try {
            const count = (maybeProvider as { liveSandboxCount: () => number }).liveSandboxCount();
            if (!Number.isSafeInteger(count) || count < 0) {
              resourceVerification = 'CHECK_FAILED';
              leakStatus = 'UNKNOWN';
            } else if (count === 0) {
              resourceVerification = 'VERIFIED_ZERO';
              leakStatus = 'VERIFIED_CLEAN';
            } else {
              resourceVerification = 'ACTIVE_RESOURCES_DETECTED';
              leakStatus = 'CONFIRMED_LEAK';
            }
          } catch {
            resourceVerification = 'CHECK_FAILED';
            leakStatus = 'UNKNOWN';
          }
        } else {
          // Provider does NOT implement an independent counting/audit hook (e.g., liveSandboxCount).
          // Destroy is confirmed (destroySucceeded = true), but independent verification is unsupported.
          resourceVerification = 'NOT_SUPPORTED';
          leakStatus = 'UNKNOWN';
        }
      } else if (destroyStatus === 'UNKNOWN') {
        resourceVerification = 'NOT_ATTEMPTED';
        leakStatus = 'UNKNOWN';
      } else {
        resourceVerification = 'NOT_ATTEMPTED';
        leakStatus = 'CONFIRMED_LEAK';
      }
    }

    const resourcesLeaked = leakStatus !== 'VERIFIED_CLEAN';

    const cleanupReport: SmokeCleanupReport = {
      stopStatus,
      destroyStatus,
      leakStatus,
      resourceVerification,
      stopSucceeded,
      destroySucceeded,
      resourcesLeaked,
      stopError: stopError !== undefined ? formatSanitizedError(stopError, 'stop') : undefined,
      destroyError:
        destroyError !== undefined ? formatSanitizedError(destroyError, 'destroy') : undefined,
    };

    const totalWallMs = Math.round((performance.now() - startWall) * 100) / 100;
    const timing: SmokeTimingReport = {
      totalWallMs,
      phaseDurationsMs: phaseDurations,
    };

    // Status resolution: PASS is strictly forbidden unless verified clean with successful destroy and all required phases PASS
    const allPhasesPassed = (Object.keys(phaseDetails) as SmokePhase[]).every(
      (phase) => phaseDetails[phase].status === 'PASS',
    );

    const overallStatus: SmokePhaseStatus =
      primaryError === null &&
      stopSucceeded &&
      destroySucceeded &&
      stopStatus === 'COMPLETED' &&
      destroyStatus === 'COMPLETED' &&
      resourceVerification === 'VERIFIED_ZERO' &&
      leakStatus === 'VERIFIED_CLEAN' &&
      !resourcesLeaked &&
      allPhasesPassed
        ? 'PASS'
        : 'FAIL';

    let errorMessage: string | null = null;
    if (primaryError !== null) {
      errorMessage = formatSanitizedError(primaryError, failedPhase ?? undefined);
      if (!destroySucceeded) {
        errorMessage += `; Cleanup failure: destroy ${destroyStatus.toLowerCase()} (${formatSanitizedError(destroyError, 'destroy')})`;
      } else if (leakStatus === 'UNKNOWN') {
        errorMessage += '; Cleanup status: resource state UNKNOWN after creation failure';
      }
    } else if (!destroySucceeded) {
      errorMessage = `Cleanup failure: destroy ${destroyStatus.toLowerCase()} (${formatSanitizedError(destroyError, 'destroy')})`;
    } else if (!stopSucceeded) {
      errorMessage = `Cleanup failure: stop ${stopStatus.toLowerCase()} (${formatSanitizedError(stopError, 'stop')})`;
    } else if (leakStatus !== 'VERIFIED_CLEAN') {
      errorMessage = `Cleanup failure: leak status ${leakStatus} (verification: ${resourceVerification})`;
    }

    const report: SmokeReport = {
      schemaVersion: SMOKE_SCHEMA_VERSION,
      testId,
      provider: 'fake',
      mode: 'LOCAL_SIMULATION',
      status: overallStatus === 'PASS' ? 'PASS' : 'FAIL',
      phases: phaseDetails,
      timing,
      usageSource: 'SIMULATED',
      usage: usageResult,
      realIsolationStatus: 'NOT_MEASURED',
      vendorColdStartMs: null,
      vendorCostUsd: null,
      costSource: 'NOT_MEASURED',
      capabilities: capabilitiesResult,
      cleanup: cleanupReport,
      error: errorMessage,
      limitations: SMOKE_LIMITATIONS,
    };

    return report;
  }
}

export async function runSandboxSmoke(options: SmokeRunnerOptions): Promise<SmokeReport> {
  const runner = new SandboxSmokeRunner(options.provider);
  return runner.run(options);
}
