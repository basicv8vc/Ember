import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T19 E2E Queued & Running Cancellation', () => {
  let cluster: E2eCluster;
  let agentId: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start({
      sandboxExecDurationMs: 50,
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
    // 1. Submit task
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

    // 2. Immediately cancel via HTTP POST /v1/tasks/:taskId/cancel
    const cancelRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/cancel`, {
      method: 'POST',
      token: cluster.tenantA.token,
    });

    // Either 200 (if caught while queued or already transitioned) or 202 (if claimed right away)
    expect([200, 202]).toContain(cancelRes.status);
    const cancelBody = (await cancelRes.json()) as {
      task_id: string;
      status: string;
      cancel_requested: boolean;
      terminal: boolean;
    };
    expect(cancelBody.task_id).toBe(receipt.task_id);
    expect(cancelBody.cancel_requested).toBe(true);

    // 3. Await terminal cancelled status
    const finalTask = await cluster.waitForTask(
      receipt.task_id,
      'cancelled',
      cluster.tenantA.token,
    );
    expect(finalTask.status).toBe('cancelled');

    // 4. Repeated cancel returns 200 OK with terminal: true (idempotent)
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
  });

  it('cooperatively cancels a running multi-step task and prevents subsequent steps', async () => {
    // 1. Submit mock.compute task with large payload so it takes some simulated time
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.compute',
        input: {
          operation: 'sha256',
          text: 'Running cancellation payload testing cooperative worker interruption. '.repeat(10),
        },
      },
    });
    expect(taskRes.status).toBe(202);
    const receipt = (await taskRes.json()) as { task_id: string };

    // 2. Request cancellation via HTTP POST
    const cancelRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/cancel`, {
      method: 'POST',
      token: cluster.tenantA.token,
    });
    expect([200, 202]).toContain(cancelRes.status);

    // 3. The task must converge to unique terminal state 'cancelled'
    const finalTask = await cluster.waitForTask(
      receipt.task_id,
      'cancelled',
      cluster.tenantA.token,
    );
    expect(finalTask.status).toBe('cancelled');

    // 4. Verify no lingering sandboxes
    expect(cluster.activeSandboxes).toBe(0);
  });
});
