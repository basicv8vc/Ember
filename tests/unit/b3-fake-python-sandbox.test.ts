import { describe, expect, it, vi } from 'vitest';
import { isDomainError, type Id, type LeasedRun } from '@ember/domain';
import { FakeModelGateway } from '@ember/model-gateway';
import type { BlobStore } from '@ember/contracts';
import type { PostgresPythonAgentExecutionRepository } from '@ember/postgres/b3-worker';
import {
  FakePythonAgentSandbox,
  createFakePythonAgentSandboxFactory,
} from '../../apps/worker/src/b3/fake-python-sandbox.js';
import { createPythonAgentTaskHandler } from '../../apps/worker/src/b3/python-agent-handler.js';

const TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849901';
const TASK_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849902';
const RUN_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849903';

function makeLease(): LeasedRun {
  return {
    tenantId: TENANT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

describe('FakePythonAgentSandbox', () => {
  it('processes staged CSV data deterministically and writes a downloadable summary CSV artifact', async () => {
    const sandbox = new FakePythonAgentSandbox();
    const { sandboxId } = await sandbox.create({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      imageDigest: 'daytona-small',
      cpuMilli: 1000,
      memoryMiB: 512,
      maxLifetimeSec: 60,
      networkPolicyId: 'deny-all',
    });
    expect(sandbox.liveSandboxCount).toBe(1);

    await sandbox.waitReady(sandboxId, 5_000);
    await sandbox.putTextFile(
      sandboxId,
      'inputs/sales.csv',
      ['region,revenue,units', 'north,120.50,10', 'south,79.50,5', 'west,200,15'].join('\n'),
    );
    await sandbox.putTextFile(sandboxId, 'main.py', '# output: sales-report.csv\nprint("run")\n');

    const execResult = await sandbox.exec(sandboxId, ['python3', '-c', 'pass'], 5_000);
    expect(execResult.exitCode).toBe(0);

    const stdout = await sandbox.readOutput(sandboxId, execResult.stdoutRef, 'stdout', 2048);
    expect(stdout).toContain('Processed sales.csv (3 rows)');
    expect(stdout).toContain('revenue: count=3 sum=400 mean=133.33');
    expect(stdout).toContain('Wrote outputs/sales-report.csv');

    const outputs = await sandbox.listDirectory(sandboxId, 'outputs');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('sales-report.csv');

    const reportBytes = await sandbox.getBytesFile(sandboxId, 'outputs/sales-report.csv');
    const reportText = new TextDecoder().decode(reportBytes);
    expect(reportText).toContain('source_file,column,count,sum,min,max,mean');
    expect(reportText).toContain('sales.csv,revenue,3,400,79.50,200,133.33');
    expect(reportText).toContain('sales.csv,units,3,30,5,15,10');

    await sandbox.destroy(sandboxId);
    expect(sandbox.liveSandboxCount).toBe(0);
    await expect(sandbox.listDirectory(sandboxId, 'outputs')).rejects.toMatchObject({
      code: 'SANDBOX_NOT_READY',
    });
  });

  it('processes non-CSV JSON/text inputs and enforces safe path and lifecycle boundaries', async () => {
    const sandbox = new FakePythonAgentSandbox();
    const { sandboxId } = await sandbox.create({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      imageDigest: 'daytona-small',
      cpuMilli: 1000,
      memoryMiB: 512,
      maxLifetimeSec: 60,
      networkPolicyId: 'deny-all',
    });

    await expect(sandbox.exec(sandboxId, ['python3'], 1_000)).rejects.toMatchObject({
      code: 'SANDBOX_NOT_READY',
    });

    await sandbox.waitReady(sandboxId, 5_000);
    await expect(sandbox.putTextFile(sandboxId, '../escape.txt', 'nope')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(sandbox.putTextFile(sandboxId, '/etc/passwd', 'nope')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    await sandbox.putTextFile(sandboxId, 'inputs/metrics.json', JSON.stringify([{ a: 1 }, { a: 2 }]));
    await sandbox.putTextFile(sandboxId, 'main.py', 'print("json")\n');
    const execResult = await sandbox.exec(sandboxId, ['python3'], 5_000);
    expect(execResult.exitCode).toBe(0);

    const truncated = await sandbox.readOutput(sandboxId, execResult.stdoutRef, 'stdout', 10);
    expect(truncated.length).toBeLessThanOrEqual(10);

    const summaryBytes = await sandbox.getBytesFile(sandboxId, 'outputs/analysis-summary.json');
    const parsed = JSON.parse(new TextDecoder().decode(summaryBytes)) as {
      simulated: boolean;
      processed_files: number;
      files: { filename: string; json_kind?: string; json_items?: number }[];
    };
    expect(parsed.simulated).toBe(true);
    expect(parsed.processed_files).toBe(1);
    expect(parsed.files[0]).toMatchObject({
      filename: 'metrics.json',
      json_kind: 'array',
      json_items: 2,
    });

    await sandbox.destroy(sandboxId);
  });
});

describe('createPythonAgentTaskHandler', () => {
  it('throws STALE_LEASE when executePythonAgentRun reports lease_lost', async () => {
    const repository = {
      loadAgentContext: vi.fn().mockResolvedValue({ kind: 'lease_lost' }),
    } as unknown as PostgresPythonAgentExecutionRepository;

    const handler = createPythonAgentTaskHandler({
      mode: 'fake',
      leaseQueue: { heartbeat: vi.fn().mockResolvedValue(true) },
      repository,
      blobStore: {} as BlobStore,
      gateway: new FakeModelGateway(),
      createSandbox: createFakePythonAgentSandboxFactory(),
      sandboxOwner: 'worker-test',
      policy: { baseDelayMs: 1_000, capDelayMs: 10_000 },
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 250_000,
        tenantDailyMicroUsd: 1_000_000,
        globalDailyMicroUsd: 5_000_000,
      },
      rate: null,
      leaseDurationMs: 30_000,
      attemptTimeoutMs: 10_000,
      logger: { info: () => {}, warn: () => {} },
    });

    const controller = new AbortController();
    let caught: unknown;
    try {
      await handler.handle(makeLease(), controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(isDomainError(caught) && caught.code === 'STALE_LEASE').toBe(true);
  });

  it('returns committed receipt when executePythonAgentRun commits a terminal outcome', async () => {
    const publishedId: Id = '018f5f2e-0e91-7a30-ae62-bcb97d849999';
    const repository = {
      loadAgentContext: vi.fn().mockResolvedValue({ kind: 'cancelled' }),
      commitFailure: vi.fn().mockResolvedValue({
        outcome: 'committed',
        taskStatus: 'cancelled',
      }),
    } as unknown as PostgresPythonAgentExecutionRepository;

    const handler = createPythonAgentTaskHandler({
      mode: 'fake',
      leaseQueue: { heartbeat: vi.fn().mockResolvedValue(true) },
      repository,
      blobStore: {} as BlobStore,
      gateway: new FakeModelGateway(),
      createSandbox: createFakePythonAgentSandboxFactory(),
      sandboxOwner: 'worker-test',
      policy: { baseDelayMs: 1_000, capDelayMs: 10_000 },
      ceilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 250_000,
        tenantDailyMicroUsd: 1_000_000,
        globalDailyMicroUsd: 5_000_000,
      },
      rate: null,
      leaseDurationMs: 30_000,
      attemptTimeoutMs: 10_000,
      logger: { info: () => {}, warn: () => {} },
    });

    const completion = await handler.handle(makeLease(), new AbortController().signal);
    expect(completion.type).toBe('committed');
    if (completion.type === 'committed') {
      expect(completion.receipt.taskId).toBe(TASK_ID);
      expect(completion.receipt.artifactIds).toEqual([]);
      expect(publishedId).toBeTruthy();
    }
  });
});
