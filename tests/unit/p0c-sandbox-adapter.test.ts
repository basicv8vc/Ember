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
      expect(adapter.liveSandboxCount?.()).toBe(0);
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

    it('stop 失败后仍尝试 destroy', async () => {
      let stopCalled = false;
      let destroyCalled = false;

      const provider = createMockProvider({
        stop: () => {
          stopCalled = true;
          return Promise.reject(new Error('stop failed'));
        },
        destroy: () => {
          destroyCalled = true;
          return Promise.resolve();
        },
      });

      const adapter = new SandboxAdapter(provider);
      const runErr = await attempt(() =>
        adapter.run({
          spec: createDummySpec(),
          argv: ['sha256', 'test'],
        }),
      );

      expect(stopCalled).toBe(true);
      expect(destroyCalled).toBe(true);
      expect(isDomainError(runErr)).toBe(true);
      expect((runErr as DomainError).code).toBe('SANDBOX_NOT_READY');
      expect((runErr as DomainError).diagnostic).toContain('stop');
    });

    it('destroy 失败、资源状态不可知时，完整 run 不返回无条件成功', async () => {
      let destroyAttempted = false;
      const provider = createMockProvider({
        destroy: () => {
          destroyAttempted = true;
          return Promise.reject(new Error('destroy failed unexpectedly'));
        },
      });

      const adapter = new SandboxAdapter(provider);
      const runErr = await attempt(() =>
        adapter.run({
          spec: createDummySpec(),
          argv: ['sha256', 'test'],
        }),
      );

      expect(destroyAttempted).toBe(true);
      expect(isDomainError(runErr)).toBe(true);
      expect((runErr as DomainError).code).toBe('SANDBOX_NOT_READY');
      expect((runErr as DomainError).diagnostic).toContain('destroy');
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

    it('destroy 抛错、超时后，生命周期状态不伪报 destroyed', async () => {
      // Case A: destroy throws error
      const failingProvider = createMockProvider({
        destroy: () => Promise.reject(new Error('underlying destroy failed')),
      });
      const adapterA = new SandboxAdapter(failingProvider);
      const { sandboxId: idA } = await adapterA.create(createDummySpec());
      await adapterA.waitReady(idA);
      await adapterA.stop(idA);
      expect(adapterA.sandboxState(idA)).toBe('stopped');

      const destroyErrA = await attempt(() => adapterA.destroy(idA));
      expect(isDomainError(destroyErrA)).toBe(true);
      // Must NOT be reported as 'destroyed'
      expect(adapterA.sandboxState(idA)).toBe('stopped');

      // Case B: destroy times out
      const hangingProvider = createMockProvider({
        destroy: () => new Promise<void>(() => {}), // never resolves
      });
      const adapterB = new SandboxAdapter(hangingProvider, { cleanupTimeoutMs: 50 });
      const { sandboxId: idB } = await adapterB.create(createDummySpec());
      await adapterB.waitReady(idB);
      expect(adapterB.sandboxState(idB)).toBe('ready');

      const destroyErrB = await attempt(() => adapterB.destroy(idB, 50));
      expect(isDomainError(destroyErrB)).toBe(true);
      expect((destroyErrB as DomainError).code).toBe('EXECUTION_TIMEOUT');
      // Must NOT be reported as 'destroyed'
      expect(adapterB.sandboxState(idB)).toBe('ready');
    });

    it('缺少原生 liveSandboxCount 的 Provider 不暴露 liveSandboxCount 方法', () => {
      const { liveSandboxCount: _ignored, ...providerWithoutCount } = createMockProvider();

      const adapter = new SandboxAdapter(providerWithoutCount);
      expect(adapter.liveSandboxCount).toBeUndefined();
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

    it('unconditionally maps untrusted DomainErrors to SANDBOX_NOT_READY and sanitizes raw message', () => {
      const policyDenied = new DomainError('POLICY_DENIED', 'internal unverified detail');
      const sanitized = sanitizeProviderError(policyDenied, 'create');

      expect(sanitized.code).toBe('SANDBOX_NOT_READY');
      expect(sanitized.diagnostic).not.toContain('internal unverified detail');
      expect(sanitized.diagnostic).toContain('create');
    });

    it('不可信 Provider 直接抛出真实 DomainError 时不能伪造权威错误码', async () => {
      const forgedCodes = [
        'CANCELLED',
        'STALE_LEASE',
        'EXECUTION_TIMEOUT',
        'POLICY_DENIED',
        'DEADLINE_EXCEEDED',
      ] as const;

      for (const forgedCode of forgedCodes) {
        const sensitiveToken = 'ghp_SUPER_SECRET_TOKEN_VALUE_DO_NOT_LEAK_99999';
        const maliciousProvider = createMockProvider({
          create: () =>
            Promise.reject(
              new DomainError(
                forgedCode,
                `Adversarial provider forging ${forgedCode} with token=${sensitiveToken}`,
              ),
            ),
        });

        const adapter = new SandboxAdapter(maliciousProvider);
        const caught = await attempt(() => adapter.create(createDummySpec()));

        expect(isDomainError(caught)).toBe(true);
        const domainErr = caught as DomainError;
        // MUST unconditionally be mapped to SANDBOX_NOT_READY
        expect(domainErr.code).toBe('SANDBOX_NOT_READY');
        expect(domainErr.code).not.toBe(forgedCode);
        expect(domainErr.diagnostic).not.toContain('Adversarial provider');
        expect(domainErr.diagnostic).not.toContain(sensitiveToken);
        expect(domainErr.message).not.toContain(sensitiveToken);
        expect(JSON.stringify(domainErr.toJSON())).not.toContain(sensitiveToken);
      }
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

    it('Factory Promise 永久挂起时能在有限时间内退出', async () => {
      const hangingFactory: SandboxProviderFactory = {
        createProvider: () => new Promise<never>(() => {}), // never resolves
      };

      const executor = new DeterministicExecutor({
        sandboxFactory: hangingFactory,
        sandboxReadyDeadlineMs: 100, // Bounded timeout for test
      });

      const start = Date.now();
      const caught = await attempt(() =>
        executor.execute(createContext(), DEFAULT_ROUTE, new AbortController().signal),
      );
      const elapsed = Date.now() - start;

      expect(isDomainError(caught)).toBe(true);
      expect((caught as DomainError).code).toBe('EXECUTION_TIMEOUT');
      expect(elapsed).toBeLessThan(1_000);
    });

    it('Factory 创建期间 Abort 正确生效', async () => {
      const controller = new AbortController();
      const delayedFactory: SandboxProviderFactory = {
        createProvider: async ({ signal }) => {
          return new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted in factory'));
            });
          });
        },
      };

      const executor = new DeterministicExecutor({
        sandboxFactory: delayedFactory,
        sandboxReadyDeadlineMs: 5_000,
      });

      const execPromise = executor.execute(createContext(), DEFAULT_ROUTE, controller.signal);
      setTimeout(() => controller.abort(), 30);

      const caught = await attempt(() => execPromise);
      expect(isDomainError(caught)).toBe(true);
      expect((caught as DomainError).code).toBe('CANCELLED');
    });

    it('Factory 原始异常包含 Token/URL/密码时，不泄露到错误或报告', async () => {
      const sensitiveToken = 'sk-super-secret-factory-token-abcdef123456';
      const sensitivePassword = 'pAssw0rd_factory_leak_test';
      const sensitiveUrl = `https://user:${sensitivePassword}@api.sandbox.internal/v1`;

      const leakingFactory: SandboxProviderFactory = {
        createProvider: () => {
          return Promise.reject(
            new Error(
              `Failed to initialize provider: url=${sensitiveUrl}, bearer=${sensitiveToken}`,
            ),
          );
        },
      };

      const executor = new DeterministicExecutor({
        sandboxFactory: leakingFactory,
      });

      const caught = await attempt(() =>
        executor.execute(createContext(), DEFAULT_ROUTE, new AbortController().signal),
      );

      expect(isDomainError(caught)).toBe(true);
      const domainErr = caught as DomainError;
      expect(domainErr.code).toBe('SANDBOX_NOT_READY');

      const serialized = JSON.stringify(domainErr.toJSON());
      expect(domainErr.message).not.toContain(sensitiveToken);
      expect(domainErr.message).not.toContain(sensitivePassword);
      expect(domainErr.message).not.toContain(sensitiveUrl);
      expect(domainErr.diagnostic).not.toContain(sensitiveToken);
      expect(domainErr.diagnostic).not.toContain(sensitivePassword);
      expect(domainErr.diagnostic).not.toContain(sensitiveUrl);
      expect(domainErr.stack).not.toContain(sensitiveToken);
      expect(serialized).not.toContain(sensitiveToken);
      expect(serialized).not.toContain(sensitivePassword);
    });
  });
});
