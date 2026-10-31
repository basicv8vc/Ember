import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T15 E2E Fast Task Closed Loop', () => {
  let cluster: E2eCluster;
  let agentId: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start();

    // Provision an agent via HTTP POST /v1/agents
    const res = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'E2E-Fast-Agent' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    agentId = body.agent_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('executes fast text task, provides Durable Ack, streams events, and allocates 0 sandboxes', async () => {
    const prevSandboxes = cluster.totalSandboxesCreated;

    // 1. Submit Fast Task via real HTTP API
    const createRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.chat',
        input: {
          prompt: 'Fast path test prompt: 1 + 1 = 2',
          maxOutputTokens: 64,
        },
      },
    });

    expect(createRes.status).toBe(202);
    const receipt = (await createRes.json()) as { task_id: string; status: string };
    expect(receipt.status).toBe('queued');
    expect(typeof receipt.task_id).toBe('string');

    // 2. Verify Durable Ack in PostgreSQL before completion
    const dbRow = await cluster.appPool.query<{ id: string; status: string }>(
      'SELECT id, status FROM tasks WHERE tenant_id = $1 AND id = $2',
      [cluster.tenantA.tenantId, receipt.task_id],
    );
    expect(dbRow.rows.length).toBe(1);
    expect(dbRow.rows[0]?.id).toBe(receipt.task_id);

    // 3. Await completion by Worker
    const completed = await cluster.waitForTask(
      receipt.task_id,
      'completed',
      cluster.tenantA.token,
    );
    expect(completed.status).toBe('completed');
    expect(completed.task_id).toBe(receipt.task_id);

    // 4. Verify that Zero Fake Sandboxes were created for Fast Path
    const sandboxesCreated = cluster.totalSandboxesCreated - prevSandboxes;
    expect(sandboxesCreated).toBe(0);
    expect(cluster.activeSandboxes).toBe(0);

    // 5. Query persisted event sequence via HTTP GET /v1/tasks/:taskId/events
    const eventsRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/events`, {
      token: cluster.tenantA.token,
    });
    expect(eventsRes.status).toBe(200);
    const eventsData = (await eventsRes.json()) as {
      events: Array<{ sequence: number; phase: string; payload: Record<string, unknown> }>;
    };

    expect(eventsData.events.length).toBeGreaterThanOrEqual(3);
    const phases = eventsData.events.map((e) => e.phase);
    expect(phases).toContain('accepted');
    expect(phases).toContain('started');
    expect(phases).toContain('completed');

    // Monotonic sequences starting at 1
    const sequences = eventsData.events.map((e) => e.sequence);
    for (let i = 0; i < sequences.length; i++) {
      expect(sequences[i]).toBe(i + 1);
    }
  });
});
