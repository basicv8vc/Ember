import { describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@ember/contracts';
import { isDomainError, type Id } from '@ember/domain';
import {
  FAKE_SANDBOX_IMAGE_DIGEST,
  FAKE_SANDBOX_LIMITS,
  FakeSandboxProvider,
  computeSha256,
} from '@ember/execution';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';

const NOW = new Date('2026-10-28T00:00:00.000Z');

function clock(): { now: () => Date } {
  return { now: () => new Date(NOW.getTime()) };
}

function recorder(): { readonly calls: number[]; readonly sleep: (ms: number) => Promise<void> } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number): Promise<void> => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

function specFor(tenantId: Id, runId: Id = RUN): SandboxSpec {
  return {
    tenantId,
    runId,
    imageDigest: FAKE_SANDBOX_IMAGE_DIGEST,
    cpuMilli: 100,
    memoryMiB: 256,
    maxLifetimeSec: 60,
    networkPolicyId: 'none',
  };
}

function provider(
  options: { signal?: AbortSignal; execDurationMs?: number } = {},
): FakeSandboxProvider {
  const { sleep } = recorder();
  return new FakeSandboxProvider({
    tenantId: TENANT,
    clock: clock(),
    sleep,
    ...options,
  });
}

function expectCode(error: unknown, code: string): void {
  expect(isDomainError(error)).toBe(true);
  expect(isDomainError(error) ? error.code : 'NOT_A_DOMAIN_ERROR').toBe(code);
}

/** Await a call that may reject *or* throw synchronously (the provider does both). */
async function attempt(fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    return error;
  }
}

describe('FakeSandboxProvider lifecycle', () => {
  it('runs create → waitReady → exec → readOutput → usage → stop', async () => {
    const sandbox = provider();
    const { sandboxId } = await sandbox.create(specFor(TENANT));

    await sandbox.waitReady(sandboxId, 1_000);
    const exec = await sandbox.exec(sandboxId, ['sha256', 'hello ember'], 1_000);

    expect(exec.exitCode).toBe(0);
    await expect(sandbox.readOutput(sandboxId, exec.stdoutRef)).resolves.toBe(
      computeSha256('hello ember').value,
    );

    const usage = await sandbox.usage(sandboxId);

    expect(usage.cpuSeconds).toBeGreaterThan(0);
    // No socket exists, so simulated egress can never grow.
    expect(usage.egressBytes).toBe(0);

    await sandbox.stop(sandboxId);
    const afterStop = await sandbox
      .exec(sandboxId, ['sha256', 'x'], 1_000)
      .catch((thrown: unknown) => thrown);

    expectCode(afterStop, 'SANDBOX_NOT_READY');
  });

  it('drops simulated output on destroy and stays idempotent', async () => {
    const sandbox = provider();
    const { sandboxId } = await sandbox.create(specFor(TENANT));
    await sandbox.waitReady(sandboxId, 1_000);
    const exec = await sandbox.exec(sandboxId, ['sha256', 'secret'], 1_000);

    await sandbox.destroy(sandboxId);
    await expect(sandbox.destroy(sandboxId)).resolves.toBeUndefined();
    await expect(sandbox.stop(sandboxId)).resolves.toBeUndefined();

    const read = await attempt(() => sandbox.readOutput(sandboxId, exec.stdoutRef));

    expectCode(read, 'SANDBOX_NOT_READY');
  });

  it('refuses exec before the sandbox is ready', async () => {
    const sandbox = provider();
    const { sandboxId } = await sandbox.create(specFor(TENANT));

    const error = await sandbox
      .exec(sandboxId, ['sha256', 'x'], 1_000)
      .catch((thrown: unknown) => thrown);

    expectCode(error, 'SANDBOX_NOT_READY');
  });

  it('treats waitReady as idempotent and sleeps only once', async () => {
    const calls: number[] = [];
    const sandbox = new FakeSandboxProvider({
      tenantId: TENANT,
      clock: clock(),
      sleep: (ms: number) => {
        calls.push(ms);
        return Promise.resolve();
      },
      readyDelayMs: 25,
    });
    const { sandboxId } = await sandbox.create(specFor(TENANT));

    await sandbox.waitReady(sandboxId, 1_000);
    await sandbox.waitReady(sandboxId, 1_000);

    expect(calls).toEqual([25]);
  });

  it('fails with a bounded timeout when the simulated exec cannot finish in time', async () => {
    const sandbox = provider({ execDurationMs: 500 });
    const { sandboxId } = await sandbox.create(specFor(TENANT));
    await sandbox.waitReady(sandboxId, 1_000);

    const error = await sandbox
      .exec(sandboxId, ['sha256', 'x'], 100)
      .catch((thrown: unknown) => thrown);

    expectCode(error, 'EXECUTION_TIMEOUT');
  });

  it('produces a stable sandbox id for the same run and clock', async () => {
    const first = provider();
    const second = provider();

    const a = await first.create(specFor(TENANT));
    const b = await second.create(specFor(TENANT));

    expect(a.sandboxId).toBe(b.sandboxId);
    // A second sandbox for the same run in the same provider is refused, not duplicated.
    const duplicate = await first.create(specFor(TENANT)).catch((thrown: unknown) => thrown);

    expectCode(duplicate, 'POLICY_DENIED');
  });
});

describe('FakeSandboxProvider fail-closed behaviour', () => {
  it('reports every optional capability as unavailable', async () => {
    await expect(provider().capabilities()).resolves.toEqual({
      shell: false,
      browser: false,
      filesystemSnapshot: false,
      memoryResume: false,
      diskSurvivesStop: false,
      forkFromSnapshot: false,
      persistentVolume: false,
      networkPolicy: false,
    });
  });

  it('denies any command outside the simulation allowlist', async () => {
    const sandbox = provider();
    const { sandboxId } = await sandbox.create(specFor(TENANT));
    await sandbox.waitReady(sandboxId, 1_000);

    const shell = await sandbox
      .exec(sandboxId, ['sh', '-c', 'rm -rf /'], 1_000)
      .catch((thrown: unknown) => thrown);
    const python = await sandbox
      .exec(sandboxId, ['python', '-c', 'print(1)'], 1_000)
      .catch((thrown: unknown) => thrown);

    expectCode(shell, 'POLICY_DENIED');
    expectCode(python, 'POLICY_DENIED');
    // A denied command records no usage, so it cannot be mistaken for executed work.
    await expect(sandbox.usage(sandboxId)).resolves.toMatchObject({ cpuSeconds: 0 });
  });

  it('denies a sandbox that belongs to another tenant', async () => {
    const sandbox = provider();

    const error = await sandbox.create(specFor(OTHER_TENANT)).catch((thrown: unknown) => thrown);

    expectCode(error, 'POLICY_DENIED');
  });

  it('denies restoring from a snapshot', async () => {
    const sandbox = provider();

    const error = await sandbox
      .create({ ...specFor(TENANT), restoreRef: 'sha256:snapshot' })
      .catch((thrown: unknown) => thrown);

    expectCode(error, 'POLICY_DENIED');
  });

  it('denies file transfer because no ArtifactStore exists before P0B-06', async () => {
    const sandbox = provider();
    const { sandboxId } = await sandbox.create(specFor(TENANT));
    const artifact = '44444444-4444-4444-8444-444444444444';

    const put = await sandbox
      .putFile(sandboxId, 'notes/a.txt', artifact)
      .catch((thrown: unknown) => thrown);
    const get = await sandbox.getFile(sandboxId, 'notes/a.txt').catch((thrown: unknown) => thrown);

    expectCode(put, 'POLICY_DENIED');
    expectCode(get, 'POLICY_DENIED');
  });

  it('denies snapshot and resume', async () => {
    const sandbox = provider();
    const { sandboxId } = await sandbox.create(specFor(TENANT));

    const snapshot = await sandbox.snapshot(sandboxId).catch((thrown: unknown) => thrown);
    const resume = await sandbox.resume(sandboxId).catch((thrown: unknown) => thrown);

    expectCode(snapshot, 'POLICY_DENIED');
    expectCode(resume, 'POLICY_DENIED');
  });

  it('refuses new work once the caller has aborted', async () => {
    const controller = new AbortController();
    const sandbox = provider({ signal: controller.signal });

    controller.abort();

    const error = await sandbox.create(specFor(TENANT)).catch((thrown: unknown) => thrown);

    expectCode(error, 'CANCELLED');
  });

  it('hides a sandbox id that is not visible in this provider', async () => {
    const sandbox = provider();
    const foreignId = '55555555-5555-4555-8555-555555555555';

    const stop = await attempt(() => sandbox.stop(foreignId));
    const read = await attempt(() => sandbox.readOutput(foreignId, foreignId));

    expectCode(stop, 'NOT_FOUND');
    expectCode(read, 'NOT_FOUND');
  });

  it('rejects an over-long argv before executing anything', async () => {
    const sandbox = provider();
    const { sandboxId } = await sandbox.create(specFor(TENANT));
    await sandbox.waitReady(sandboxId, 1_000);
    const longArgv = ['sha256', 'x'.repeat(FAKE_SANDBOX_LIMITS.maxArgChars + 1)];

    const error = await sandbox.exec(sandboxId, longArgv, 1_000).catch((thrown: unknown) => thrown);

    expectCode(error, 'INVALID_ARGUMENT');
  });
});
