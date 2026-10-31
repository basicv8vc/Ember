import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T20 E2E Mock Approval Decision Gates', () => {
  let cluster: E2eCluster;
  let agentId: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start();

    const res = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'E2E-Approval-Agent' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    agentId = body.agent_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('pauses in waiting_approval, resumes on approval, and completes successfully', async () => {
    // 1. Submit approval task
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.approval',
        input: {
          action: 'promote_to_production',
          reason: 'Scheduled deployment ticket #1234',
        },
      },
    });
    expect(taskRes.status).toBe(202);
    const receipt = (await taskRes.json()) as { task_id: string };

    // 2. Await paused state: waiting_approval
    const waitingTask = await cluster.waitForTask(
      receipt.task_id,
      'waiting_approval',
      cluster.tenantA.token,
    );
    expect(waitingTask.status).toBe('waiting_approval');

    // 3. List approvals via HTTP GET /v1/tasks/:taskId/approvals
    const approvalsRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/approvals`, {
      token: cluster.tenantA.token,
    });
    expect(approvalsRes.status).toBe(200);
    const approvalsData = (await approvalsRes.json()) as {
      approvals: Array<{ approval_id: string; status: string; action_digest: string }>;
    };
    expect(approvalsData.approvals.length).toBe(1);
    const approval = approvalsData.approvals[0];
    expect(approval).toBeDefined();
    if (!approval) throw new Error('Approval expected');
    expect(approval.status).toBe('pending');
    expect(typeof approval.action_digest).toBe('string');

    // 4. Submit approval decision: approve
    const decisionRes = await cluster.fetch(`/v1/approvals/${approval.approval_id}/decision`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { decision: 'approve' },
    });
    expect(decisionRes.status).toBe(200);
    const decisionReceipt = (await decisionRes.json()) as {
      status: string;
      task_status: string;
    };
    expect(decisionReceipt.status).toBe('approved');
    expect(decisionReceipt.task_status).toBe('queued');

    // 5. Worker claims and completes resumed task
    const completedTask = await cluster.waitForTask(
      receipt.task_id,
      'completed',
      cluster.tenantA.token,
    );
    expect(completedTask.status).toBe('completed');
  });

  it('pauses in waiting_approval and terminates as failed when decision is deny', async () => {
    // 1. Submit approval task
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.approval',
        input: {
          action: 'drop_production_tables',
          reason: 'Dangerous operation to be rejected',
        },
      },
    });
    expect(taskRes.status).toBe(202);
    const receipt = (await taskRes.json()) as { task_id: string };

    // 2. Await paused state
    await cluster.waitForTask(receipt.task_id, 'waiting_approval', cluster.tenantA.token);

    // 3. Get approval record
    const approvalsRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/approvals`, {
      token: cluster.tenantA.token,
    });
    const approvalsData = (await approvalsRes.json()) as {
      approvals: Array<{ approval_id: string }>;
    };
    const approvalRecord = approvalsData.approvals[0];
    expect(approvalRecord).toBeDefined();
    if (!approvalRecord) throw new Error('Approval expected');
    const approvalId = approvalRecord.approval_id;

    // 4. Submit approval decision: deny
    const decisionRes = await cluster.fetch(`/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { decision: 'deny' },
    });
    expect(decisionRes.status).toBe(200);
    const decisionReceipt = (await decisionRes.json()) as {
      status: string;
      task_status: string;
    };
    expect(decisionReceipt.status).toBe('denied');
    expect(decisionReceipt.task_status).toBe('failed');

    // 5. Verify task terminal state is failed
    const failedTask = await cluster.waitForTask(receipt.task_id, 'failed', cluster.tenantA.token);
    expect(failedTask.status).toBe('failed');
  });
});
