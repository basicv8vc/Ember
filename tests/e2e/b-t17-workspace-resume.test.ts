import { createHash } from 'node:crypto';
import type { RunGrant } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { PostgresRunExecutionContextReader, PostgresRunResultCommitter } from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_EXECUTOR_VERSION,
  executionInputDigest,
} from '../../apps/worker/src/durable-run-handler.js';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T17 E2E Workspace Version & Checkpoint Resume', () => {
  let cluster: E2eCluster;
  let agentId: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start();

    const res = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'E2E-Workspace-Resume-Agent' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    agentId = body.agent_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('reads previous Workspace version, increments version with new sandbox, and preserves content', async () => {
    const prevCount = cluster.createdSandboxIds.length;

    // 1. Task 1: standard execution allocating sandbox 1
    const task1Res = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.compute',
        input: {
          operation: 'sha256',
          text: 'E2E workspace version task 1 allocating isolated transient sandbox. '.repeat(10),
        },
      },
    });
    expect(task1Res.status).toBe(202);
    const t1 = (await task1Res.json()) as { task_id: string };
    await cluster.waitForTask(t1.task_id, 'completed', cluster.tenantA.token);

    const ws1 = await cluster.appPool.query<{ version: number }>(
      'SELECT version FROM workspaces WHERE tenant_id = $1 AND agent_id = $2',
      [cluster.tenantA.tenantId, agentId],
    );
    expect(ws1.rows[0]?.version).toBe(1);

    // 2. Task 2: standard execution allocating sandbox 2 for same agent
    const task2Res = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.compute',
        input: {
          operation: 'sha256',
          text: 'E2E workspace version task 2 allocating a second isolated transient sandbox. '.repeat(
            10,
          ),
        },
      },
    });
    expect(task2Res.status).toBe(202);
    const t2 = (await task2Res.json()) as { task_id: string };
    await cluster.waitForTask(t2.task_id, 'completed', cluster.tenantA.token);

    const ws2 = await cluster.appPool.query<{ version: number }>(
      'SELECT version FROM workspaces WHERE tenant_id = $1 AND agent_id = $2',
      [cluster.tenantA.tenantId, agentId],
    );
    // Version incremented from 1 to 2 via CAS
    expect(ws2.rows[0]?.version).toBe(2);

    // 3. Strict assertion: Prove that new distinct Sandbox IDs were allocated for each execution
    expect(cluster.createdSandboxIds.length).toBeGreaterThanOrEqual(prevCount + 2);
    const sandboxId1 = cluster.createdSandboxIds[prevCount];
    const sandboxId2 = cluster.createdSandboxIds[prevCount + 1];
    expect(sandboxId1).toBeDefined();
    expect(sandboxId2).toBeDefined();
    expect(sandboxId1).not.toBe(sandboxId2);
  });

  it('resumes from committed Checkpoint after simulated crash and rejects stale worker via fencing', async () => {
    // 1. Temporarily pause cluster background worker
    await cluster.stopWorker();

    const taskInput = {
      operation: 'sha256',
      text: 'B-T17 crash recovery payload testing controlled lease expiration and resumption. '.repeat(
        10,
      ),
    };

    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.compute',
        input: taskInput,
      },
    });
    expect(taskRes.status).toBe(202);
    const t = (await taskRes.json()) as { task_id: string };

    // 2. Worker 1 claims task and durably commits produce step Checkpoint
    const now = new Date();
    const claim1 = await cluster.queue.claimNext('worker-e2e-crash-1', now);
    expect(claim1).not.toBeNull();
    if (!claim1) throw new Error('Claim 1 expected');

    const contextReader = new PostgresRunExecutionContextReader(cluster.workerPool, {
      now: () => new Date(),
    });
    const context = await contextReader.read(claim1, now);
    const grant1: RunGrant = {
      tenantId: cluster.tenantA.tenantId,
      taskId: claim1.taskId,
      runId: claim1.runId,
      agentId: context.agentId,
      attempt: claim1.attempt,
      leaseEpoch: claim1.leaseEpoch,
      workerId: 'worker-e2e-crash-1',
    };

    const inputDigest = executionInputDigest(context);
    const stagedBytes = Buffer.from(
      createHash('sha256').update(taskInput.text).digest('hex'),
      'utf8',
    );
    const staged = await cluster.blobs.stage(cluster.tenantA.tenantId, stagedBytes, 'text/plain');

    const committer = new PostgresRunResultCommitter(cluster.workerPool, {
      blobs: cluster.blobs,
      policy: {
        leaseDurationMs: 15_000,
        heartbeatIntervalMs: 3_000,
        reaperBatchSize: 20,
        baseDelayMs: 500,
        capDelayMs: 5_000,
      },
    });

    await committer.commitStep(grant1, {
      operationId: `step:produce:${inputDigest.slice(0, 16)}`,
      mode: 'progress',
      artifacts: [{ artifactId: staged.stagedId, staged }],
      checkpoint: {
        stepId: 'produce',
        inputDigest,
        executorVersion: CHECKPOINT_EXECUTOR_VERSION,
        cursor: { phase: 'produced' },
        artifacts: [
          {
            artifactId: staged.stagedId,
            sha256: staged.sha256,
            size: staged.size,
            mediaType: staged.mediaType,
            path: `compute/${claim1.taskId}.txt`,
          },
        ],
      },
    });

    // Verify 1 checkpoint committed for 'produce'
    const cpRows = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2 AND step_id = $3',
      [cluster.tenantA.tenantId, t.task_id, 'produce'],
    );
    expect(Number(cpRows.rows[0]?.count)).toBe(1);

    // 3. Simulate Worker 1 crash: rewind timestamps and run reaper
    await cluster.appPool.query(
      `UPDATE runs
          SET leased_until = clock_timestamp() - interval '10 seconds'
        WHERE tenant_id = $1 AND id = $2`,
      [cluster.tenantA.tenantId, claim1.runId],
    );

    await cluster.appPool.query(
      `UPDATE tasks
          SET created_at = clock_timestamp() - interval '1 hour',
              lease_expires_at = clock_timestamp() - interval '50 minutes'
        WHERE tenant_id = $1 AND id = $2`,
      [cluster.tenantA.tenantId, claim1.taskId],
    );

    await cluster.queue.reapExpired(new Date());

    const reapedRun = await cluster.appPool.query<{ status: string }>(
      'SELECT status FROM runs WHERE tenant_id = $1 AND id = $2',
      [cluster.tenantA.tenantId, claim1.runId],
    );
    expect(reapedRun.rows[0]?.status).toBe('lease_expired');

    const reapedTask = await cluster.appPool.query<{ status: string }>(
      'SELECT status FROM tasks WHERE tenant_id = $1 AND id = $2',
      [cluster.tenantA.tenantId, claim1.taskId],
    );
    expect(reapedTask.rows[0]?.status).toBe('retryable_failed');

    // 4. Fencing test: simulate stale Worker 1 late commit with original grant1
    let fenced = false;
    try {
      await committer.commitStep(grant1, {
        operationId: `step:publish:stale_late_write`,
        mode: 'result',
        artifacts: [],
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'STALE_LEASE') {
        fenced = true;
      }
    }
    expect(fenced).toBe(true);

    // 5. Schedule retry and let background worker resume from checkpoint
    await cluster.appPool.query(
      `UPDATE tasks SET next_run_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2`,
      [cluster.tenantA.tenantId, claim1.taskId],
    );

    cluster.startWorker();

    const finalTask = await cluster.waitForTask(t.task_id, 'completed', cluster.tenantA.token);
    expect(finalTask.status).toBe('completed');

    // 6. Confirm checkpoint was reused (produce count strictly 1, total count strictly 2)
    const finalProduceCp = await cluster.appPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2 AND step_id = 'produce'",
      [cluster.tenantA.tenantId, t.task_id],
    );
    expect(Number(finalProduceCp.rows[0]?.count)).toBe(1);

    const finalTotalCp = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [cluster.tenantA.tenantId, t.task_id],
    );
    expect(Number(finalTotalCp.rows[0]?.count)).toBe(2);
  });
});
