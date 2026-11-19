import { afterEach, describe, expect, it } from 'vitest';
import {
  DST_TRANSITION_FIXTURES,
  FakeModelGatewayServer,
  V2FaultInjector,
  V2_M1_ACCEPTANCE_MATRIX,
  assertIsolatedWranglerConfig,
  assertLoopbackHttpUrl,
  assertSafeLocalV2RuntimeEnv,
  buildSanitizedLocalWorkerVars,
  resolveAbRuntimeTarget,
  runV2M1CostReestimation,
  runV2M1FullRuntimeBenchmark,
} from '../../apps/benchmark/src/v2-m1/index.js';

describe('V2-M1-D Harness Toolkit & Guards (Unit)', () => {
  const serversToClose: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (serversToClose.length > 0) {
      const close = serversToClose.pop()!;
      await close();
    }
  });

  it('enforces strict V1/cloud/production isolation guardrails', () => {
    expect(() => assertSafeLocalV2RuntimeEnv({ EMBER_ENV: 'production' })).toThrow(/production/);
    expect(() => assertSafeLocalV2RuntimeEnv({ EMBER_ENV: 'staging' })).toThrow(/staging/);
    expect(() => assertSafeLocalV2RuntimeEnv({ NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => assertSafeLocalV2RuntimeEnv({ EMBER_MODEL_MODE: 'real' })).toThrow(/real/);
    expect(() => assertSafeLocalV2RuntimeEnv({ EMBER_DAYTONA_ENABLED: 'true' })).toThrow(/Daytona/);
    expect(() =>
      assertSafeLocalV2RuntimeEnv(
        { EMBER_ENV: 'test' },
        { fakeGatewayUrl: 'https://api.openai.com' },
      ),
    ).toThrow(/loopback/);

    expect(() => assertLoopbackHttpUrl('fakeGatewayUrl', 'http://127.0.0.1:8787')).not.toThrow();
    expect(() =>
      assertIsolatedWranglerConfig({ routes: [{ pattern: 'ember-api.slowfast.dev' }] }),
    ).toThrow(/routes/);
    expect(() => assertIsolatedWranglerConfig({ hyperdrive: [{ binding: 'HYPERDRIVE' }] })).toThrow(
      /Hyperdrive/,
    );
    expect(() => assertIsolatedWranglerConfig({ vars: { EMBER_ENV: 'staging' } })).toThrow(
      /staging/,
    );
    expect(() =>
      assertIsolatedWranglerConfig({ vars: { DATABASE_URL: 'postgres://prod/db' } }),
    ).toThrow(/DATABASE_URL/);

    const vars = buildSanitizedLocalWorkerVars({ FAKE_MODEL_GATEWAY_URL: 'http://127.0.0.1:9999' });
    expect(vars.EMBER_ENV).toBe('test');
    expect(vars.EMBER_MODEL_MODE).toBe('fake');
    expect(vars.EMBER_V2_ISOLATED_HARNESS).toBe('true');
    expect(() => buildSanitizedLocalWorkerVars({ OPENAI_API_KEY: 'sk-forbidden' })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('runs FakeModelGatewayServer across fast, stream, handoff, usage_missing, late_revision, and abort modes', async () => {
    const gateway = new FakeModelGatewayServer();
    const baseUrl = await gateway.start();
    serversToClose.push(() => gateway.stop());

    // 1. fast_ok
    const r1 = await fetch(`${baseUrl}/v2/fake-model/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-operation-id': 'op-1' },
      body: JSON.stringify({ prompt: 'Hello Ember' }),
    });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { simulated: boolean; usage: { costMicroUsd: number } };
    expect(j1.simulated).toBe(true);
    expect(j1.usage.costMicroUsd).toBe(120);

    // 2. stream_sse
    const r2 = await fetch(`${baseUrl}/v2/fake-model/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-operation-id': 'op-2' },
      body: JSON.stringify({ prompt: 'Stream please', stream: true }),
    });
    expect(r2.status).toBe(200);
    const sseText = await r2.text();
    expect(sseText).toContain('event: job_handle');
    expect(sseText).toContain('event: delta');
    expect(sseText).toContain('event: done');

    // 3. slow_handoff + job handle polling
    gateway.setOperationRule('op-handoff', {
      mode: 'slow_handoff',
      delayMs: 100,
      providerJobHandle: 'job-handoff-1',
    });
    const r3 = await fetch(`${baseUrl}/v2/fake-model/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-operation-id': 'op-handoff' },
      body: JSON.stringify({ prompt: 'Long reasoning' }),
    });
    expect(r3.status).toBe(200);
    const poll = await fetch(`${baseUrl}/v2/fake-model/jobs/job-handoff-1`);
    expect(poll.status).toBe(200);
    const pollJson = (await poll.json()) as { status: string };
    expect(['running', 'completed']).toContain(pollJson.status);

    // 4. usage_missing & late_charge_revision
    gateway.setOperationRule('op-missing-usage', { mode: 'usage_missing' });
    const r4 = await fetch(`${baseUrl}/v2/fake-model/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-operation-id': 'op-missing-usage' },
      body: JSON.stringify({ prompt: 'Missing usage' }),
    });
    const j4 = (await r4.json()) as { usage: unknown };
    expect(j4.usage).toBeNull();

    gateway.setOperationRule('op-late', {
      mode: 'late_charge_revision',
      costMicroUsd: 100,
      lateRevisionCostMicroUsd: 550,
    });
    await fetch(`${baseUrl}/v2/fake-model/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-operation-id': 'op-late' },
      body: JSON.stringify({ prompt: 'Late charge' }),
    });
    const revRes = await fetch(`${baseUrl}/v2/fake-model/revisions/op-late`);
    const revJson = (await revRes.json()) as {
      settlementRevision: number;
      cumulativeChargeMicroUsd: number;
    };
    expect(revJson.settlementRevision).toBe(1);
    expect(revJson.cumulativeChargeMicroUsd).toBe(550);

    const audit = gateway.getAuditSnapshot();
    expect(audit.totalCalls).toBe(5);
    expect(audit.jobPollCount).toBe(1);
  });

  it('provides deterministic FaultInjector controls, forged envelopes, DST fixtures, and concurrency races', async () => {
    const injector = new V2FaultInjector();
    const controlUrl = await injector.startControlServer();
    serversToClose.push(() => injector.stopControlServer());

    injector.setD1Fault('unavailable', 15);
    injector.setGlobalBudgetFault('halt_usage_missing');
    injector.setAlarmExhaustion(6);
    injector.setCrashPoint('after_do_pending_before_d1', true);
    injector.setVirtualNowMs(DST_TRANSITION_FIXTURES.spring_forward_2026_ny.beforeTransitionUtcMs);

    const stateRes = await fetch(`${controlUrl}/faults/state`);
    const state = (await stateRes.json()) as {
      d1Mode: string;
      globalBudgetMode: string;
      alarmFailRemaining: number;
      queuedCrashPoints: string[];
    };
    expect(state.d1Mode).toBe('unavailable');
    expect(state.globalBudgetMode).toBe('halt_usage_missing');
    expect(state.alarmFailRemaining).toBe(6);
    expect(state.queuedCrashPoints).toEqual(['after_do_pending_before_d1']);

    for (let i = 0; i < 6; i++) {
      expect(injector.consumeAlarmFailure()).toBe(true);
    }
    expect(injector.consumeAlarmFailure()).toBe(false);
    expect(injector.consumeCrashPoint('after_do_pending_before_d1')).toBe(true);
    expect(injector.consumeCrashPoint('after_do_pending_before_d1')).toBe(false);

    const validEnvelope = {
      schemaVersion: 2 as const,
      eventId: 'outbox-1',
      tenantId: 't-1',
      agentId: 'a-1',
      entityKind: 'turn' as const,
      entityId: 'turn-1',
      queueName: 'durable_turn' as const,
      fenceEpoch: 3,
    };
    expect(injector.buildForgedEnvelope(validEnvelope, 'budget_sync_in_queue').entityKind).toBe(
      'budget_sync',
    );
    expect(injector.buildForgedEnvelope(validEnvelope, 'null_queue_name').queueName).toBeNull();
    expect(injector.buildForgedEnvelope(validEnvelope, 'future_fence_epoch').fenceEpoch).toBe(103);

    const race = await injector.runConcurrentRace([
      () => Promise.resolve('winner'),
      () => Promise.resolve('loser'),
    ]);
    expect(race).toHaveLength(2);
    expect(race.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('catalogues F-1..F-23 and FI-01..FI-16 honestly and re-estimates ADR-0006 costs without a 20-row fixed constraint', async () => {
    const fIds = V2_M1_ACCEPTANCE_MATRIX.filter((e) => e.family === 'M0A_F').map((e) => e.id);
    const fiIds = V2_M1_ACCEPTANCE_MATRIX.filter((e) => e.family === 'M0B_FI').map((e) => e.id);

    expect(fIds).toHaveLength(23);
    expect(fiIds).toHaveLength(16);
    expect(V2_M1_ACCEPTANCE_MATRIX.every((e) => e.status === 'blocked_awaiting_ab_m1')).toBe(true);

    const target = resolveAbRuntimeTarget({});
    expect(target.available).toBe(false);
    await expect(runV2M1FullRuntimeBenchmark()).rejects.toThrow(/blocked/i);

    const costReport = runV2M1CostReestimation();
    expect(costReport.fixed20RowsConstraintEnforced).toBe(false);
    expect(costReport.rows.some((r) => r.doRowsWrittenPerEvent > 20)).toBe(true);
    expect(costReport.rows.every((r) => r.cloudRuntimeUsd >= 5)).toBe(true);
  });
});
