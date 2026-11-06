import { randomUUID } from 'node:crypto';
import type { SandboxSpec } from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import {
  E2B_DEFAULT_ALLOWED_PROGRAMS,
  E2B_NETWORK_POLICIES,
  E2BSandboxProvider,
  E2BSandboxProviderFactory,
  integrateUsage,
  quotePosixToken,
  renderCommand,
  resolveConfinedPath,
  validateArgv,
} from '@ember/sandbox-e2b';
import { describe, expect, it } from 'vitest';
import { FakeE2bClient } from './support/fake-e2b-client.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = 'base';
const TEMPLATE_DIGEST = 'e2b-template:base@2026-11-06';

function createProvider(client: FakeE2bClient, overrides: Record<string, unknown> = {}) {
  return new E2BSandboxProvider({
    tenantId: TENANT_ID,
    client,
    template: TEMPLATE,
    templateDigest: TEMPLATE_DIGEST,
    ...overrides,
  });
}

function createSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    tenantId: TENANT_ID,
    runId: RUN_ID,
    imageDigest: TEMPLATE_DIGEST,
    cpuMilli: 1_000,
    memoryMiB: 512,
    maxLifetimeSec: 60,
    networkPolicyId: 'deny-all',
    ...overrides,
  };
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  return null;
}

function errorCode(error: unknown): string | null {
  return isDomainError(error) ? error.code : null;
}

async function readyProvider(client: FakeE2bClient) {
  const provider = createProvider(client);
  const { sandboxId } = await provider.create(createSpec());
  await provider.waitReady(sandboxId, 5_000);
  return { provider, sandboxId };
}

describe('E2B argv validation and shell rendering', () => {
  it('quotes every token so shell metacharacters stay inert', () => {
    expect(renderCommand(['echo', 'a;rm -rf /'])).toBe(`'echo' 'a;rm -rf /'`);
    expect(renderCommand(['echo', '$(whoami)'])).toBe(`'echo' '$(whoami)'`);
    expect(renderCommand(['echo', '`id` | cat'])).toBe(`'echo' '` + '`id` | cat' + `'`);
  });

  it('escapes embedded single quotes without breaking the argument', () => {
    const escape = "'\\''";
    expect(renderCommand(['python3', '-c', "print('hello ember')"])).toBe(
      `'python3' '-c' 'print(${escape}hello ember${escape})'`,
    );
    expect(quotePosixToken("it's")).toBe(`'it${escape}s'`);
  });

  it('accepts the default allowlist and rejects everything else', () => {
    expect(
      validateArgv(['python3', '-c', 'print(1)'], {
        allowedPrograms: E2B_DEFAULT_ALLOWED_PROGRAMS,
      }),
    ).toHaveLength(3);

    expect(() =>
      validateArgv(['curl', 'https://example.com'], {
        allowedPrograms: E2B_DEFAULT_ALLOWED_PROGRAMS,
      }),
    ).toThrowError();

    expect(() =>
      validateArgv(['bash', '-c', 'id'], {
        allowedPrograms: E2B_DEFAULT_ALLOWED_PROGRAMS,
      }),
    ).toThrowError();
  });

  it('rejects empty argv, control characters and oversized tokens', () => {
    const policy = { allowedPrograms: E2B_DEFAULT_ALLOWED_PROGRAMS };

    expect(() => validateArgv([], policy)).toThrowError();
    expect(() => validateArgv(['echo', 'a\u0000b'], policy)).toThrowError();
    expect(() => validateArgv(['echo', 'a\rb'], policy)).toThrowError();
    expect(() => validateArgv(['echo', 'x'.repeat(5_000)], policy)).toThrowError();
  });

  it('rejects non-normalised program paths', () => {
    const policy = { allowedPrograms: ['python3'] };

    expect(() => validateArgv(['../../bin/python3'], policy)).toThrowError();
    expect(() => validateArgv(['/usr/../bin/python3'], policy)).toThrowError();
    expect(() => validateArgv(['/usr/bin/python3', '-c', 'print(1)'], policy)).not.toThrowError();
  });
});

describe('E2B path confinement', () => {
  it('composes paths under the workspace root', () => {
    expect(resolveConfinedPath('/tmp/ember', 'smoke/a.txt')).toBe('/tmp/ember/smoke/a.txt');
    expect(resolveConfinedPath('/tmp/ember/', 'a.txt')).toBe('/tmp/ember/a.txt');
  });

  it('denies traversal, absolute paths and odd separators', () => {
    expect(() => resolveConfinedPath('/tmp/ember', '../etc/passwd')).toThrowError();
    expect(() => resolveConfinedPath('/tmp/ember', 'a/../../etc/passwd')).toThrowError();
    expect(() => resolveConfinedPath('/tmp/ember', '/etc/passwd')).toThrowError();
    expect(() => resolveConfinedPath('/tmp/ember', 'a//b')).toThrowError();
    expect(() => resolveConfinedPath('/tmp/ember', 'a\\b')).toThrowError();
    expect(() => resolveConfinedPath('/tmp/ember', '')).toThrowError();
  });
});

describe('E2BSandboxProvider contract', () => {
  it('reports declared capabilities honestly', async () => {
    const capabilities = await createProvider(new FakeE2bClient()).capabilities();

    expect(capabilities.shell).toBe(true);
    expect(capabilities.networkPolicy).toBe(true);
    expect(capabilities.filesystemSnapshot).toBe(false);
    expect(capabilities.memoryResume).toBe(false);
    expect(capabilities.forkFromSnapshot).toBe(false);
    expect(capabilities.persistentVolume).toBe(false);
  });

  it('maps the spec onto the vendor create request', async () => {
    const client = new FakeE2bClient();
    const provider = createProvider(client);

    await provider.create(createSpec({ maxLifetimeSec: 45 }));

    const request = client.createRequests[0];

    expect(request?.template).toBe(TEMPLATE);
    expect(request?.timeoutMs).toBe(45_000);
    expect(request?.allowInternetAccess).toBe(false);
    expect(request?.metadata['ember_owner']).toBe('e2b-sandbox-poc');
    expect(request?.metadata['ember_tenant_id']).toBe(TENANT_ID);
    expect(request?.metadata['ember_run_id']).toBe(RUN_ID);
    // deny-all must include the cloud metadata endpoints, not just 0.0.0.0/0.
    expect(request?.denyOut).toContain('169.254.169.254/32');
    expect(request?.denyOut).toContain('0.0.0.0/0');
  });

  it('does not treat create as ready', async () => {
    const provider = createProvider(new FakeE2bClient());
    const { sandboxId } = await provider.create(createSpec());

    expect(provider.sandboxState(sandboxId)).toBe('created');

    const error = await captureError(() =>
      provider.exec(sandboxId, ['python3', '-c', 'print(1)'], 1_000),
    );

    expect(errorCode(error)).toBe('SANDBOX_NOT_READY');
  });

  it('denies specs that violate the adapter ceiling', async () => {
    const provider = createProvider(new FakeE2bClient());

    expect(
      errorCode(await captureError(() => provider.create(createSpec({ maxLifetimeSec: 300 })))),
    ).toBe('POLICY_DENIED');
    expect(
      errorCode(await captureError(() => provider.create(createSpec({ imageDigest: 'other' })))),
    ).toBe('POLICY_DENIED');
    expect(
      errorCode(await captureError(() => provider.create(createSpec({ networkPolicyId: 'nope' })))),
    ).toBe('POLICY_DENIED');
    expect(
      errorCode(await captureError(() => provider.create(createSpec({ restoreRef: 'snap-1' })))),
    ).toBe('POLICY_DENIED');
  });

  it('denies cross-tenant creates', async () => {
    const provider = createProvider(new FakeE2bClient());
    const error = await captureError(() => provider.create(createSpec({ tenantId: randomUUID() })));

    expect(errorCode(error)).toBe('POLICY_DENIED');
  });

  it('enforces the concurrency ceiling', async () => {
    const provider = createProvider(new FakeE2bClient());

    await provider.create(createSpec());
    await provider.create(createSpec({ runId: randomUUID() }));

    const error = await captureError(() => provider.create(createSpec({ runId: randomUUID() })));

    expect(errorCode(error)).toBe('POLICY_DENIED');
    expect(provider.liveSandboxCount()).toBe(2);
  });

  it('refuses to create after the caller signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createProvider(new FakeE2bClient(), { signal: controller.signal });

    expect(errorCode(await captureError(() => provider.create(createSpec())))).toBe('CANCELLED');
  });

  it('verifies allocated resources during readiness', async () => {
    const client = new FakeE2bClient();
    client.nextCpuCount = 1;
    client.nextMemoryMiB = 512;
    const { provider, sandboxId } = await readyProvider(client);

    expect(provider.measuredResources(sandboxId)).toEqual({
      cpuCount: 1,
      memoryMiB: 512,
      allowInternetAccess: false,
    });
  });

  it('fails closed when the vendor allocates more cpu than approved', async () => {
    const client = new FakeE2bClient();
    client.nextCpuCount = 4;
    const provider = createProvider(client);
    const { sandboxId } = await provider.create(createSpec());

    const error = await captureError(() => provider.waitReady(sandboxId, 2_000));

    expect(errorCode(error)).toBe('POLICY_DENIED');
    expect(provider.sandboxState(sandboxId)).toBe('created');
  });

  it('fails closed when egress was enabled despite deny-all', async () => {
    const client = new FakeE2bClient();
    client.reportedAllowInternetAccess = true;
    const provider = createProvider(client);
    const { sandboxId } = await provider.create(createSpec());

    const error = await captureError(() => provider.waitReady(sandboxId, 2_000));

    expect(errorCode(error)).toBe('POLICY_DENIED');
  });

  it('times out readiness rather than hanging', async () => {
    const client = new FakeE2bClient();
    client.forceState = 'unknown';
    const provider = createProvider(client);
    const { sandboxId } = await provider.create(createSpec());

    const error = await captureError(() => provider.waitReady(sandboxId, 150));

    expect(errorCode(error)).toBe('EXECUTION_TIMEOUT');
  });

  it('executes a quoted command and retains both streams', async () => {
    const client = new FakeE2bClient();
    client.commandHandler = () => ({
      exitCode: 0,
      stdout: 'hello ember\n',
      stderr: '',
      timedOut: false,
    });
    const { provider, sandboxId } = await readyProvider(client);

    const result = await provider.exec(sandboxId, ['python3', '-c', "print('hello ember')"], 5_000);
    const stdout = await provider.readOutput(sandboxId, result.stdoutRef);
    const stderr = await provider.readOutput(sandboxId, result.stderrRef);

    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('hello ember\n');
    expect(stderr).toBe('');
    expect(client.commands[0]?.command).toContain("'python3' '-c'");
    expect(client.commands[0]?.timeoutMs).toBe(5_000);
  });

  it('rejects a program outside the allowlist before any vendor call', async () => {
    const client = new FakeE2bClient();
    const { provider, sandboxId } = await readyProvider(client);

    const error = await captureError(() =>
      provider.exec(sandboxId, ['curl', 'https://169.254.169.254'], 5_000),
    );

    expect(errorCode(error)).toBe('INVALID_ARGUMENT');
    expect(client.commands).toHaveLength(0);
  });

  it('maps a vendor command timeout onto EXECUTION_TIMEOUT', async () => {
    const client = new FakeE2bClient();
    client.commandHandler = () => ({ exitCode: 124, stdout: '', stderr: '', timedOut: true });
    const { provider, sandboxId } = await readyProvider(client);

    const error = await captureError(() =>
      provider.exec(sandboxId, ['python3', '-c', 'import time; time.sleep(30)'], 1_000),
    );

    expect(errorCode(error)).toBe('EXECUTION_TIMEOUT');
    expect(provider.execStats(sandboxId).timedOut).toBe(1);
  });

  it('truncates oversized output and keeps the reference readable', async () => {
    const client = new FakeE2bClient();
    client.commandHandler = () => ({
      exitCode: 0,
      stdout: 'x'.repeat(70_000),
      stderr: '',
      timedOut: false,
    });
    const { provider, sandboxId } = await readyProvider(client);

    const result = await provider.exec(sandboxId, ['echo', 'x'], 5_000);
    const stdout = await provider.readOutput(sandboxId, result.stdoutRef);

    expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThanOrEqual(65_536);
  });

  it('returns NOT_FOUND for an unknown output reference', async () => {
    const { provider, sandboxId } = await readyProvider(new FakeE2bClient());

    expect(errorCode(await captureError(() => provider.readOutput(sandboxId, randomUUID())))).toBe(
      'NOT_FOUND',
    );
  });

  it('fails closed on contract-level file transfer', async () => {
    const { provider, sandboxId } = await readyProvider(new FakeE2bClient());

    expect(
      errorCode(await captureError(() => provider.putFile(sandboxId, 'a.txt', randomUUID()))),
    ).toBe('POLICY_DENIED');
    expect(errorCode(await captureError(() => provider.getFile(sandboxId, 'a.txt')))).toBe(
      'POLICY_DENIED',
    );
  });

  it('round-trips a confined text file', async () => {
    const client = new FakeE2bClient();
    const { provider, sandboxId } = await readyProvider(client);

    await provider.putTextFile(sandboxId, 'smoke/note.txt', 'ember');
    const readBack = await provider.getTextFile(sandboxId, 'smoke/note.txt');

    expect(readBack).toBe('ember');
    expect(client.writtenFiles[0]?.path).toBe('/tmp/ember/smoke/note.txt');
  });

  it('denies path traversal on the PoC file extension', async () => {
    const { provider, sandboxId } = await readyProvider(new FakeE2bClient());

    expect(
      errorCode(await captureError(() => provider.putTextFile(sandboxId, '../escape.txt', 'x'))),
    ).toBe('INVALID_ARGUMENT');
    expect(
      errorCode(await captureError(() => provider.putTextFile(sandboxId, '/etc/passwd', 'x'))),
    ).toBe('INVALID_ARGUMENT');
  });

  it('kills once and stays idempotent across stop and destroy', async () => {
    const client = new FakeE2bClient();
    const { provider, sandboxId } = await readyProvider(client);

    await provider.stop(sandboxId);
    await provider.destroy(sandboxId);
    await provider.destroy(sandboxId);

    expect(client.killedIds).toEqual([sandboxId]);
    expect(provider.sandboxState(sandboxId)).toBe('destroyed');
    expect(provider.liveSandboxCount()).toBe(0);
  });

  it('still destroys when stop already failed', async () => {
    const client = new FakeE2bClient();
    const { provider, sandboxId } = await readyProvider(client);
    client.killError = new Error('vendor exploded');

    expect(errorCode(await captureError(() => provider.stop(sandboxId)))).toBe('SANDBOX_NOT_READY');

    client.killError = null;
    await provider.destroy(sandboxId);

    expect(provider.sandboxState(sandboxId)).toBe('destroyed');
  });

  it('detects a leaked sandbox through the control plane', async () => {
    const client = new FakeE2bClient();
    const { provider, sandboxId } = await readyProvider(client);

    await provider.destroy(sandboxId);
    client.seedSandbox({ id: 'e2b-orphan', metadata: { ember_owner: 'e2b-sandbox-poc' } });

    const audit = await provider.verifyNoLiveSandboxes();

    expect(audit.liveSandboxIds).toEqual(['e2b-orphan']);
    expect(audit.liveSandboxIds).not.toContain(sandboxId);
  });

  it('sweeps orphaned sandboxes', async () => {
    const client = new FakeE2bClient();
    client.seedSandbox({ id: 'e2b-orphan-a', metadata: { ember_owner: 'e2b-sandbox-poc' } });
    client.seedSandbox({ id: 'e2b-orphan-b', metadata: { ember_owner: 'e2b-sandbox-poc' } });
    const provider = createProvider(client);

    const killed = await provider.sweepOrphanedSandboxes();

    expect([...killed].sort()).toEqual(['e2b-orphan-a', 'e2b-orphan-b']);
    expect(client.sandboxes.size).toBe(0);
  });

  it('derives usage from vendor metrics when available', async () => {
    const client = new FakeE2bClient();
    const { provider, sandboxId } = await readyProvider(client);

    client.metricsSamples = [
      { timestampMs: 0, cpuUsedPct: 50, memUsedBytes: 512 * 1024 ** 2 },
      { timestampMs: 10_000, cpuUsedPct: 50, memUsedBytes: 512 * 1024 ** 2 },
    ];

    const usage = await provider.usage(sandboxId);

    expect(provider.usageBasis(sandboxId)).toBe('VENDOR_METRICS');
    expect(usage.cpuSeconds).toBeCloseTo(5, 3);
    expect(usage.memoryGiBSeconds).toBeCloseTo(5, 3);
    expect(usage.egressBytes).toBe(0);
  });

  it('falls back to a nominal basis when the vendor returns no samples', async () => {
    const { provider, sandboxId } = await readyProvider(new FakeE2bClient());

    await provider.usage(sandboxId);

    expect(provider.usageBasis(sandboxId)).toBe('NOMINAL_TEMPLATE');
  });
});

describe('integrateUsage', () => {
  it('needs at least two samples to produce an interval', () => {
    expect(integrateUsage([])).toBeNull();
    expect(integrateUsage([{ timestampMs: 0, cpuUsedPct: 10, memUsedBytes: 1 }])).toBeNull();
  });

  it('integrates cpu percentage and memory over the sample interval', () => {
    const result = integrateUsage([
      { timestampMs: 1_000, cpuUsedPct: 100, memUsedBytes: 1024 ** 3 },
      { timestampMs: 3_000, cpuUsedPct: 100, memUsedBytes: 1024 ** 3 },
    ]);

    expect(result?.cpuSeconds).toBeCloseTo(2, 3);
    expect(result?.memoryGiBSeconds).toBeCloseTo(2, 3);
  });
});

describe('E2BSandboxProviderFactory', () => {
  it('creates a provider scoped to the requested tenant', async () => {
    const client = new FakeE2bClient();
    let observed: E2BSandboxProvider | undefined;
    const factory = new E2BSandboxProviderFactory({
      client,
      template: TEMPLATE,
      templateDigest: TEMPLATE_DIGEST,
      onProvider: (provider) => {
        observed = provider;
      },
    });

    const provider = await factory.createProvider({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      signal: new AbortController().signal,
    });

    expect(observed?.tenant).toBe(TENANT_ID);
    expect(provider).toBeInstanceOf(E2BSandboxProvider);
  });

  it('exposes deny-all as the default registered policy', () => {
    expect(E2B_NETWORK_POLICIES['deny-all']?.allowInternetAccess).toBe(false);
    expect(E2B_NETWORK_POLICIES['deny-all']?.denyOut).toContain('169.254.169.254/32');
  });
});
