import { describe, expect, it } from 'vitest';

import {
  DAYTONA_SANDBOX_LIMITS,
  DaytonaSandboxProvider,
  sweepOrphanedSandboxes,
  type DaytonaSandboxClient,
} from '@ember/sandbox-daytona';
import type { SandboxSpec } from '@ember/contracts';
import { DomainError } from '@ember/domain';

import { FakeDaytonaClient } from './support/fake-daytona-client.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OWNER = 'poc:unit';

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    tenantId: TENANT_A,
    runId: '33333333-3333-4333-8333-333333333333',
    imageDigest: 'daytona-small',
    cpuMilli: 1_000,
    memoryMiB: 1_024,
    maxLifetimeSec: 120,
    networkPolicyId: 'deny-all',
    ...overrides,
  };
}

function provider(client: DaytonaSandboxClient, overrides: Record<string, unknown> = {}) {
  return new DaytonaSandboxProvider({
    tenantId: TENANT_A,
    client,
    snapshot: 'daytona-small',
    sandboxClass: 'container',
    owner: OWNER,
    ...overrides,
  });
}

async function readySandbox(client: FakeDaytonaClient = new FakeDaytonaClient()) {
  const instance = provider(client);
  const created = await instance.create(spec());
  await instance.waitReady(created.sandboxId, 5_000);

  return { client, provider: instance, sandboxId: created.sandboxId };
}

function expectCode(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

describe('DaytonaSandboxProvider capabilities', () => {
  it('reports only capabilities this adapter actually wires', async () => {
    const capabilities = await provider(new FakeDaytonaClient()).capabilities();

    expect(capabilities.shell).toBe(true);
    expect(capabilities.networkPolicy).toBe(true);
    // The port does not expose fork/pause/snapshot paths yet; claiming them would let the
    // execution router pick a strategy that fails at runtime.
    expect(capabilities.forkFromSnapshot).toBe(false);
    expect(capabilities.memoryResume).toBe(false);
    expect(capabilities.filesystemSnapshot).toBe(false);
    expect(capabilities.browser).toBe(false);
  });
});

describe('DaytonaSandboxProvider create', () => {
  it('maps the spec onto a deny-all, ephemeral, self-deleting sandbox', async () => {
    const client = new FakeDaytonaClient();

    await provider(client).create(spec());

    const request = client.createRequests[0];

    expect(request).toBeDefined();
    expect(request?.snapshot).toBe('daytona-small');
    expect(request?.ephemeral).toBe(true);
    expect(request?.networkBlockAll).toBe(true);
    // The two orphan controls that matter if the worker is killed:
    expect(request?.autoStopIntervalMinutes).toBe(DAYTONA_SANDBOX_LIMITS.idleStopMinutes);
    expect(request?.autoDeleteIntervalMinutes).toBe(0);
    expect(request?.ttlMinutes).toBe(2);

    // No secret of any kind is passed down. `envVars` is not even part of the request type.
    expect(JSON.stringify(request)).not.toContain('DATABASE_URL');
  });

  it('stamps tenant, owner and run labels on the sandbox', async () => {
    const client = new FakeDaytonaClient();

    await provider(client).create(spec());

    const labels = client.createRequests[0]?.labels ?? {};

    expect(labels['ember.tenant_id']).toBe(TENANT_A);
    expect(labels['ember.owner']).toBe(OWNER);
    expect(labels['ember.managed']).toBe('true');
    expect(labels['ember.provider']).toBe('daytona');
  });

  it('rejects a spec whose tenant differs from the provider tenant', async () => {
    const error = await provider(new FakeDaytonaClient())
      .create(spec({ tenantId: TENANT_B }))
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
  });

  it('rejects an image the provider is not bound to', async () => {
    const error = await provider(new FakeDaytonaClient())
      .create(spec({ imageDigest: 'daytona-vm-small' }))
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
  });

  it('refuses more than the approved vCPU ceiling', async () => {
    const error = await provider(new FakeDaytonaClient())
      .create(spec({ cpuMilli: 8_000 }))
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
  });

  it('clamps a lifetime above the ceiling instead of honouring it', async () => {
    const client = new FakeDaytonaClient();

    await provider(client).create(spec({ maxLifetimeSec: 3_600 }));

    // 3600s is clamped to the 120s adapter ceiling, which rounds to a 2-minute vendor TTL.
    expect(client.createRequests[0]?.ttlMinutes).toBe(
      Math.ceil(DAYTONA_SANDBOX_LIMITS.maxSandboxLifetimeSec / 60),
    );
  });

  it('rejects a lifetime below the minimum', async () => {
    const error = await provider(new FakeDaytonaClient())
      .create(spec({ maxLifetimeSec: 2 }))
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
  });

  it('enforces the concurrency ceiling before allocating', async () => {
    const client = new FakeDaytonaClient();
    const instance = provider(client);

    await instance.create(spec());
    await instance.create(spec());

    const error = await instance.create(spec()).catch((caught: unknown) => caught);

    expect(expectCode(error, 'BUDGET_EXCEEDED')).toBe(true);
    expect(client.createRequests).toHaveLength(2);
    expect(DAYTONA_SANDBOX_LIMITS.maxConcurrentSandboxes).toBe(2);
  });

  it('rejects an unknown network policy', async () => {
    const error = await provider(new FakeDaytonaClient())
      .create(spec({ networkPolicyId: 'allow-everything' }))
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
  });
});

describe('DaytonaSandboxProvider waitReady', () => {
  it('verifies class, resources and egress before reporting readiness', async () => {
    const { provider: instance, sandboxId } = await readySandbox();
    const capabilities = await instance.capabilities();

    expect(capabilities.shell).toBe(true);
    await expect(instance.exec(sandboxId, ['true'], 5_000)).resolves.toBeDefined();
  });

  it('destroys and rejects a sandbox whose class silently differs', async () => {
    const client = new FakeDaytonaClient({ sandboxClass: 'linux-vm', reportClass: 'container' });
    const instance = provider(client);
    const created = await instance.create(spec());

    const error = await instance
      .waitReady(created.sandboxId, 5_000)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
    expect(client.deleted).toContain(created.sandboxId);
  });

  it('destroys and rejects a sandbox allocated more vCPU than approved', async () => {
    const client = new FakeDaytonaClient({ allocatedCpu: 4 });
    const instance = provider(client);
    const created = await instance.create(spec());

    const error = await instance
      .waitReady(created.sandboxId, 5_000)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
    expect(client.deleted).toContain(created.sandboxId);
  });

  it('fails closed when the vendor does not confirm egress is blocked', async () => {
    const client = new FakeDaytonaClient({ networkBlockAllReported: null });
    const instance = provider(client);
    const created = await instance.create(spec());

    const error = await instance
      .waitReady(created.sandboxId, 5_000)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
    expect(client.deleted).toContain(created.sandboxId);
  });

  it('reports NOT_FOUND when the sandbox disappears before readiness', async () => {
    const client = new FakeDaytonaClient();
    const instance = provider(client);
    const created = await instance.create(spec());

    await client.delete(created.sandboxId);

    const error = await instance
      .waitReady(created.sandboxId, 2_000)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'NOT_FOUND')).toBe(true);
  });
});

describe('DaytonaSandboxProvider exec', () => {
  it('returns separate, readable stdout and stderr references', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    const result = await instance.exec(sandboxId, ['python3', '-c', "print('hello ember')"], 5_000);

    expect(result.exitCode).toBe(0);
    expect(result.stdoutRef).not.toBe(result.stderrRef);
    await expect(instance.readOutput(sandboxId, result.stdoutRef)).resolves.toBe('hello ember\n');
    await expect(instance.readOutput(sandboxId, result.stderrRef)).resolves.toBe('');
  });

  it('quotes every argv token so a shell cannot interpret it', async () => {
    const { client, provider: instance, sandboxId } = await readySandbox();

    await instance.exec(sandboxId, ['python3', '-c', "print('$(whoami)')"], 5_000);

    expect(client.execCommands.at(-1)).toBe(`'python3' '-c' 'print('\\''$(whoami)'\\'')'`);
  });

  it('rejects a program outside the allowlist before calling the vendor', async () => {
    const { client, provider: instance, sandboxId } = await readySandbox();

    const error = await instance
      .exec(sandboxId, ['curl', 'https://example.com'], 5_000)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(client.execCommands).toHaveLength(0);
  });

  it('rejects an empty argv', async () => {
    const { provider: instance, sandboxId } = await readySandbox();
    const error = await instance.exec(sandboxId, [], 5_000).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
  });

  it('maps a vendor timeout onto EXECUTION_TIMEOUT', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    const error = await instance
      .exec(sandboxId, ['sleep', '30'], 200)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'EXECUTION_TIMEOUT')).toBe(true);
  });

  it('maps a run abort onto CANCELLED', async () => {
    const controller = new AbortController();
    const client = new FakeDaytonaClient();
    const instance = provider(client, { signal: controller.signal });
    const created = await instance.create(spec());
    await instance.waitReady(created.sandboxId, 5_000);

    const pending = instance
      .exec(created.sandboxId, ['sleep', '20'], 20_000)
      .catch((caught: unknown) => caught);

    setTimeout(() => {
      controller.abort();
    }, 50);

    const error = await pending;

    expect(expectCode(error, 'CANCELLED')).toBe(true);
  });

  it('refuses to exec before the sandbox is ready', async () => {
    const client = new FakeDaytonaClient();
    const instance = provider(client);
    const created = await instance.create(spec());

    const error = await instance
      .exec(created.sandboxId, ['true'], 5_000)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'SANDBOX_NOT_READY')).toBe(true);
  });

  it('rejects an unknown output reference', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    const error = await instance
      .readOutput(sandboxId, '44444444-4444-4444-8444-444444444444')
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'NOT_FOUND')).toBe(true);
  });
});

describe('DaytonaSandboxProvider file transfer', () => {
  it('round-trips UTF-8 text through the sandbox filesystem', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    await instance.putTextFile(sandboxId, 'notes/probe.txt', 'hello 世界');
    await expect(instance.getTextFile(sandboxId, 'notes/probe.txt')).resolves.toBe('hello 世界');
    await expect(instance.textFileExists(sandboxId, 'notes/probe.txt')).resolves.toBe(true);
  });

  it('denies path traversal', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    await expect(instance.putTextFile(sandboxId, '../escape.txt', 'x')).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('denies absolute paths', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    await expect(instance.putTextFile(sandboxId, '/etc/ld.so.preload', 'x')).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('denies a transfer above the byte ceiling', async () => {
    const { provider: instance, sandboxId } = await readySandbox();
    const oversized = 'a'.repeat(DAYTONA_SANDBOX_LIMITS.maxFileBytes + 1);

    const error = await instance
      .putTextFile(sandboxId, 'big.txt', oversized)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'POLICY_DENIED')).toBe(true);
  });

  it('fails closed on the artifact-backed contract methods', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    await expect(
      instance.putFile(sandboxId, 'x', '55555555-5555-4555-8555-555555555555'),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(instance.getFile(sandboxId, 'x')).rejects.toBeInstanceOf(DomainError);
  });
});

describe('DaytonaSandboxProvider lifecycle', () => {
  it('is idempotent on destroy', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    await expect(instance.destroy(sandboxId)).resolves.toBeUndefined();
    await expect(instance.destroy(sandboxId)).resolves.toBeUndefined();
  });

  it('reports DEADLINE_EXCEEDED when deletion is not confirmed', async () => {
    const client = new FakeDaytonaClient({ deleteConfirmed: false });
    const instance = provider(client);
    const created = await instance.create(spec());
    await instance.waitReady(created.sandboxId, 5_000);

    const error = await instance.destroy(created.sandboxId).catch((caught: unknown) => caught);

    expect(expectCode(error, 'DEADLINE_EXCEEDED')).toBe(true);
  });

  it('marks a stopped sandbox as no longer ready for exec', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    await instance.stop(sandboxId);

    const error = await instance
      .exec(sandboxId, ['true'], 5_000)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'SANDBOX_NOT_READY')).toBe(true);
  });
});

describe('DaytonaSandboxProvider tenant isolation', () => {
  it("treats another tenant's sandbox id as unknown", async () => {
    const client = new FakeDaytonaClient();
    const providerA = provider(client);
    const providerB = provider(client, { tenantId: TENANT_B });
    const created = await providerA.create(spec());
    await providerA.waitReady(created.sandboxId, 5_000);

    const error = await providerB
      .exec(created.sandboxId, ['true'], 5_000)
      .catch((caught: unknown) => caught);

    // NOT_FOUND, not FORBIDDEN: the adapter must not confirm that the id exists.
    expect(expectCode(error, 'NOT_FOUND')).toBe(true);
  });

  it('does not share files between tenants', async () => {
    const client = new FakeDaytonaClient();
    const providerA = provider(client);
    const providerB = provider(client, { tenantId: TENANT_B });
    const a = await providerA.create(spec());
    const b = await providerB.create(spec({ tenantId: TENANT_B }));
    await providerA.waitReady(a.sandboxId, 5_000);
    await providerB.waitReady(b.sandboxId, 5_000);

    await providerA.putTextFile(a.sandboxId, 'secret.txt', 'tenant-a-only');

    await expect(providerB.textFileExists(b.sandboxId, 'secret.txt')).resolves.toBe(false);
    await expect(providerB.getTextFile(b.sandboxId, 'secret.txt')).rejects.toBeInstanceOf(Error);
  });

  it('audits cleanup against the vendor, not local bookkeeping', async () => {
    const { client, provider: instance, sandboxId } = await readySandbox();

    await instance.destroy(sandboxId);
    client.seedOrphan(OWNER, TENANT_A);

    const audit = await instance.verifyNoLiveSandboxes();

    expect(audit.liveSandboxIds).toHaveLength(1);
    expect(audit.liveSandboxIds).not.toContain(sandboxId);
  });

  it('discards local handles on abandon so the crash path is realistic', async () => {
    const { provider: instance, sandboxId } = await readySandbox();

    expect(instance.abandonAllRecords()).toEqual([sandboxId]);

    const error = await instance
      .exec(sandboxId, ['true'], 5_000)
      .catch((caught: unknown) => caught);

    expect(expectCode(error, 'NOT_FOUND')).toBe(true);
  });
});

describe('DaytonaSandboxProvider usage', () => {
  it('reports reservation-shaped usage, matching how the vendor bills', async () => {
    let now = 1_000_000;
    const client = new FakeDaytonaClient();
    const instance = provider(client, { clock: () => now });
    const created = await instance.create(spec());
    await instance.waitReady(created.sandboxId, 5_000);

    now += 60_000;

    const usage = await instance.usage(created.sandboxId);

    expect(usage.cpuSeconds).toBeCloseTo(60, 0);
    expect(usage.memoryGiBSeconds).toBeCloseTo(60, 0);
    expect(usage.egressBytes).toBe(0);
    expect(instance.usageBasis(created.sandboxId)).toBe('RESERVATION_WALL_CLOCK');
  });

  it('reports NOT_MEASURED before the sandbox is ready', async () => {
    const client = new FakeDaytonaClient();
    const instance = provider(client);
    const created = await instance.create(spec());

    expect(instance.usageBasis(created.sandboxId)).toBe('NOT_MEASURED');
  });
});

describe('sweepOrphanedSandboxes', () => {
  it('destroys sandboxes left behind by a dead worker', async () => {
    const client = new FakeDaytonaClient();
    const orphan = client.seedOrphan(OWNER, TENANT_A, 600_000);

    const result = await sweepOrphanedSandboxes({
      client,
      owner: OWNER,
      tenantId: TENANT_A,
      minAgeMs: 30_000,
    });

    expect(result.destroyed).toEqual([orphan]);
    expect(result.failed).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  it('keeps sandboxes inside the grace window', async () => {
    const client = new FakeDaytonaClient();
    const fresh = client.seedOrphan(OWNER, TENANT_A, 1_000);

    const result = await sweepOrphanedSandboxes({
      client,
      owner: OWNER,
      tenantId: TENANT_A,
      minAgeMs: 30_000,
    });

    expect(result.destroyed).toEqual([]);
    expect(result.kept).toEqual([fresh]);
  });

  it('keeps sandboxes the caller explicitly claims', async () => {
    const client = new FakeDaytonaClient();
    const claimed = client.seedOrphan(OWNER, TENANT_A, 600_000);

    const result = await sweepOrphanedSandboxes({
      client,
      owner: OWNER,
      tenantId: TENANT_A,
      keepSandboxIds: [claimed],
    });

    expect(result.destroyed).toEqual([]);
    expect(result.kept).toEqual([claimed]);
  });

  it('does not delete anything in a dry run', async () => {
    const client = new FakeDaytonaClient();
    client.seedOrphan(OWNER, TENANT_A, 600_000);

    const result = await sweepOrphanedSandboxes({
      client,
      owner: OWNER,
      tenantId: TENANT_A,
      dryRun: true,
    });

    expect(result.destroyed).toHaveLength(1);
    expect(client.deleted).toHaveLength(0);
  });

  it('ignores sandboxes owned by a different deployment', async () => {
    const client = new FakeDaytonaClient();
    client.seedOrphan('other-deployment', TENANT_A, 600_000);

    const result = await sweepOrphanedSandboxes({
      client,
      owner: OWNER,
      tenantId: TENANT_A,
    });

    expect(result.scanned).toBe(0);
  });
});
