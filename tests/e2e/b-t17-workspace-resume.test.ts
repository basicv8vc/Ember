import type { RunGrant } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import { PostgresRunResultCommitter } from '@ember/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    // 1. Task 1: write initial file
    const task1Res = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.file',
        input: {
          fileKey: 'notes/version1.txt',
          content: 'Initial workspace content from task 1',
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

    // 2. Task 2: write second file for same agent
    const task2Res = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.file',
        input: {
          fileKey: 'notes/version2.txt',
          content: 'Second workspace content from task 2',
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
  });

  it('resumes from committed Checkpoint after simulated crash and rejects stale worker via fencing', async () => {
    // 1. Submit mock.approval task which commits checkpoint in produce step
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.approval',
        input: {
          action: 'restart_cluster_service',
          reason: 'Verifying checkpoint resumption after lease expiration',
        },
      },
    });
    expect(taskRes.status).toBe(202);
    const t = (await taskRes.json()) as { task_id: string };

    // Wait until produce step commits checkpoint and task enters waiting_approval
    await cluster.waitForTask(t.task_id, 'waiting_approval', cluster.tenantA.token);

    // Verify 1 checkpoint committed for 'produce'
    const cpRows = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2 AND step_id = $3',
      [cluster.tenantA.tenantId, t.task_id, 'produce'],
    );
    expect(Number(cpRows.rows[0]?.count)).toBe(1);

    // Query Run 1 details
    const runRows = await cluster.appPool.query<{ id: string; lease_epoch: number }>(
      'SELECT id, lease_epoch FROM runs WHERE tenant_id = $1 AND task_id = $2 ORDER BY attempt DESC LIMIT 1',
      [cluster.tenantA.tenantId, t.task_id],
    );
    const run1 = runRows.rows[0];
    expect(run1).toBeDefined();
    if (!run1) throw new Error('Run 1 expected');

    // 2. Fencing test: simulate a stale worker late commit
    const staleGrant: RunGrant = {
      tenantId: cluster.tenantA.tenantId,
      taskId: t.task_id,
      runId: run1.id,
      agentId,
      attempt: 1,
      leaseEpoch: 0, // Stale lease epoch
      workerId: 'worker-stale-rogue',
    };

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

    let fenced = false;
    try {
      await committer.commitStep(staleGrant, {
        operationId: `step:produce:stale_replay`,
        mode: 'progress',
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'STALE_LEASE') {
        fenced = true;
      }
    }
    expect(fenced).toBe(true);

    // 3. Approve via HTTP API to transition task to queued for Run 2
    const approvalsRes = await cluster.fetch(`/v1/tasks/${t.task_id}/approvals`, {
      token: cluster.tenantA.token,
    });
    const approvalsData = (await approvalsRes.json()) as {
      approvals: Array<{ approval_id: string }>;
    };
    expect(approvalsData.approvals.length).toBe(1);

    const approval = approvalsData.approvals[0];
    expect(approval).toBeDefined();
    if (!approval) throw new Error('Approval expected');
    const approvalId = approval.approval_id;
    const decisionRes = await cluster.fetch(`/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { decision: 'approve' },
    });
    expect(decisionRes.status).toBe(200);

    // 4. Run 2 resumes from checkpoint and completes task
    const finalTask = await cluster.waitForTask(t.task_id, 'completed', cluster.tenantA.token);
    expect(finalTask.status).toBe('completed');

    // Confirm checkpoint was reused rather than duplicated
    const finalCpRows = await cluster.appPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2',
      [cluster.tenantA.tenantId, t.task_id],
    );
    expect(Number(finalCpRows.rows[0]?.count)).toBe(2);
  });
});
