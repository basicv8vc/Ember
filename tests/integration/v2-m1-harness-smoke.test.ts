import { describe, expect, it } from 'vitest';
import { V2LocalRuntimeHarness } from '../../apps/benchmark/src/v2-m1/index.js';

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe('V2-M1-D Local workerd Harness Infrastructure (Integration Smoke)', () => {
  it('boots isolated workerd topology with AgentHeadDO, GlobalBudgetDO, D1, Queues+DLQ, Scheduled, and FakeModelGateway', async () => {
    const harness = await V2LocalRuntimeHarness.start({
      target: { kind: 'harness_smoke' },
    });

    try {
      // 1. Isolation health check
      const health = await harness.fetchJson<{
        ok: boolean;
        evidenceKind: string;
        emberEnv: string;
        modelMode: string;
        isolated: boolean;
      }>('/harness-smoke/health');
      expect(health.status).toBe(200);
      expect(health.data.ok).toBe(true);
      expect(health.data.evidenceKind).toBe('harness_infra_smoke_only');
      expect(health.data.emberEnv).toBe('test');
      expect(health.data.modelMode).toBe('fake');
      expect(health.data.isolated).toBe(true);

      // 2. AgentHeadDO SQLite + Alarm firing + evictDurableObject state persistence
      const doBefore = await harness.fetchJson<{
        ok: boolean;
        state: { alarm_fires: number; boot_counter: number };
      }>('/harness-smoke/do?agent=smoke-alpha');
      expect(doBefore.status).toBe(200);
      expect(doBefore.data.state.boot_counter).toBe(1);

      const armRes = await harness.fetchJson<{ armedAtMs: number }>(
        '/harness-smoke/do?agent=smoke-alpha&action=arm',
        { delayMs: 40 },
      );
      expect(armRes.status).toBe(200);

      const firedState = await waitFor(async () => {
        const res = await harness.fetchJson<{
          state: { alarm_fires: number; last_alarm_ms: number | null };
        }>('/harness-smoke/do?agent=smoke-alpha');
        return res.data.state.alarm_fires >= 1 ? res.data.state : null;
      }, 10_000);
      expect(firedState.alarm_fires).toBeGreaterThanOrEqual(1);
      expect(firedState.last_alarm_ms).not.toBeNull();

      // Simulate silent DO eviction and verify durable SQLite survives while in-memory restarts
      await harness.evictDurableObject('AGENT_HEAD', { name: 'smoke-alpha' });
      const doAfterEvict = await harness.fetchJson<{
        state: { alarm_fires: number; boot_counter: number };
      }>('/harness-smoke/do?agent=smoke-alpha');
      expect(doAfterEvict.data.state.alarm_fires).toBeGreaterThanOrEqual(1);
      expect(doAfterEvict.data.state.boot_counter).toBe(2);

      // 3. GlobalBudgetDO SQLite
      const budgetRes = await harness.fetchJson<{ ok: boolean; checks: number }>(
        '/harness-smoke/budget',
      );
      expect(budgetRes.status).toBe(200);
      expect(budgetRes.data.ok).toBe(true);
      expect(budgetRes.data.checks).toBeGreaterThanOrEqual(1);

      // 4. D1 canonical v2_recovery_registry schema
      const d1Res = await harness.fetchJson<{
        ok: boolean;
        results: Array<{ cnt: number }>;
      }>('/harness-smoke/d1');
      expect(d1Res.status).toBe(200);
      expect(d1Res.data.results[0]?.cnt).toBe(1);

      // 5. Queues (durable_turn ack + agent_task ack + 5-retry exhaustion -> durable_turn_dlq)
      await harness.fetchJson('/harness-smoke/queue', {
        queue: 'durable_turn',
        payload: { id: 'ok-1' },
      });
      await harness.fetchJson('/harness-smoke/queue', {
        queue: 'agent_task',
        payload: { id: 'task-1' },
      });
      await harness.fetchJson('/harness-smoke/queue', {
        queue: 'durable_turn',
        payload: { id: 'dlq-1', forceFail: true },
      });

      // 6. Scheduled cron trigger (* * * * *)
      const sched = await harness.triggerScheduled(Date.now(), '* * * * *');
      expect(sched.outcome).toBe('ok');

      // Wait for queue acks, DLQ delivery (after retries), and scheduled event in R2
      const events = await waitFor(async () => {
        const res = await harness.fetchJson<{
          items: Array<{ queue?: string; cron?: string; body?: { id?: string } }>;
        }>('/harness-smoke/events');
        const hasTurnAck = res.data.items.some(
          (i) => i.queue === 'durable_turn' && i.body?.id === 'ok-1',
        );
        const hasTaskAck = res.data.items.some(
          (i) => i.queue === 'agent_task' && i.body?.id === 'task-1',
        );
        const hasDlq = res.data.items.some(
          (i) => i.queue === 'durable_turn_dlq' && i.body?.id === 'dlq-1',
        );
        const hasCron = res.data.items.some((i) => i.cron === '* * * * *');
        return hasTurnAck && hasTaskAck && hasDlq && hasCron ? res.data.items : null;
      }, 15_000);
      expect(events.length).toBeGreaterThanOrEqual(4);

      // 7. Worker inside workerd -> loopback FakeModelGateway
      const modelRes = await harness.fetchJson<{
        simulated: boolean;
        modelLabel: string;
        text: string;
      }>('/harness-smoke/fake-model', {
        operationId: 'smoke-op-1',
        prompt: 'Verify loopback fake model',
      });
      expect(modelRes.status).toBe(200);
      expect(modelRes.data.simulated).toBe(true);
      expect(modelRes.data.modelLabel).toBe('ember-fake-model-gateway-1');
      expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});
