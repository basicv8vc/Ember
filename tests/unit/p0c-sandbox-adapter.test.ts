import { randomUUID } from 'node:crypto';
import type {
  RouteDecision,
  RunExecutionContext,
  SandboxCapabilities,
  SandboxProvider,
  SandboxProviderFactory,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import { DomainError, type Id, isDomainError } from '@ember/domain';
import {
  defaultFakeSandboxFactory,
  DeterministicExecutor,
  FakeSandboxProvider,
  FakeSandboxProviderFactory,
  SandboxAdapter,
  sanitizeProviderError,
} from '@ember/execution';
import { describe, expect, it } from 'vitest';

const DUMMY_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const DUMMY_RUN_ID = '22222222-2222-4222-8222-222222222222';
const EXPECTED_DIGEST = '5a7f924557ee634c065ca4fc1074847e6cbdb53db18ffa5bea647a62e3c6fcf0';

const DEFAULT_ROUTE: RouteDecision = {
  path: 'standard',
  reason: 'default',
  policyVersion: 1,
};

function createContext(overrides: Partial<RunExecutionContext> = {}): RunExecutionContext {
  return {
    tenantId: DUMMY_TENANT_ID,
    taskId: randomUUID(),
    runId: DUMMY_RUN_ID,
    agentId: randomUUID(),
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: '2026-11-01T00:05:00.000Z',
    deadlineAt: null,
    policyVersion: 1,
    kind: 'mock.compute',
    input: { text: 'hello ember', operation: 'sha256' },
    workerId: 'worker-test',
    ...overrides,
  };
}

async function attempt<T>(fn: () => Promise<T>): Promise<unknown> {
  try {
    return await fn();
  } catch (error: unknown) {
    return error;
  }
}

function createDummySpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    tenantId: DUMMY_TENANT_ID,
    runId: DUMMY_RUN_ID,
    imageDigest: 'sha256:ember-fake-sandbox-v1',
    cpuMilli: 250,
    memoryMiB: 256,
    maxLifetimeSec: 60,
    networkPolicyId: 'policy-default',
    ...overrides,
  };
}

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
      Promise.resolve(ref === dummyStdoutRef ? EXPECTED_DIGEST : ''),
    putFile: () => Promise.reject(new Error('unsupported')),
    getFile: () => Promise.reject(new Error('unsupported')),
    stop: (_sandboxId: Id) => Promise.resolve(),
    destroy: (_sandboxId: Id) => Promise.resolve(),
    usage: (_sandboxId: Id) => Promise.resolve(defaultUsage),
    liveSandboxCount: () => 0,
    ...overrides,
  };
}

describe('SandboxAdapter', () => {
  describe('Full Lifecycle run()', () => {
    it('executes normal lifecycle successfully with FakeSandboxProvider and cleans up', async () => {
      const provider = new FakeSandboxProvider({ tenantId: DUMMY_TENANT_ID });
      const adapter = new SandboxAdapter(provider);

      expect(adapter.underlyingProvider).toBe(provider);

      const res = await adapter.run({
        spec: createDummySpec(),
        argv: ['sha256', 'hello ember'],
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe(EXPECTED_DIGEST);
      expect(res.digest).toBe(EXPECTED_DIGEST);
      expect(res.stderr).toBe('');
      expect(res.usage.cpuSeconds).toBeGreaterThan(0);
      expect(res.usage.memoryGiBSeconds).toBeGreaterThan(0);

      // Verify cleanup: 0 live sandboxes remaining
      expect(provider.liveSandboxCount()).toBe(0);
      expect(adapter.liveSandboxCount()).toBe(0);
      expect(adapter.sandboxState(res.sandboxId)).toBe('destroyed');
    });

    it('guarantees stop and destroy in finally when exec fails', async () => {
      let stopCalled = false;
      let destroyCalled = false;

      const provider = createMockProvider({
        exec: () =>
          Promise.resolve({
            exitCode: 1,
            stdoutRef: randomUUID(),
            stderrRef: randomUUID(),
          }),
        stop: () => {
          stopCalled = true;
          return Promise.resolve();
        },
        destroy: () => {
          destroyCalled = true;
          return Promise.resolve();
        },
      });

      const adapter = new SandboxAdapter(provider);

      await expect(
        adapter.run({
          spec: createDummySpec(),
          argv: ['sha256', 'test'],
        }),
      ).rejects.toThrow(DomainError);

      expect(stopCalled).toBe(true);
      expect(destroyCalled).toBe(true);
    });
  });

  describe('Step-by-Step Lifecycle & State Transitions', () => {
    it('enforces sequential lifecycle transitions: create -> waitReady -> exec -> readOutput -> usage -> stop -> destroy', async () => {
      const provider = new FakeSandboxProvider({ tenantId: DUMMY_TENANT_ID });
      const adapter = new SandboxAdapter(provider);

      // 1. Capabilities
      const caps = await adapter.capabilities();
      expect(caps.shell).toBe(false);

      // 2. Create
      const { sandboxId } = await adapter.create(createDummySpec());
      expect(adapter.sandboxState(sandboxId)).toBe('created');

      // Out of order: exec before waitReady must be rejected
      const execErr = await attempt(() => adapter.exec(sandboxId, ['sha256', 'test']));
      expect(isDomainError(execErr)).toBe(true);
      expect((execErr as DomainError).code).toBe('SANDBOX_NOT_READY');
      expect((execErr as DomainError).diagnostic).toContain('sandbox is not ready for exec');

      // 3. waitReady
      await adapter.waitReady(sandboxId, 1000);
      expect(adapter.sandboxState(sandboxId)).toBe('ready');

      // Idempotent waitReady
      await adapter.waitReady(sandboxId, 1000);
      expect(adapter.sandboxState(sandboxId)).toBe('ready');

      // Out of order: readOutput before exec must be rejected
      const readErr = await attempt(() => adapter.readOutput(sandboxId, randomUUID()));
      expect(isDomainError(readErr)).toBe(true);
      expect((readErr as DomainError).code).toBe('SANDBOX_NOT_READY');
      expect((readErr as DomainError).diagnostic).toContain(
        'cannot read output before exec has completed',
      );

      // 4. Exec
      const execRes = await adapter.exec(sandboxId, ['sha256', 'hello ember'], 1000);
      expect(execRes.exitCode).toBe(0);
      expect(adapter.sandboxState(sandboxId)).toBe('executed');

      // 5. Read output
      const stdout = await adapter.readOutput(sandboxId, execRes.stdoutRef);
      expect(stdout).toBe(EXPECTED_DIGEST);

      // 6. Usage
      const usage = await adapter.usage(sandboxId);
      expect(usage.cpuSeconds).toBeGreaterThan(0);

      // 7. Stop
      await adapter.stop(sandboxId);
      expect(adapter.sandboxState(sandboxId)).toBe('stopped');

      // 8. Destroy
      await adapter.destroy(sandboxId);
      expect(adapter.sandboxState(sandboxId)).toBe('destroyed');

      // Usage after destroy fails
      const destroyUsageErr = await attempt(() => adapter.usage(sandboxId));
      expect(isDomainError(destroyUsageErr)).toBe(true);
      expect((destroyUsageErr as DomainError).code).toBe('SANDBOX_NOT_READY');
      expect((destroyUsageErr as DomainError).diagnostic).toContain(
        'cannot read usage after destroy',
      );
    });

    it('rejects waitReady on unknown or uncreated sandboxId', async () => {
      const provider = new FakeSandboxProvider({ tenantId: DUMMY_TENANT_ID });
      const adapter = new SandboxAdapter(provider);

      await expect(adapter.waitReady(randomUUID())).rejects.toThrow(DomainError);
    });
  });

  describe('Bounded Timeouts & Cancellation', () => {
    it('times out when provider create() hangs', async () => {
      const provider = createMockProvider({
        create: () => new Promise<never>(() => {}),
      });

      const adapter = new SandboxAdapter(provider, { execTimeoutMs: 50 });

      const start = performance.now();
      await expect(adapter.create(createDummySpec())).rejects.toThrow(DomainError);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(1000);
    });

    it('times out when provider waitReady() hangs', async () => {
      let destroyCalled = false;
      const provider = createMockProvider({
        waitReady: () => new Promise<never>(() => {}),
        destroy: () => {
          destroyCalled = true;
          return Promise.resolve();
        },
      });

      const adapter = new SandboxAdapter(provider, { readyDeadlineMs: 50 });

      await expect(
        adapter.run({
          spec: createDummySpec(),
          argv: ['sha256', 'test'],
          readyDeadlineMs: 50,
        }),
      ).rejects.toThrow(DomainError);

      expect(destroyCalled).toBe(true);
    });

    it('times out when provider exec() hangs', async () => {
      let destroyCalled = false;
      const provider = createMockProvider({
        exec: () => new Promise<never>(() => {}),
        destroy: () => {
          destroyCalled = true;
          return Promise.resolve();
        },
      });

      const adapter = new SandboxAdapter(provider, { execTimeoutMs: 50 });

      await expect(
        adapter.run({
          spec: createDummySpec(),
          argv: ['sha256', 'test'],
          execTimeoutMs: 50,
        }),
      ).rejects.toThrow(DomainError);

      expect(destroyCalled).toBe(true);
    });

    it('handles pre-aborted signal without calling provider create', async () => {
      let createCalled = false;
      const provider = createMockProvider({
        create: () => {
          createCalled = true;
          return Promise.resolve({ sandboxId: randomUUID() });
        },
      });

      const adapter = new SandboxAdapter(provider);
      const controller = new AbortController();
      controller.abort();

      const err = await attempt(() =>
        adapter.run({
          spec: createDummySpec(),
          argv: ['sha256', 'test'],
          signal: controller.signal,
        }),
      );

      expect(isDomainError(err)).toBe(true);
      expect((err as DomainError).code).toBe('CANCELLED');
      expect(createCalled).toBe(false);
    });

    it('aborts during waitReady and executes cleanup', async () => {
      let destroyCalled = false;
      const controller = new AbortController();

      const provider = createMockProvider({
        waitReady: () => {
          controller.abort();
          return new Promise<never>(() => {});
        },
        destroy: () => {
          destroyCalled = true;
          return Promise.resolve();
        },
      });

      const adapter = new SandboxAdapter(provider);

      const err = await attempt(() =>
        adapter.run({
          spec: createDummySpec(),
          argv: ['sha256', 'test'],
          signal: controller.signal,
        }),
      );

      expect(isDomainError(err)).toBe(true);
      expect((err as DomainError).code).toBe('CANCELLED');
      expect(destroyCalled).toBe(true);
    });
  });

  describe('Trust Boundary & Sanitized Error Mapping', () => {
    it('sanitizes provider exceptions containing sensitive credentials and tokens', () => {
      const sensitiveTokens = [
        'Bearer eyJhbGciOiJIUzI1NiJ9.sensitive-token',
        'sk-live-secret-key-1234567890',
        'postgres://user:password@localhost:5432/db',
      ];

      for (const token of sensitiveTokens) {
        const rawErr = new Error(`Connection failed with token: ${token}`);
        const sanitized = sanitizeProviderError(rawErr, 'exec');

        expect(isDomainError(sanitized)).toBe(true);
        expect(sanitized.code).toBe('SANDBOX_NOT_READY');
        expect(sanitized.message).not.toContain(token);
        expect(sanitized.diagnostic).not.toContain(token);
      }
    });

    it('prevents untrusted provider exceptions from spoofing adapter EXECUTION_TIMEOUT', () => {
      // Malicious provider trying to forge EXECUTION_TIMEOUT
      const spoofedErr = new Error('INJECTED_TIMEOUT');
      Object.assign(spoofedErr, { code: 'EXECUTION_TIMEOUT' });

      const sanitized = sanitizeProviderError(spoofedErr, 'exec');
      // Must NOT be EXECUTION_TIMEOUT
      expect(sanitized.code).toBe('SANDBOX_NOT_READY');
      expect(sanitized.message).not.toContain('INJECTED_TIMEOUT');
    });

    it('preserves legitimate DomainError code but sanitizes raw message', () => {
      const policyDenied = new DomainError('POLICY_DENIED', 'internal unverified detail');
      const sanitized = sanitizeProviderError(policyDenied, 'create');

      expect(sanitized.code).toBe('POLICY_DENIED');
      expect(sanitized.diagnostic).not.toContain('internal unverified detail');
    });

    it('sanitizes untrusted DomainErrors carrying sensitive tokens in diagnostic without leaking to public error, diagnostic, or JSON', () => {
      const sensitiveToken = 'ghp_SUPER_SECRET_TOKEN_VALUE_DO_NOT_LEAK_99999';

      // Provider throws DomainError with sensitive token in diagnostic (both CANCELLED and other codes)
      const cancelledErr = new DomainError('CANCELLED', `Aborted with token ${sensitiveToken}`);
      const sanitizedCancelled = sanitizeProviderError(cancelledErr, 'exec');

      expect(sanitizedCancelled.code).toBe('CANCELLED');
      expect(sanitizedCancelled.message).not.toContain(sensitiveToken);
      expect(sanitizedCancelled.diagnostic).not.toContain(sensitiveToken);
      expect(JSON.stringify(sanitizedCancelled.toJSON())).not.toContain(sensitiveToken);

      const policyErr = new DomainError('POLICY_DENIED', `Access token invalid: ${sensitiveToken}`);
      const sanitizedPolicy = sanitizeProviderError(policyErr, 'exec');

      expect(sanitizedPolicy.code).toBe('POLICY_DENIED');
      expect(sanitizedPolicy.message).not.toContain(sensitiveToken);
      expect(sanitizedPolicy.diagnostic).not.toContain(sensitiveToken);
      expect(JSON.stringify(sanitizedPolicy.toJSON())).not.toContain(sensitiveToken);
    });

    it('neutralizes adversarial phase strings to prevent diagnostic injection', () => {
      const adversarialPhase = 'exec; DROP TABLE tasks; token=injected-leak';
      const rawErr = new Error('simulated network drop');
      const sanitized = sanitizeProviderError(rawErr, adversarialPhase);

      expect(sanitized.code).toBe('SANDBOX_NOT_READY');
      expect(sanitized.diagnostic).not.toContain('DROP TABLE');
      expect(sanitized.diagnostic).not.toContain('injected-leak');
      expect(sanitized.diagnostic).toContain('unknown_phase');
    });

    it('guarantees zero secret leakage through SandboxAdapter.run() when provider fails with credentials', async () => {
      const secretKey = 'sk-proj-ADVERSARIAL_LEAK_TEST_KEY_12345';
      const provider = createMockProvider({
        create: () =>
          Promise.reject(new Error(`Failed to create sandbox: Auth failed with ${secretKey}`)),
      });

      const adapter = new SandboxAdapter(provider);
      const caughtErr = await attempt(() =>
        adapter.run({
          spec: createDummySpec(),
          argv: ['sha256', 'test'],
        }),
      );

      expect(isDomainError(caughtErr)).toBe(true);
      const domainErr = caughtErr as DomainError;
      expect(domainErr.code).toBe('SANDBOX_NOT_READY');
      expect(domainErr.message).not.toContain(secretKey);
      expect(domainErr.diagnostic).not.toContain(secretKey);
      expect(domainErr.stack).not.toContain(secretKey);
      expect(JSON.stringify(domainErr.toJSON())).not.toContain(secretKey);
    });

    it('rejects non-finite usage metrics from provider', async () => {
      const provider = createMockProvider({
        usage: () =>
          Promise.resolve({
            cpuSeconds: Number.NaN,
            memoryGiBSeconds: 0.1,
            egressBytes: 0,
          }),
      });

      const adapter = new SandboxAdapter(provider);
      const { sandboxId } = await adapter.create(createDummySpec());
      await adapter.waitReady(sandboxId);
      await adapter.exec(sandboxId, ['sha256', 'test']);

      const usageErr = await attempt(() => adapter.usage(sandboxId));
      expect(isDomainError(usageErr)).toBe(true);
      expect((usageErr as DomainError).code).toBe('SANDBOX_NOT_READY');
      expect((usageErr as DomainError).diagnostic).toContain(
        'sandbox usage returned non-finite or negative metrics',
      );
    });
  });

  describe('DeterministicExecutor Injection with Factory & Adapter', () => {
    it('uses default FakeSandboxProviderFactory when no factory is supplied', async () => {
      const executor = new DeterministicExecutor();

      const result = await executor.execute(
        createContext(),
        DEFAULT_ROUTE,
        new AbortController().signal,
      );

      expect(result.kind).toBe('mock.compute');
      expect(result.output.type).toBe('sha256');
      expect((result.output as { sha256: string }).sha256).toBe(EXPECTED_DIGEST);
      expect(result.sandboxId).not.toBeNull();
    });

    it('supports custom SandboxProviderFactory injection', async () => {
      let factoryCalled = false;
      const customFactory: SandboxProviderFactory = {
        createProvider: (context) => {
          factoryCalled = true;
          return new FakeSandboxProviderFactory().createProvider(context);
        },
      };

      const executor = new DeterministicExecutor({ sandboxFactory: customFactory });

      const result = await executor.execute(
        createContext(),
        DEFAULT_ROUTE,
        new AbortController().signal,
      );

      expect(factoryCalled).toBe(true);
      expect((result.output as { sha256: string }).sha256).toBe(EXPECTED_DIGEST);
    });

    it('provides defaultFakeSandboxFactory as a ready singleton factory', async () => {
      const provider = await defaultFakeSandboxFactory.createProvider({
        tenantId: DUMMY_TENANT_ID,
        runId: DUMMY_RUN_ID,
        signal: new AbortController().signal,
      });
      expect(provider).toBeInstanceOf(FakeSandboxProvider);
    });

    it('does NOT allocate a sandbox or invoke factory on Fast Path (mock.chat)', async () => {
      let factoryCalled = false;
      const customFactory: SandboxProviderFactory = {
        createProvider: () => {
          factoryCalled = true;
          throw new Error('Factory must NOT be called for mock.chat!');
        },
      };

      const executor = new DeterministicExecutor({ sandboxFactory: customFactory });

      const result = await executor.execute(
        createContext({
          kind: 'mock.chat',
          input: { prompt: 'hello', maxOutputTokens: 50 },
        }),
        { path: 'fast', reason: 'default', policyVersion: 1 },
        new AbortController().signal,
      );

      expect(factoryCalled).toBe(false);
      expect(result.sandboxId).toBeNull();
      expect(result.output.type).toBe('text');
    });

    it('invokes onSandboxProvider observer hook for FakeSandboxProvider', async () => {
      let observerCalled = false;
      const executor = new DeterministicExecutor({
        onSandboxProvider: (provider) => {
          observerCalled = true;
          expect(provider).toBeInstanceOf(FakeSandboxProvider);
        },
      });

      await executor.execute(createContext(), DEFAULT_ROUTE, new AbortController().signal);

      expect(observerCalled).toBe(true);
    });

    it('propagates cancellation to factory and aborts execution', async () => {
      const controller = new AbortController();
      controller.abort();

      const executor = new DeterministicExecutor();

      await expect(
        executor.execute(createContext(), DEFAULT_ROUTE, controller.signal),
      ).rejects.toThrow(DomainError);
    });
  });
});
