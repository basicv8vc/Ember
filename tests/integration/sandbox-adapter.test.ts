import { randomUUID } from 'node:crypto';
import type { RouteDecision, RunExecutionContext } from '@ember/contracts';
import {
  DeterministicExecutor,
  FakeSandboxProviderFactory,
  SandboxAdapter,
} from '@ember/execution';
import { describe, expect, it } from 'vitest';

describe('SandboxAdapter Integration (End-to-End Runtime Layer)', () => {
  it('executes concurrent deterministic compute tasks through factory and adapter without crosstalk or leaks', async () => {
    const factory = new FakeSandboxProviderFactory();
    const executor = new DeterministicExecutor({ sandboxFactory: factory });

    const route: RouteDecision = { path: 'standard', reason: 'default', policyVersion: 1 };
    const taskCount = 10;

    const executions = Array.from({ length: taskCount }, async (_, index) => {
      const tenantId = randomUUID();
      const runId = randomUUID();
      const taskId = randomUUID();
      const inputText = `payload-data-stream-${index}`;

      const ctx: RunExecutionContext = {
        tenantId,
        taskId,
        runId,
        agentId: randomUUID(),
        attempt: 1,
        leaseEpoch: 1,
        leaseExpiresAt: '2026-11-01T00:05:00.000Z',
        deadlineAt: null,
        policyVersion: 1,
        kind: 'mock.compute',
        input: { text: inputText, operation: 'sha256' },
        workerId: `worker-${index}`,
      };

      const result = await executor.execute(ctx, route, new AbortController().signal);

      expect(result.tenantId).toBe(tenantId);
      expect(result.runId).toBe(runId);
      expect(result.output.type).toBe('sha256');
      expect(result.sandboxId).not.toBeNull();

      return result;
    });

    const results = await Promise.all(executions);

    // All results must be distinct since inputs and tenants are distinct
    const digests = new Set(results.map((r) => (r.output as { sha256: string }).sha256));
    expect(digests.size).toBe(taskCount);

    const sandboxIds = new Set(results.map((r) => r.sandboxId));
    expect(sandboxIds.size).toBe(taskCount);
  });

  it('guarantees tenant isolation: sandboxes created for Tenant A cannot be accessed or manipulated by Tenant B', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    const factory = new FakeSandboxProviderFactory();
    const providerA = await factory.createProvider({
      tenantId: tenantA,
      runId: randomUUID(),
      signal: new AbortController().signal,
    });
    const adapterA = new SandboxAdapter(providerA);

    // Create sandbox in Tenant A's provider
    const { sandboxId } = await adapterA.create({
      tenantId: tenantA,
      runId: randomUUID(),
      imageDigest: 'sha256:ember-fake-sandbox-v1',
      cpuMilli: 250,
      memoryMiB: 256,
      maxLifetimeSec: 60,
      networkPolicyId: 'policy-default',
    });

    await adapterA.waitReady(sandboxId);

    // Tenant B's provider
    const providerB = await factory.createProvider({
      tenantId: tenantB,
      runId: randomUUID(),
      signal: new AbortController().signal,
    });
    const adapterB = new SandboxAdapter(providerB);

    // Attempt to exec on Tenant A's sandbox using Tenant B's adapter
    await expect(adapterB.exec(sandboxId, ['sha256', 'cross-tenant-probe'])).rejects.toThrow();

    // Clean up
    await adapterA.stop(sandboxId);
    await adapterA.destroy(sandboxId);
    expect(adapterA.liveSandboxCount()).toBe(0);
  });
});
