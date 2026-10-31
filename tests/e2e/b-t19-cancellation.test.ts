import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T19 E2E Queued & Running Cancellation', () => {
  let cluster: E2eCluster;
  let agentId: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start({
      sandboxExecDurationMs: 250,
    });

    const res = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'E2E-Cancel-Agent' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    agentId = body.agent_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('cancels a queued task immediately with HTTP 200 and terminal: true', async () => {
    // 1. Temporarily pause worker to ensure task is caught in queued state
    await cluster.stopWorker();

    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.chat',
        input: { prompt: 'Queued task to be cancelled immediately' },
      },
    });
    expect(taskRes.status).toBe(202);
    const receipt = (await taskRes.json()) as { task_id: string };

    // 2. Immediately cancel via HTTP POST /v1/tasks/:taskId/cancel while queued
    const cancelRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/cancel`, {
      method: 'POST',
      token: cluster.tenantA.token,
    });

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      task_id: string;
      status: string;
      cancel_requested: boolean;
      terminal: boolean;
    };
    expect(cancelBody.task_id).toBe(receipt.task_id);
    expect(cancelBody.status).toBe('cancelled');
    expect(cancelBody.cancel_requested).toBe(true);
    expect(cancelBody.terminal).toBe(true);

    // 3. Repeated cancel returns 200 OK with terminal: true (idempotent)
    const idempotentCancelRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/cancel`, {
      method: 'POST',
      token: cluster.tenantA.token,
    });
    expect(idempotentCancelRes.status).toBe(200);
    const idempotentBody = (await idempotentCancelRes.json()) as {
      terminal: boolean;
      status: string;
    };
    expect(idempotentBody.terminal).toBe(true);
    expect(idempotentBody.status).toBe('cancelled');

    // Restart worker for subsequent running test
    cluster.startWorker();
  });

  it('cooperatively cancels a running multi-step task and prevents subsequent steps', async () => {
    // 1. Submit mock.compute task with large payload (> 512 chars) so it routes to standard path
    // and executes inside FakeSandbox with 250ms duration
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.compute',
        input: {
          operation: 'sha256',
          text: 'Running cancellation payload testing cooperative worker interruption. '.repeat(20),
        },
      },
    });
    expect(taskRes.status).toBe(202);
    const receipt = (await taskRes.json()) as { task_id: string };

    // 2. Explicitly wait and confirm Task has entered 'running' status
    const runningTask = await cluster.waitForTask(
      receipt.task_id,
      'running',
      cluster.tenantA.token,
      5_000,
    );
    expect(runningTask['status']).toBe('running');

    // 3. Request cancellation while task is confirmed running -> HTTP 202 Accepted
    const cancelRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/cancel`, {
      method: 'POST',
      token: cluster.tenantA.token,
    });
    expect(cancelRes.status).toBe(202);

    const cancelBody = (await cancelRes.json()) as {
      task_id: string;
      status: string;
      cancel_requested: boolean;
      terminal: boolean;
    };
    expect(cancelBody.task_id).toBe(receipt.task_id);
    expect(cancelBody.status).toBe('running');
    expect(cancelBody.cancel_requested).toBe(true);
    expect(cancelBody.terminal).toBe(false);

    // 4. The task must converge to unique terminal state 'cancelled'
    const finalTask = await cluster.waitForTask(
      receipt.task_id,
      'cancelled',
      cluster.tenantA.token,
      5_000,
    );
    expect(finalTask['status']).toBe('cancelled');

    // 5. Verify no subsequent step execution occurred (zero 'publish' step checkpoints)
    const publishCp = await cluster.appPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM step_checkpoints WHERE tenant_id = $1 AND task_id = $2 AND step_id = 'publish'",
      [cluster.tenantA.tenantId, receipt.task_id],
    );
    expect(Number(publishCp.rows[0]?.count ?? '0')).toBe(0);

    // 6. Verify workspace was not mutated by publish
    const wsRows = await cluster.appPool.query<{ version: number }>(
      'SELECT version FROM workspaces WHERE tenant_id = $1 AND agent_id = $2',
      [cluster.tenantA.tenantId, agentId],
    );
    expect(wsRows.rows[0]?.version ?? 0).toBe(0);

    // 7. Verify all sandboxes were cleaned up
    expect(cluster.activeSandboxes).toBe(0);
  });
});
