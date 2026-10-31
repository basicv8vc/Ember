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
import {
  SMOKE_SCHEMA_VERSION,
  SmokeReportSchema,
  type SmokeReport,
} from '../../apps/cli/src/sandbox-smoke/types.js';

function createMockProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
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
    ...overrides,
  };
}

describe('SandboxSmokeRunner', () => {
  it('executes complete fake lifecycle successfully and matches expected SHA-256', async () => {
    const tenantId = randomUUID();
    const provider = new FakeSandboxProvider({ tenantId });
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
    expect(report.cleanup.stopSucceeded).toBe(true);
    expect(report.cleanup.destroySucceeded).toBe(true);
    expect(report.cleanup.resourcesLeaked).toBe(false);
    expect(provider.liveSandboxCount()).toBe(0);

    // Schema validation
    const parsed = SmokeReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });

  it('fails when create fails and records SKIPPED cleanup without leaking', async () => {
    const provider = createMockProvider({
      create: () => Promise.reject(new Error('simulated create failure')),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.create.status).toBe('FAIL');
    expect(report.phases.create.error).toContain('simulated create failure');
    expect(report.phases.waitReady.status).toBe('SKIPPED');
    expect(report.phases.exec.status).toBe('SKIPPED');
    expect(report.phases.stop.status).toBe('SKIPPED');
    expect(report.phases.destroy.status).toBe('SKIPPED');
    expect(report.cleanup.resourcesLeaked).toBe(false);
    expect(report.error).toContain('simulated create failure');
  });

  it('fails when waitReady fails and runs stop and destroy', async () => {
    let stopCalled = false;
    let destroyCalled = false;
    const provider = createMockProvider({
      waitReady: () => Promise.reject(new Error('waitReady timed out')),
      stop: () => {
        stopCalled = true;
        return Promise.resolve();
      },
      destroy: () => {
        destroyCalled = true;
        return Promise.resolve();
      },
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.waitReady.status).toBe('FAIL');
    expect(report.phases.waitReady.error).toContain('waitReady timed out');
    expect(stopCalled).toBe(true);
    expect(destroyCalled).toBe(true);
    expect(report.phases.stop.status).toBe('PASS');
    expect(report.phases.destroy.status).toBe('PASS');
    expect(report.cleanup.stopSucceeded).toBe(true);
    expect(report.cleanup.destroySucceeded).toBe(true);
    expect(report.cleanup.resourcesLeaked).toBe(false);
  });

  it('fails when exec fails and runs stop and destroy', async () => {
    let stopCalled = false;
    let destroyCalled = false;
    const provider = createMockProvider({
      exec: () => Promise.reject(new Error('exec failed')),
      stop: () => {
        stopCalled = true;
        return Promise.resolve();
      },
      destroy: () => {
        destroyCalled = true;
        return Promise.resolve();
      },
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.exec.status).toBe('FAIL');
    expect(stopCalled).toBe(true);
    expect(destroyCalled).toBe(true);
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

  it('fails when readOutput fails and runs cleanup', async () => {
    const provider = createMockProvider({
      readOutput: () => Promise.reject(new Error('readOutput failed')),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.readOutput.status).toBe('FAIL');
    expect(report.cleanup.destroySucceeded).toBe(true);
  });

  it('fails when readOutput produces mismatched digest', async () => {
    const provider = createMockProvider({
      readOutput: () =>
        Promise.resolve(
          'bad-digest-0000000000000000000000000000000000000000000000000000000000000000',
        ),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.readOutput.status).toBe('FAIL');
    expect(report.phases.readOutput.error).toContain('digest mismatch');
    expect(report.cleanup.destroySucceeded).toBe(true);
  });

  it('fails when usage metrics are negative or invalid', async () => {
    const provider = createMockProvider({
      usage: () =>
        Promise.resolve({
          cpuSeconds: -1,
          memoryGiBSeconds: 0.1,
          egressBytes: 0,
        }),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.usage.status).toBe('FAIL');
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
    expect(report.cleanup.stopSucceeded).toBe(false);
    expect(report.cleanup.destroySucceeded).toBe(true);
    expect(report.cleanup.stopError).toContain('simulated stop error');
    expect(report.status).toBe('FAIL');
  });

  it('fails overall run when destroy fails, even if execution succeeded', async () => {
    const provider = createMockProvider({
      destroy: () => Promise.reject(new Error('simulated destroy error')),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.destroy.status).toBe('FAIL');
    expect(report.cleanup.destroySucceeded).toBe(false);
    expect(report.cleanup.resourcesLeaked).toBe(true);
    expect(report.cleanup.destroyError).toContain('simulated destroy error');
    expect(report.error).toContain('destroy failed');
  });

  it('preserves original execution error when destroy also fails', async () => {
    const provider = createMockProvider({
      exec: () => Promise.reject(new Error('original exec crash')),
      destroy: () => Promise.reject(new Error('secondary destroy failure')),
    });
    const runner = new SandboxSmokeRunner(provider);

    const report = await runner.run();

    expect(report.status).toBe('FAIL');
    expect(report.phases.exec.status).toBe('FAIL');
    expect(report.phases.destroy.status).toBe('FAIL');
    // Original error is prominently preserved, not masked as success or swallowed
    expect(report.error).toContain('original exec crash');
    expect(report.error).toContain('secondary destroy failure');
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

  it('SmokeReportSchema strictly denies spoofed isolation or cost fields', () => {
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
        stopSucceeded: true,
        destroySucceeded: true,
        resourcesLeaked: false,
      },
      error: null,
      limitations: ['limit-1'],
    };

    expect(SmokeReportSchema.safeParse(baseReport).success).toBe(true);

    // Spoofed realIsolationStatus as PASS or VERIFIED
    const spoofedIsolation = { ...baseReport, realIsolationStatus: 'VERIFIED' };
    expect(SmokeReportSchema.safeParse(spoofedIsolation).success).toBe(false);

    // Spoofed vendor cost
    const spoofedCost = { ...baseReport, vendorCostUsd: 0.05 };
    expect(SmokeReportSchema.safeParse(spoofedCost).success).toBe(false);

    // Spoofed cold start latency
    const spoofedColdStart = { ...baseReport, vendorColdStartMs: 120 };
    expect(SmokeReportSchema.safeParse(spoofedColdStart).success).toBe(false);

    // Spoofed costSource
    const spoofedCostSource = { ...baseReport, costSource: 'vendor_api' };
    expect(SmokeReportSchema.safeParse(spoofedCostSource).success).toBe(false);

    // Spoofed usageSource
    const spoofedUsageSource = { ...baseReport, usageSource: 'HARDWARE_METER' };
    expect(SmokeReportSchema.safeParse(spoofedUsageSource).success).toBe(false);
  });
});
