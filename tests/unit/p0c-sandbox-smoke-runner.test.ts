import { randomUUID } from 'node:crypto';
import type {
  SandboxCapabilities,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import { FakeSandboxProvider } from '@ember/execution';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_HELLO_EMBER_SHA256,
  SandboxSmokeRunner,
} from '../../apps/cli/src/sandbox-smoke/runner.js';
import { SmokeHarnessError } from '../../apps/cli/src/sandbox-smoke/sanitize.js';
import {
  SMOKE_SCHEMA_VERSION,
  SmokeReportSchema,
  type SmokeReport,
} from '../../apps/cli/src/sandbox-smoke/types.js';

function createMockProvider(
  overrides: Partial<SandboxProvider & { liveSandboxCount: () => number }> = {},
): SandboxProvider & { liveSandboxCount: () => number } {
  const dummySandboxId = randomUUID();
  const dummyStdoutRef = randomUUID();
  const dummyStderrRef = randomUUID();

  const defaultCapabilities: SandboxCapabilities = {
    shell: false,
    browser: false,
    filesystemSnapshot: false,
    memoryResume: false,
    diskSurvivesStop: false,
    forkFromSnapshot: false,
    persistentVolume: false,
    networkPolicy: false,
  };

  const defaultUsage: SandboxUsageRecord = {
    cpuSeconds: 0.001,
    memoryGiBSeconds: 0.0005,
    egressBytes: 0,
  };

  return {
    capabilities: () => Promise.resolve(defaultCapabilities),
    create: (_spec: SandboxSpec) => Promise.resolve({ sandboxId: dummySandboxId }),
    waitReady: (_sandboxId: Id, _deadlineMs: number) => Promise.resolve(),
    exec: (_sandboxId: Id, _argv: readonly string[], _timeoutMs: number) =>
      Promise.resolve({
        exitCode: 0,
        stdoutRef: dummyStdoutRef,
        stderrRef: dummyStderrRef,
      }),
    readOutput: (_sandboxId: Id, ref: Id) =>
      Promise.resolve(ref === dummyStdoutRef ? EXPECTED_HELLO_EMBER_SHA256 : ''),
    putFile: () => Promise.reject(new Error('unsupported')),
    getFile: () => Promise.reject(new Error('unsupported')),
    stop: (_sandboxId: Id) => Promise.resolve(),
    destroy: (_sandboxId: Id) => Promise.resolve(),
    usage: (_sandboxId: Id) => Promise.resolve(defaultUsage),
    liveSandboxCount: () => 0,
    ...overrides,
  };
}

describe('SandboxSmokeRunner', () => {
  it('executes complete fake lifecycle successfully and matches expected SHA-256', async () => {
    const tenantId = randomUUID();
    const provider = createMockProvider();
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run({ tenantId });

    expect(report.status).toBe('PASS');
    expect(report.schemaVersion).toBe(SMOKE_SCHEMA_VERSION);
    expect(report.provider).toBe('fake');
    expect(report.mode).toBe('LOCAL_SIMULATION');
    expect(report.realIsolationStatus).toBe('NOT_MEASURED');
    expect(report.vendorColdStartMs).toBeNull();
    expect(report.vendorCostUsd).toBeNull();
    expect(report.costSource).toBe('NOT_MEASURED');
    expect(report.usageSource).toBe('SIMULATED');
    expect(report.error).toBeNull();

    // Verify all phases passed
    expect(report.phases.capabilities.status).toBe('PASS');
    expect(report.phases.create.status).toBe('PASS');
    expect(report.phases.waitReady.status).toBe('PASS');
    expect(report.phases.exec.status).toBe('PASS');
    expect(report.phases.readOutput.status).toBe('PASS');
    expect(report.phases.usage.status).toBe('PASS');
    expect(report.phases.stop.status).toBe('PASS');
    expect(report.phases.destroy.status).toBe('PASS');

    // Verify stdout digest verification
    expect(report.phases.readOutput.details?.stdoutDigestMatches).toBe(true);

    // Verify cleanup
    expect(report.cleanup.stopStatus).toBe('COMPLETED');
    expect(report.cleanup.destroyStatus).toBe('COMPLETED');
    expect(report.cleanup.resourceVerification).toBe('VERIFIED_ZERO');
    expect(report.cleanup.leakStatus).toBe('VERIFIED_CLEAN');
    expect(report.cleanup.stopSucceeded).toBe(true);
    expect(report.cleanup.destroySucceeded).toBe(true);
    expect(report.cleanup.resourcesLeaked).toBe(false);

    // Schema validation
    const parsed = SmokeReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });

  it('marks leakStatus as UNKNOWN and resourcesLeaked as true when create() fails before returning sandboxId', async () => {
    const provider = createMockProvider({
      create: () => Promise.reject(new Error('simulated create failure in cloud provider')),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.create.status).toBe('FAIL');
    expect(report.phases.create.error).toContain('ERR_PROVIDER_EXECUTION');
    expect(report.phases.create.error).not.toContain('simulated create failure');
    expect(report.phases.waitReady.status).toBe('SKIPPED');
    expect(report.phases.exec.status).toBe('SKIPPED');
    expect(report.phases.stop.status).toBe('SKIPPED');
    expect(report.phases.destroy.status).toBe('SKIPPED');

    // Crucial P1 fix: cannot verify zero leakage when create fails mid-provisioning
    expect(report.cleanup.stopStatus).toBe('NOT_ATTEMPTED');
    expect(report.cleanup.destroyStatus).toBe('NOT_ATTEMPTED');
    expect(report.cleanup.resourceVerification).toBe('NOT_ATTEMPTED');
    expect(report.cleanup.leakStatus).toBe('UNKNOWN');
    expect(report.cleanup.resourcesLeaked).toBe(true);
    expect(report.cleanup.stopSucceeded).toBe(false);
    expect(report.cleanup.destroySucceeded).toBe(false);
    expect(report.error).toContain('ERR_PROVIDER_EXECUTION');
    expect(report.error).not.toContain('simulated create failure');
  });

  it('marks leakStatus as VERIFIED_CLEAN when capabilities check fails before create is attempted', async () => {
    const provider = createMockProvider({
      capabilities: () => Promise.reject(new Error('capabilities discovery failure')),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.capabilities.status).toBe('FAIL');
    expect(report.phases.capabilities.error).toContain('ERR_PROVIDER_EXECUTION');
    expect(report.phases.capabilities.error).not.toContain('capabilities discovery failure');
    expect(report.phases.create.status).toBe('SKIPPED');
    expect(report.cleanup.stopStatus).toBe('NOT_ATTEMPTED');
    expect(report.cleanup.destroyStatus).toBe('NOT_ATTEMPTED');
    expect(report.cleanup.resourceVerification).toBe('NOT_ATTEMPTED');
    expect(report.cleanup.leakStatus).toBe('VERIFIED_CLEAN');
    expect(report.cleanup.resourcesLeaked).toBe(false);
  });

  it('times out and fails within deterministic time when provider create() hangs', async () => {
    const provider = createMockProvider({
      create: () => new Promise<never>(() => {}), // Hanging promise that never resolves
    });
    const runner = new SandboxSmokeRunner(provider);

    const start = performance.now();
    const report = await runner.run({ timeoutMs: 100 });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000); // Exited promptly within bounded timeout
    expect(report.status).toBe('FAIL');
    expect(report.phases.create.status).toBe('FAIL');
    expect(report.phases.create.error).toContain('timed out');
    expect(report.cleanup.leakStatus).toBe('UNKNOWN');
    expect(report.cleanup.resourcesLeaked).toBe(true);
  });

  it('times out and executes cleanup when provider waitReady() hangs', async () => {
    let destroyCalled = false;
    const provider = createMockProvider({
      waitReady: () => new Promise<never>(() => {}), // Hanging promise that never resolves
      destroy: () => {
        destroyCalled = true;
        return Promise.resolve();
      },
    });
    const runner = new SandboxSmokeRunner(provider);

    const start = performance.now();
    const report = await runner.run({ timeoutMs: 100, readyDeadlineMs: 50 });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(report.status).toBe('FAIL');
    expect(report.phases.waitReady.status).toBe('FAIL');
    expect(report.phases.waitReady.error).toContain('timed out');
    expect(destroyCalled).toBe(true);
    expect(report.cleanup.destroyStatus).toBe('COMPLETED');
    expect(report.cleanup.leakStatus).toBe('VERIFIED_CLEAN');
  });

  it('times out safely when provider destroy() hangs and reports UNKNOWN leak status', async () => {
    const provider = createMockProvider({
      destroy: () => new Promise<never>(() => {}), // Hanging destroy promise
    });
    const runner = new SandboxSmokeRunner(provider);

    const start = performance.now();
    const report = await runner.run({ timeoutMs: 100 });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(report.status).toBe('FAIL');
    expect(report.phases.destroy.status).toBe('FAIL');
    expect(report.phases.destroy.error).toContain('timed out');
    expect(report.cleanup.destroyStatus).toBe('UNKNOWN');
    expect(report.cleanup.leakStatus).toBe('UNKNOWN');
    expect(report.cleanup.resourcesLeaked).toBe(true);
  });

  it('does not leak raw argv or user input in exec details', async () => {
    const provider = createMockProvider();
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run({
      argv: ['sha256', 'super-secret-user-prompt-content'],
    });

    expect(report.status).toBe('PASS');
    expect(report.phases.exec.details?.argv).toBeUndefined(); // Raw argv must NOT be stored
    expect(report.phases.exec.details?.operation).toBe('sha256');
    expect(JSON.stringify(report.phases.exec)).not.toContain('super-secret-user-prompt-content');
  });

  it('does not leak raw provider output in SHA-256 mismatch error message', async () => {
    const sensitiveOutput = 'SECRET_TOKEN_OR_OUTPUT_123456789';
    const provider = createMockProvider({
      readOutput: () => Promise.resolve(sensitiveOutput),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.readOutput.status).toBe('FAIL');
    expect(report.phases.readOutput.error).toContain('DIGEST_MISMATCH');
    // Critical: error message must NOT echo raw provider output
    expect(report.phases.readOutput.error).not.toContain(sensitiveOutput);
    expect(report.error).not.toContain(sensitiveOutput);
  });

  it('strictly rejects non-finite metrics in usage (NaN, Infinity, -Infinity)', async () => {
    for (const badValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const provider = createMockProvider({
        usage: () =>
          Promise.resolve({
            cpuSeconds: badValue,
            memoryGiBSeconds: 0.1,
            egressBytes: 0,
          }),
      });
      const runner = new SandboxSmokeRunner(provider);

      const report = await runner.run();

      expect(report.status).toBe('FAIL');
      expect(report.phases.usage.status).toBe('FAIL');
      expect(report.phases.usage.error).toContain('non-finite or negative metrics');
    }
  });

  it('fails when exec returns non-zero exit code', async () => {
    const provider = createMockProvider({
      exec: () =>
        Promise.resolve({
          exitCode: 137,
          stdoutRef: randomUUID(),
          stderrRef: randomUUID(),
        }),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.exec.status).toBe('FAIL');
    expect(report.phases.exec.error).toContain('137');
    expect(report.cleanup.stopSucceeded).toBe(true);
    expect(report.cleanup.destroySucceeded).toBe(true);
  });

  it('still calls destroy when stop fails, reporting stop failure', async () => {
    let destroyCalled = false;
    const provider = createMockProvider({
      stop: () => Promise.reject(new Error('simulated stop error')),
      destroy: () => {
        destroyCalled = true;
        return Promise.resolve();
      },
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(destroyCalled).toBe(true);
    expect(report.phases.stop.status).toBe('FAIL');
    expect(report.phases.destroy.status).toBe('PASS');
    expect(report.cleanup.stopStatus).toBe('FAILED');
    expect(report.cleanup.destroyStatus).toBe('COMPLETED');
    expect(report.cleanup.stopSucceeded).toBe(false);
    expect(report.cleanup.destroySucceeded).toBe(true);
    expect(report.cleanup.stopError).toContain('ERR_PROVIDER_EXECUTION');
    expect(report.cleanup.stopError).not.toContain('simulated stop error');
    expect(report.status).toBe('FAIL');
  });

  it('fails overall run when destroy fails, reporting CONFIRMED_LEAK', async () => {
    const provider = createMockProvider({
      destroy: () => Promise.reject(new Error('simulated destroy error')),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.destroy.status).toBe('FAIL');
    expect(report.cleanup.destroyStatus).toBe('FAILED');
    expect(report.cleanup.leakStatus).toBe('CONFIRMED_LEAK');
    expect(report.cleanup.destroySucceeded).toBe(false);
    expect(report.cleanup.resourcesLeaked).toBe(true);
    expect(report.cleanup.destroyError).toContain('ERR_PROVIDER_EXECUTION');
    expect(report.cleanup.destroyError).not.toContain('simulated destroy error');
    expect(report.error).toContain('destroy failed');
  });

  it('preserves failure status when destroy also fails', async () => {
    const provider = createMockProvider({
      exec: () => Promise.reject(new Error('original exec crash')),
      destroy: () => Promise.reject(new Error('secondary destroy failure')),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.exec.status).toBe('FAIL');
    expect(report.phases.destroy.status).toBe('FAIL');
    expect(report.error).toContain('ERR_PROVIDER_EXECUTION');
    expect(report.error).not.toContain('original exec crash');
    expect(report.error).not.toContain('secondary destroy failure');
  });

  it('handles AbortSignal cancellation during execution and cleans up', async () => {
    let destroyCalled = false;
    const controller = new AbortController();
    const provider = createMockProvider({
      waitReady: () => {
        controller.abort(new Error('Execution cancelled'));
        return Promise.resolve();
      },
      destroy: () => {
        destroyCalled = true;
        return Promise.resolve();
      },
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run({ signal: controller.signal });

    expect(report.status).toBe('FAIL');
    expect(destroyCalled).toBe(true);
  });

  it('rejects cross-tenant sandbox spec with POLICY_DENIED', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const provider = new FakeSandboxProvider({ tenantId: tenantA });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run({
      tenantId: tenantA,
      specOverrides: { tenantId: tenantB },
    });

    expect(report.status).toBe('FAIL');
    expect(report.phases.create.status).toBe('FAIL');
    expect(report.phases.create.error).toContain('POLICY_DENIED');
    expect(provider.liveSandboxCount()).toBe(0);
  });

  it('rejects unsupported snapshot restoreRef with POLICY_DENIED', async () => {
    const tenantId = randomUUID();
    const provider = new FakeSandboxProvider({ tenantId });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run({
      tenantId,
      specOverrides: { restoreRef: 'checkpoint-123' },
    });

    expect(report.status).toBe('FAIL');
    expect(report.phases.create.status).toBe('FAIL');
    expect(report.phases.create.error).toContain('POLICY_DENIED');
    expect(provider.liveSandboxCount()).toBe(0);
  });

  it('SmokeReportSchema strictly denies spoofed isolation, costs, or inconsistent cleanups', () => {
    const baseReport: SmokeReport = {
      schemaVersion: SMOKE_SCHEMA_VERSION,
      testId: randomUUID(),
      provider: 'fake',
      mode: 'LOCAL_SIMULATION',
      status: 'PASS',
      phases: {
        capabilities: { phase: 'capabilities', status: 'PASS', durationMs: 1 },
        create: { phase: 'create', status: 'PASS', durationMs: 1 },
        waitReady: { phase: 'waitReady', status: 'PASS', durationMs: 1 },
        exec: { phase: 'exec', status: 'PASS', durationMs: 1 },
        readOutput: { phase: 'readOutput', status: 'PASS', durationMs: 1 },
        usage: { phase: 'usage', status: 'PASS', durationMs: 1 },
        stop: { phase: 'stop', status: 'PASS', durationMs: 1 },
        destroy: { phase: 'destroy', status: 'PASS', durationMs: 1 },
      },
      timing: {
        totalWallMs: 8,
        phaseDurationsMs: {
          capabilities: 1,
          create: 1,
          waitReady: 1,
          exec: 1,
          readOutput: 1,
          usage: 1,
          stop: 1,
          destroy: 1,
        },
      },
      usageSource: 'SIMULATED',
      usage: { cpuSeconds: 0.1, memoryGiBSeconds: 0.05, egressBytes: 0 },
      realIsolationStatus: 'NOT_MEASURED',
      vendorColdStartMs: null,
      vendorCostUsd: null,
      costSource: 'NOT_MEASURED',
      capabilities: {
        shell: false,
        browser: false,
        filesystemSnapshot: false,
        memoryResume: false,
        diskSurvivesStop: false,
        forkFromSnapshot: false,
        persistentVolume: false,
        networkPolicy: false,
      },
      cleanup: {
        stopStatus: 'COMPLETED',
        destroyStatus: 'COMPLETED',
        leakStatus: 'VERIFIED_CLEAN',
        resourceVerification: 'VERIFIED_ZERO',
        stopSucceeded: true,
        destroySucceeded: true,
        resourcesLeaked: false,
      },
      error: null,
      limitations: ['limit-1'],
    };

    expect(SmokeReportSchema.safeParse(baseReport).success).toBe(true);

    // Spoofed realIsolationStatus as PASS or VERIFIED
    expect(
      SmokeReportSchema.safeParse({ ...baseReport, realIsolationStatus: 'VERIFIED' }).success,
    ).toBe(false);

    // Spoofed vendor cost
    expect(SmokeReportSchema.safeParse({ ...baseReport, vendorCostUsd: 0.05 }).success).toBe(false);

    // Spoofed cold start latency
    expect(SmokeReportSchema.safeParse({ ...baseReport, vendorColdStartMs: 120 }).success).toBe(
      false,
    );

    // Inconsistent PASS: leakStatus is UNKNOWN
    expect(
      SmokeReportSchema.safeParse({
        ...baseReport,
        cleanup: { ...baseReport.cleanup, leakStatus: 'UNKNOWN' },
      }).success,
    ).toBe(false);

    // Inconsistent PASS: resourcesLeaked is true
    expect(
      SmokeReportSchema.safeParse({
        ...baseReport,
        cleanup: { ...baseReport.cleanup, resourcesLeaked: true },
      }).success,
    ).toBe(false);

    // Inconsistent PASS: destroyStatus is FAILED
    expect(
      SmokeReportSchema.safeParse({
        ...baseReport,
        cleanup: { ...baseReport.cleanup, destroyStatus: 'FAILED', destroySucceeded: false },
      }).success,
    ).toBe(false);

    // Inconsistent PASS: stopStatus is FAILED
    expect(
      SmokeReportSchema.safeParse({
        ...baseReport,
        cleanup: { ...baseReport.cleanup, stopStatus: 'FAILED', stopSucceeded: false },
      }).success,
    ).toBe(false);

    // Inconsistent PASS: stopSucceeded is false
    expect(
      SmokeReportSchema.safeParse({
        ...baseReport,
        cleanup: { ...baseReport.cleanup, stopSucceeded: false },
      }).success,
    ).toBe(false);

    // Inconsistent PASS: resourceVerification is not VERIFIED_ZERO
    expect(
      SmokeReportSchema.safeParse({
        ...baseReport,
        cleanup: {
          ...baseReport.cleanup,
          resourceVerification: 'NOT_SUPPORTED',
          leakStatus: 'UNKNOWN',
        },
      }).success,
    ).toBe(false);

    // Inconsistent PASS: a required phase failed
    expect(
      SmokeReportSchema.safeParse({
        ...baseReport,
        phases: {
          ...baseReport.phases,
          exec: { ...baseReport.phases.exec, status: 'FAIL', error: 'failed' },
        },
      }).success,
    ).toBe(false);

    // Inconsistent PASS: a required phase skipped
    expect(
      SmokeReportSchema.safeParse({
        ...baseReport,
        phases: {
          ...baseReport.phases,
          create: { ...baseReport.phases.create, status: 'SKIPPED' },
        },
      }).success,
    ).toBe(false);
  });

  it('strictly excludes arbitrary sensitive strings injected into provider errors across all lifecycle phases', async () => {
    const sensitiveStrings = [
      'SUPER_SECRET_DB_PASSWORD_1234567890',
      'postgres://admin:top_secret_credentials@internal-db:5432/ember',
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive-jwt-token',
      'sk-live-0987654321fedcba-api-key',
      'internal-cluster-token: secret-internal-token-xyz',
    ];

    for (const secret of sensitiveStrings) {
      // 1. Error in capabilities
      {
        const provider = createMockProvider({
          capabilities: () => Promise.reject(new Error(`Fatal: ${secret}`)),
        });
        const runner = new SandboxSmokeRunner(provider);
        const report = await runner.run();
        expect(report.status).toBe('FAIL');
        expect(report.phases.capabilities.error).toContain('ERR_PROVIDER_EXECUTION');
        expect(JSON.stringify(report)).not.toContain(secret);
      }

      // 2. Error in create
      {
        const provider = createMockProvider({
          create: () => Promise.reject(new Error(`Failed to provision sandbox: ${secret}`)),
        });
        const runner = new SandboxSmokeRunner(provider);
        const report = await runner.run();
        expect(report.status).toBe('FAIL');
        expect(report.phases.create.error).toContain('ERR_PROVIDER_EXECUTION');
        expect(JSON.stringify(report)).not.toContain(secret);
      }

      // 3. Error in waitReady
      {
        const provider = createMockProvider({
          waitReady: () => Promise.reject(new Error(`Sandbox startup crashed with ${secret}`)),
        });
        const runner = new SandboxSmokeRunner(provider);
        const report = await runner.run();
        expect(report.status).toBe('FAIL');
        expect(report.phases.waitReady.error).toContain('ERR_PROVIDER_EXECUTION');
        expect(JSON.stringify(report)).not.toContain(secret);
      }

      // 4. Error in exec
      {
        const provider = createMockProvider({
          exec: () => Promise.reject(new Error(`Command failed due to: ${secret}`)),
        });
        const runner = new SandboxSmokeRunner(provider);
        const report = await runner.run();
        expect(report.status).toBe('FAIL');
        expect(report.phases.exec.error).toContain('ERR_PROVIDER_EXECUTION');
        expect(JSON.stringify(report)).not.toContain(secret);
      }

      // 5. Error in stop
      {
        const provider = createMockProvider({
          stop: () => Promise.reject(new Error(`Stop hook crashed: ${secret}`)),
        });
        const runner = new SandboxSmokeRunner(provider);
        const report = await runner.run();
        expect(report.status).toBe('FAIL');
        expect(report.cleanup.stopError).toContain('ERR_PROVIDER_EXECUTION');
        expect(JSON.stringify(report)).not.toContain(secret);
      }

      // 6. Error in destroy
      {
        const provider = createMockProvider({
          destroy: () => Promise.reject(new Error(`Destroy hook failed: ${secret}`)),
        });
        const runner = new SandboxSmokeRunner(provider);
        const report = await runner.run();
        expect(report.status).toBe('FAIL');
        expect(report.cleanup.destroyError).toContain('ERR_PROVIDER_EXECUTION');
        expect(JSON.stringify(report)).not.toContain(secret);
      }
    }
  });

  it('distinguishes destroy confirmation from independent verification when liveSandboxCount is not supported', async () => {
    const providerWithoutLiveCount = createMockProvider();
    delete (providerWithoutLiveCount as { liveSandboxCount?: unknown }).liveSandboxCount;

    const runner = new SandboxSmokeRunner(providerWithoutLiveCount);
    const report = await runner.run();

    expect(report.cleanup.destroyStatus).toBe('COMPLETED');
    expect(report.cleanup.destroySucceeded).toBe(true);
    expect(report.cleanup.resourceVerification).toBe('NOT_SUPPORTED');
    expect(report.cleanup.leakStatus).toBe('UNKNOWN');
    expect(report.cleanup.resourcesLeaked).toBe(true);
    expect(report.status).toBe('FAIL');
    expect(report.error).toContain('leak status UNKNOWN');
  });

  it('marks resourceVerification as CHECK_FAILED and leakStatus as UNKNOWN when liveSandboxCount throws', async () => {
    const sensitiveAuditError = 'CRITICAL_AUDIT_DAEMON_CRASH_SECRET_9876';
    const provider = createMockProvider({
      liveSandboxCount: () => {
        throw new Error(sensitiveAuditError);
      },
    });

    const runner = new SandboxSmokeRunner(provider);
    const report = await runner.run();

    expect(report.cleanup.destroyStatus).toBe('COMPLETED');
    expect(report.cleanup.destroySucceeded).toBe(true);
    expect(report.cleanup.resourceVerification).toBe('CHECK_FAILED');
    expect(report.cleanup.leakStatus).toBe('UNKNOWN');
    expect(report.cleanup.resourcesLeaked).toBe(true);
    expect(report.status).toBe('FAIL');
    expect(JSON.stringify(report)).not.toContain(sensitiveAuditError);
  });

  it('marks resourceVerification as ACTIVE_RESOURCES_DETECTED and leakStatus as CONFIRMED_LEAK when liveSandboxCount returns positive', async () => {
    const provider = createMockProvider({
      liveSandboxCount: () => 2,
    });

    const runner = new SandboxSmokeRunner(provider);
    const report = await runner.run();

    expect(report.cleanup.destroyStatus).toBe('COMPLETED');
    expect(report.cleanup.destroySucceeded).toBe(true);
    expect(report.cleanup.resourceVerification).toBe('ACTIVE_RESOURCES_DETECTED');
    expect(report.cleanup.leakStatus).toBe('CONFIRMED_LEAK');
    expect(report.cleanup.resourcesLeaked).toBe(true);
    expect(report.status).toBe('FAIL');
  });

  it('Class 1 Spoofing in Runner: provider exceptions with spoofed message substrings never bypass error sanitization or manipulate cleanup state', async () => {
    // 1. exec phase message spoofing
    {
      const provider = createMockProvider({
        exec: () => Promise.reject(new Error('INJECTED_EXEC_SECRET [ERR_PHASE_TIMEOUT]')),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.status).toBe('FAIL');
      expect(report.phases.exec.status).toBe('FAIL');
      expect(report.phases.exec.error).toBe(
        'Provider operation failed during exec [ERR_PROVIDER_EXECUTION]',
      );
      expect(JSON.stringify(report)).not.toContain('INJECTED_EXEC_SECRET');
    }

    // 2. stop phase message spoofing (must NOT trick runner into UNKNOWN status)
    {
      const provider = createMockProvider({
        stop: () => Promise.reject(new Error('INJECTED_STOP_SECRET timed out [ERR_PHASE_TIMEOUT]')),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.cleanup.stopStatus).toBe('FAILED');
      expect(report.cleanup.stopError).toBe(
        'Provider operation failed during stop [ERR_PROVIDER_EXECUTION]',
      );
      expect(JSON.stringify(report)).not.toContain('INJECTED_STOP_SECRET');
    }

    // 3. destroy phase message spoofing (must NOT trick runner into UNKNOWN status)
    {
      const provider = createMockProvider({
        destroy: () =>
          Promise.reject(new Error('INJECTED_DESTROY_SECRET timed out [ERR_PHASE_TIMEOUT]')),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.cleanup.destroyStatus).toBe('FAILED');
      expect(report.cleanup.destroyError).toBe(
        'Provider operation failed during destroy [ERR_PROVIDER_EXECUTION]',
      );
      expect(JSON.stringify(report)).not.toContain('INJECTED_DESTROY_SECRET');
    }
  });

  it('Class 2 Spoofing in Runner: provider exceptions with spoofed code properties or duck-typed shapes never bypass error sanitization or manipulate cleanup state', async () => {
    // 1. exec phase code spoofing
    {
      const spoofedErr = new Error('POLICY_BYPASS_ATTEMPT_LEAK');
      Object.assign(spoofedErr, { code: 'POLICY_DENIED' });

      const provider = createMockProvider({
        exec: () => Promise.reject(spoofedErr),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.status).toBe('FAIL');
      expect(report.phases.exec.status).toBe('FAIL');
      expect(report.phases.exec.error).toBe(
        'Provider operation failed during exec [ERR_PROVIDER_EXECUTION]',
      );
      expect(JSON.stringify(report)).not.toContain('POLICY_DENIED');
      expect(JSON.stringify(report)).not.toContain('POLICY_BYPASS_ATTEMPT_LEAK');
    }

    // 2. stop phase code spoofing (attempting to force UNKNOWN via .code = ERR_PHASE_TIMEOUT)
    {
      const spoofedTimeout = new Error('STOP_TIMEOUT_CODE_LEAK');
      Object.assign(spoofedTimeout, { code: 'ERR_PHASE_TIMEOUT' });

      const provider = createMockProvider({
        stop: () => Promise.reject(spoofedTimeout),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.cleanup.stopStatus).toBe('FAILED');
      expect(report.cleanup.stopError).toBe(
        'Provider operation failed during stop [ERR_PROVIDER_EXECUTION]',
      );
      expect(JSON.stringify(report)).not.toContain('STOP_TIMEOUT_CODE_LEAK');
    }

    // 3. destroy phase duck-typing spoofing
    {
      const forgedError = Object.assign(new Error('DUCK_TYPED_DESTROY_LEAK'), {
        name: 'SmokeHarnessError',
        code: 'ERR_PHASE_TIMEOUT',
      });

      const provider = createMockProvider({
        destroy: () => Promise.reject(forgedError),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.cleanup.destroyStatus).toBe('FAILED');
      expect(report.cleanup.destroyError).toBe(
        'Provider operation failed during destroy [ERR_PROVIDER_EXECUTION]',
      );
      expect(JSON.stringify(report)).not.toContain('DUCK_TYPED_DESTROY_LEAK');
    }
  });

  it('Adversarial Boundary Test: Provider directly throwing genuine SmokeHarnessError never leaks sensitive content and cannot disguise cleanup failure as timeout', async () => {
    const sensitiveDoc = 'PRIVATE_CUSTOMER_DOCUMENT_9988776655';

    // 1. Provider directly throws real SmokeHarnessError during exec
    {
      const maliciousRealErr = new SmokeHarnessError('ERR_EXEC_FAILED', {
        exitCode: 42,
      });
      Object.assign(maliciousRealErr, {
        message: `${sensitiveDoc} [ERR_EXEC_FAILED]`,
        customerPii: sensitiveDoc,
      });

      const provider = createMockProvider({
        exec: () => Promise.reject(maliciousRealErr),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.status).toBe('FAIL');
      expect(report.phases.exec.status).toBe('FAIL');
      // Intercepted at provider invocation boundary, mapped to fixed safe message:
      expect(report.phases.exec.error).toBe(
        'Provider operation failed during exec [ERR_PROVIDER_EXECUTION]',
      );
      expect(JSON.stringify(report)).not.toContain(sensitiveDoc);
    }

    // 2. Provider directly throws real SmokeHarnessError during stop (cannot spoof timeout into UNKNOWN)
    {
      const realTimeoutErr = new SmokeHarnessError('ERR_PHASE_TIMEOUT', {
        phase: 'stop',
        timeoutMs: 3000,
      });

      const provider = createMockProvider({
        stop: () => Promise.reject(realTimeoutErr),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.cleanup.stopStatus).toBe('FAILED');
      expect(report.cleanup.stopStatus).not.toBe('UNKNOWN');
      expect(report.cleanup.stopError).toBe(
        'Provider operation failed during stop [ERR_PROVIDER_EXECUTION]',
      );
    }

    // 3. Provider directly throws real SmokeHarnessError during destroy (cannot spoof timeout into UNKNOWN)
    {
      const realTimeoutErr = new SmokeHarnessError('ERR_PHASE_TIMEOUT', {
        phase: 'destroy',
        timeoutMs: 3000,
      });

      const provider = createMockProvider({
        destroy: () => Promise.reject(realTimeoutErr),
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.cleanup.destroyStatus).toBe('FAILED');
      expect(report.cleanup.destroyStatus).not.toBe('UNKNOWN');
      expect(report.cleanup.destroyError).toBe(
        'Provider operation failed during destroy [ERR_PROVIDER_EXECUTION]',
      );
    }

    // 4. Provider throws synchronously during capabilities
    {
      const provider = createMockProvider({
        capabilities: () => {
          throw new SmokeHarnessError('ERR_OPERATION_ABORTED', { phase: 'capabilities' });
        },
      });
      const runner = new SandboxSmokeRunner(provider);
      const report = await runner.run();

      expect(report.status).toBe('FAIL');
      expect(report.phases.capabilities.status).toBe('FAIL');
      expect(report.phases.capabilities.error).toBe(
        'Provider operation failed during capabilities [ERR_PROVIDER_EXECUTION]',
      );
    }
  });
});
