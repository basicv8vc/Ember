import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });
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

  it('requires real Agent B D1 migrations for ab_runtime and fails closed when binding or v2_recovery_registry is missing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ember-v2-ab-d1-check-'));
    tempDirs.push(dir);
    writeFileSync(
      path.join(dir, 'worker.mjs'),
      `export default { async fetch() { return new Response('ok'); } };`,
      'utf8',
    );

    // 1. Missing D1 binding fails closed
    const noD1Config = path.join(dir, 'no-d1.jsonc');
    writeFileSync(
      noD1Config,
      JSON.stringify({
        name: 'ember-v2-ab-check-nod1',
        main: 'worker.mjs',
        compatibility_date: '2026-11-01',
      }),
      'utf8',
    );
    await expect(
      V2LocalRuntimeHarness.start({
        target: { kind: 'ab_runtime', configPath: noD1Config },
      }),
    ).rejects.toThrow(/D1 binding "D1_RECOVERY" is missing/);

    // 2. D1 binding without B migrations does NOT mask missing v2_recovery_registry
    const noMigConfig = path.join(dir, 'no-mig.jsonc');
    writeFileSync(
      noMigConfig,
      JSON.stringify({
        name: 'ember-v2-ab-check-nomig',
        main: 'worker.mjs',
        compatibility_date: '2026-11-01',
        d1_databases: [
          {
            binding: 'D1_RECOVERY',
            database_name: 'ab-test-d1',
            database_id: '00000000-0000-0000-0000-000000000011',
          },
        ],
      }),
      'utf8',
    );
    await expect(
      V2LocalRuntimeHarness.start({
        target: { kind: 'ab_runtime', configPath: noMigConfig },
      }),
    ).rejects.toThrow(/v2_recovery_registry.*missing/);

    // 3. D1 binding with B migrations_dir applies real migrations and passes verification
    const migDir = path.join(dir, 'd1-migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(
      path.join(migDir, '0001_recovery.sql'),
      `CREATE TABLE IF NOT EXISTS v2_recovery_registry (
        agent_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        next_recovery_at_ms INTEGER NOT NULL,
        retry_not_before_ms INTEGER,
        status TEXT NOT NULL,
        sweep_lease_owner TEXT,
        sweep_lease_expires_at_ms INTEGER,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        updated_at_ms INTEGER NOT NULL
      );`,
      'utf8',
    );
    const withMigConfig = path.join(dir, 'with-mig.jsonc');
    writeFileSync(
      withMigConfig,
      JSON.stringify({
        name: 'ember-v2-ab-check-withmig',
        main: 'worker.mjs',
        compatibility_date: '2026-11-01',
        d1_databases: [
          {
            binding: 'D1_RECOVERY',
            database_name: 'ab-test-d1-mig',
            database_id: '00000000-0000-0000-0000-000000000012',
            migrations_dir: 'd1-migrations',
          },
        ],
      }),
      'utf8',
    );

    const harness = await V2LocalRuntimeHarness.start({
      target: { kind: 'ab_runtime', configPath: withMigConfig },
    });
    try {
      const res = await harness.fetch('/');
      expect(res.status).toBe(200);
    } finally {
      await harness.dispose();
    }
  });
});
