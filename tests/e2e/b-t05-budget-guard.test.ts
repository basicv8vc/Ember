import type { BudgetPolicy } from '@ember/execution';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T05 E2E Budget Guard Critical Path', () => {
  let cluster: E2eCluster;
  let agentId: string;

  const STRICT_BUDGET: BudgetPolicy = Object.freeze({
    policyId: 'e2e-strict-budget-v1',
    policyVersion: 1,
    maxRunSteps: 0, // Zero steps allowed -> fail closed on step reservation
    maxRunUnits: 0,
    maxRunElapsedMs: 60_000,
    maxTenantDailyUnits: 10_000,
    maxConcurrentSlots: 10,
  });

  beforeAll(async () => {
    cluster = await E2eCluster.start({
      budgetPolicy: STRICT_BUDGET,
    });

    const res = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'E2E-Budget-Agent' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    agentId = body.agent_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('fails closed when budget limit is exceeded and records failed status in DB', async () => {
    // 1. Submit a task
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.chat',
        input: { prompt: 'This task should be stopped by budget enforcement' },
      },
    });
    expect(taskRes.status).toBe(202);
    const receipt = (await taskRes.json()) as { task_id: string };

    // 2. Worker attempts reservation for step 'produce', which fails closed with BUDGET_EXCEEDED
    const failedTask = await cluster.waitForTask(receipt.task_id, 'failed', cluster.tenantA.token);
    expect(failedTask.status).toBe('failed');

    // 3. Verify in PostgreSQL that runs record reflects failure
    const runRows = await cluster.appPool.query<{ status: string }>(
      'SELECT status FROM runs WHERE tenant_id = $1 AND task_id = $2 ORDER BY attempt DESC LIMIT 1',
      [cluster.tenantA.tenantId, receipt.task_id],
    );
    expect(runRows.rows.length).toBe(1);
    expect(runRows.rows[0]?.status).toBe('failed_terminal');

    // Verify failed event is recorded
    const eventsRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/events`, {
      token: cluster.tenantA.token,
    });
    expect(eventsRes.status).toBe(200);
    const eventsData = (await eventsRes.json()) as { events: Array<{ phase: string }> };
    const phases = eventsData.events.map((e) => e.phase);
    expect(phases).toContain('failed');

    // 4. Verify no artifacts were staged or committed
    const artifactsRes = await cluster.fetch(`/v1/tasks/${receipt.task_id}/artifacts`, {
      token: cluster.tenantA.token,
    });
    expect(artifactsRes.status).toBe(200);
    const artifactsData = (await artifactsRes.json()) as { artifacts: unknown[] };
    expect(artifactsData.artifacts.length).toBe(0);
  });
});
