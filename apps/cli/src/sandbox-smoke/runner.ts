import { randomUUID } from 'node:crypto';
import type {
  SandboxCapabilities,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import { formatSanitizedError } from './sanitize.js';
import {
  SMOKE_LIMITATIONS,
  SMOKE_SCHEMA_VERSION,
  type SmokeCleanupReport,
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

export class SandboxSmokeRunner {
  private readonly provider: SandboxProvider;

  constructor(provider: SandboxProvider) {
    this.provider = provider;
  }

  async run(options: Omit<SmokeRunnerOptions, 'provider'> = {}): Promise<SmokeReport> {
    const testId = randomUUID();
    const tenantId = options.tenantId ?? randomUUID();
    const runId = options.runId ?? randomUUID();
    const imageDigest = options.imageDigest ?? DEFAULT_FAKE_IMAGE_DIGEST;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const readyDeadlineMs = options.readyDeadlineMs ?? Math.min(timeoutMs, 5_000);
    const execTimeoutMs = options.execTimeoutMs ?? Math.min(timeoutMs, 5_000);
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
    let capabilitiesResult: SandboxCapabilities | null = null;
    let usageResult: SandboxUsageRecord | null = null;
    let primaryError: unknown = null;
    let stopError: unknown = undefined;
    let destroyError: unknown = undefined;

    const executePhase = async <T>(
      phase: SmokePhase,
      action: () => Promise<T>,
      detailsExtractor?: (result: T) => Record<string, unknown>,
    ): Promise<T> => {
      signal?.throwIfAborted();
      const phaseStart = performance.now();
      try {
        const result = await action();
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
        const durationMs = Math.round((performance.now() - phaseStart) * 100) / 100;
        phaseDurations[phase] = durationMs;
        phaseDetails[phase] = {
          phase,
          status: 'FAIL',
          durationMs,
          error: formatSanitizedError(err),
        };
        throw err;
      }
    };

    try {
      // Phase 1: Capabilities discovery
      capabilitiesResult = await executePhase(
        'capabilities',
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

      const createRes = await executePhase(
        'create',
        () => this.provider.create(spec),
        (res) => ({
          sandboxId: res.sandboxId,
        }),
      );
      sandboxId = createRes.sandboxId;

      // Phase 3: Wait for ready
      await executePhase('waitReady', () =>
        this.provider.waitReady(createRes.sandboxId, readyDeadlineMs),
      );

      // Phase 4: Allowlisted Exec
      const execRes = await executePhase(
        'exec',
        async () => {
          const res = await this.provider.exec(createRes.sandboxId, argv, execTimeoutMs);
          if (res.exitCode !== 0) {
            throw new Error(`Command exited with non-zero exit code: ${res.exitCode}`);
          }
          return res;
        },
        (res) => ({
          exitCode: res.exitCode,
          argv,
        }),
      );

      // Phase 5: Read stdout and stderr output
      await executePhase(
        'readOutput',
        async () => {
          const stdout = await this.provider.readOutput(createRes.sandboxId, execRes.stdoutRef);
          const stderr = await this.provider.readOutput(createRes.sandboxId, execRes.stderrRef);

          if (stdout !== expectedSha256) {
            throw new Error(`SHA-256 digest mismatch: expected ${expectedSha256}, got ${stdout}`);
          }
          return { stdout, stderr };
        },
        (output) => ({
          stdoutDigestMatches: true,
          stderrEmpty: output.stderr.length === 0,
        }),
      );

      // Phase 6: Usage telemetry
      usageResult = await executePhase(
        'usage',
        async () => {
          const usage = await this.provider.usage(createRes.sandboxId);
          if (
            typeof usage.cpuSeconds !== 'number' ||
            usage.cpuSeconds < 0 ||
            typeof usage.memoryGiBSeconds !== 'number' ||
            usage.memoryGiBSeconds < 0 ||
            typeof usage.egressBytes !== 'number' ||
            usage.egressBytes < 0
          ) {
            throw new Error('SandboxUsageRecord returned negative or invalid metrics');
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
          await this.provider.stop(sandboxId);
          const durationMs = Math.round((performance.now() - stopStart) * 100) / 100;
          phaseDurations.stop = durationMs;
          phaseDetails.stop = { phase: 'stop', status: 'PASS', durationMs };
        } catch (err) {
          stopError = err;
          const durationMs = Math.round((performance.now() - stopStart) * 100) / 100;
          phaseDurations.stop = durationMs;
          phaseDetails.stop = {
            phase: 'stop',
            status: 'FAIL',
            durationMs,
            error: formatSanitizedError(err),
          };
        }

        // Always attempt destroy, even if stop failed
        const destroyStart = performance.now();
        try {
          await this.provider.destroy(sandboxId);
          const durationMs = Math.round((performance.now() - destroyStart) * 100) / 100;
          phaseDurations.destroy = durationMs;
          phaseDetails.destroy = { phase: 'destroy', status: 'PASS', durationMs };
        } catch (err) {
          destroyError = err;
          const durationMs = Math.round((performance.now() - destroyStart) * 100) / 100;
          phaseDurations.destroy = durationMs;
          phaseDetails.destroy = {
            phase: 'destroy',
            status: 'FAIL',
            durationMs,
            error: formatSanitizedError(err),
          };
        }
      }
    }

    // Check if provider tracks live sandboxes
    let activeResourcesRemaining = false;
    const maybeProviderWithCount = this.provider as unknown as {
      liveSandboxCount?: () => number;
    };
    if (typeof maybeProviderWithCount.liveSandboxCount === 'function') {
      activeResourcesRemaining = maybeProviderWithCount.liveSandboxCount() > 0;
    }

    const stopSucceeded = sandboxId === null || stopError === undefined;
    const destroySucceeded = sandboxId === null || destroyError === undefined;
    const resourcesLeaked = !destroySucceeded || activeResourcesRemaining;

    const cleanupReport: SmokeCleanupReport = {
      stopSucceeded,
      destroySucceeded,
      resourcesLeaked,
      stopError: stopError !== undefined ? formatSanitizedError(stopError) : undefined,
      destroyError: destroyError !== undefined ? formatSanitizedError(destroyError) : undefined,
    };

    const totalWallMs = Math.round((performance.now() - startWall) * 100) / 100;
    const timing: SmokeTimingReport = {
      totalWallMs,
      phaseDurationsMs: phaseDurations,
    };

    // Status resolution: any failure in primary execution OR cleanup destroy means FAIL
    const overallStatus: SmokePhaseStatus =
      primaryError === null && stopSucceeded && destroySucceeded && !resourcesLeaked
        ? 'PASS'
        : 'FAIL';

    let errorMessage: string | null = null;
    if (primaryError !== null) {
      errorMessage = formatSanitizedError(primaryError);
      if (!destroySucceeded) {
        errorMessage += `; Cleanup failure: destroy failed (${formatSanitizedError(destroyError)})`;
      }
    } else if (!destroySucceeded) {
      errorMessage = `Cleanup failure: destroy failed (${formatSanitizedError(destroyError)})`;
    } else if (!stopSucceeded) {
      errorMessage = `Cleanup warning/failure: stop failed (${formatSanitizedError(stopError)})`;
    } else if (resourcesLeaked) {
      errorMessage = 'Cleanup failure: live sandboxes remaining after destroy';
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
