import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DST_TRANSITION_FIXTURES,
  FakeModelGatewayServer,
  V2FaultInjector,
  V2LocalRuntimeHarness,
  V2_M1_ACCEPTANCE_MATRIX,
  assertIsolatedWranglerConfig,
  assertLoopbackHttpUrl,
  assertNoAccidentalEnvFiles,
  assertSafeLocalV2RuntimeEnv,
  buildSanitizedLocalWorkerVars,
  parseStrictJsonc,
  resolveAbRuntimeTarget,
  runV2M1CostReestimation,
  runV2M1FullRuntimeBenchmark,
} from '../../apps/benchmark/src/v2-m1/index.js';

describe('V2-M1-D Harness Toolkit & Guards (Unit)', () => {
  const serversToClose: Array<() => Promise<void>> = [];
  const tempDirsToRemove: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (serversToClose.length > 0) {
      const close = serversToClose.pop()!;
      await close();
    }
    while (tempDirsToRemove.length > 0) {
      const dir = tempDirsToRemove.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces strict V1/cloud/production isolation guardrails and pins immutable worker vars', () => {
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
    expect(() =>
      assertSafeLocalV2RuntimeEnv(
        { EMBER_ENV: 'test' },
        { targetUrl: 'https://ember-api.slowfast.dev' },
      ),
    ).toThrow(/loopback/);

    expect(() => assertLoopbackHttpUrl('fakeGatewayUrl', 'http://127.0.0.1:8787')).not.toThrow();

    const pinned = {
      fakeGatewayUrl: 'http://127.0.0.1:19001',
      faultControlUrl: 'http://127.0.0.1:19002',
    };
    const vars = buildSanitizedLocalWorkerVars(pinned, { CUSTOM_FLAG: 'ok' });
    expect(vars.EMBER_ENV).toBe('test');
    expect(vars.EMBER_MODEL_MODE).toBe('fake');
    expect(vars.EMBER_V2_ISOLATED_HARNESS).toBe('true');
    expect(vars.EMBER_DAYTONA_ENABLED).toBe('false');
    expect(vars.FAKE_MODEL_GATEWAY_URL).toBe(pinned.fakeGatewayUrl);
    expect(vars.V2_FAULT_CONTROL_URL).toBe(pinned.faultControlUrl);
    expect(vars.CUSTOM_FLAG).toBe('ok');

    // Pinned isolation vars cannot be overridden via options.vars
    for (const pinnedKey of [
      'EMBER_ENV',
      'EMBER_MODEL_MODE',
      'EMBER_DAYTONA_ENABLED',
      'FAKE_MODEL_GATEWAY_URL',
      'V2_FAULT_CONTROL_URL',
    ]) {
      expect(() => buildSanitizedLocalWorkerVars(pinned, { [pinnedKey]: 'tampered' })).toThrow(
        /pinned/i,
      );
    }

    expect(() => buildSanitizedLocalWorkerVars(pinned, { OPENAI_API_KEY: 'sk-forbidden' })).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() =>
      buildSanitizedLocalWorkerVars(pinned, { EXTERNAL_API_URL: 'https://remote.example.com' }),
    ).toThrow(/loopback/);
  });

  it('parses strict JSONC with comments/trailing commas and rejects TOML, selected env violations, routes, and remote bindings', () => {
    const validJsonc = `{
      // line comment with trailing comma and https://not-parsed-in-comment.example.com
      "name": "ember-v2-local",
      /* block comment */
      "vars": {
        "EMBER_ENV": "test",
        "GATEWAY_URL": "http://127.0.0.1:8787",
      },
      "env": {
        "staging": {
          "vars": { "EMBER_ENV": "staging" },
          "routes": [{ "pattern": "ember-api.slowfast.dev" }],
        },
        "local": {
          "vars": { "EMBER_LOG_LEVEL": "debug" },
        },
      },
    }`;

    const parsed = parseStrictJsonc(validJsonc, 'wrangler.jsonc');
    expect(() => assertIsolatedWranglerConfig(parsed, 'local')).not.toThrow();
    expect(() => assertIsolatedWranglerConfig(parsed, 'staging')).toThrow(/routes|staging/);
    expect(() => assertIsolatedWranglerConfig(parsed, 'missing_env')).toThrow(/does not exist/);

    // Malformed JSONC and TOML fail closed
    expect(() =>
      parseStrictJsonc('name = "ember"\nmain = "src/index.ts"', 'wrangler.toml'),
    ).toThrow(/Fail-closed/);
    expect(() => parseStrictJsonc('{ "name": "ok" /* unterminated', 'bad.jsonc')).toThrow(
      /unterminated block comment/,
    );
    expect(() => parseStrictJsonc('{ "name": "unterminated', 'bad-str.jsonc')).toThrow(
      /unterminated string literal/,
    );

    // Single route, routes, remote bindings, preview IDs, external DO script_name, Daytona vars
    expect(() => assertIsolatedWranglerConfig({ route: 'example.com/*' })).toThrow(/route/);
    expect(() =>
      assertIsolatedWranglerConfig({ routes: [{ pattern: 'ember-api.slowfast.dev' }] }),
    ).toThrow(/routes/);
    expect(() => assertIsolatedWranglerConfig({ hyperdrive: [{ binding: 'HYPERDRIVE' }] })).toThrow(
      /hyperdrive/,
    );
    expect(() =>
      assertIsolatedWranglerConfig({ d1_databases: [{ binding: 'D1', remote: true }] }),
    ).toThrow(/remote/);
    expect(() =>
      assertIsolatedWranglerConfig({
        d1_databases: [{ binding: 'D1', preview_database_id: 'remote-preview-id' }],
      }),
    ).toThrow(/preview/);
    expect(() =>
      assertIsolatedWranglerConfig({
        durable_objects: {
          bindings: [{ name: 'DO', class_name: 'X', script_name: 'other-worker' }],
        },
      }),
    ).toThrow(/script_name/);
    expect(() => assertIsolatedWranglerConfig({ vars: { EMBER_DAYTONA_ENABLED: 'true' } })).toThrow(
      /DAYTONA/i,
    );
    expect(() => assertIsolatedWranglerConfig({ vars: { DAYTONA_ORG_ID: 'org-123' } })).toThrow(
      /DAYTONA/i,
    );
    expect(() =>
      assertIsolatedWranglerConfig({ vars: { DATABASE_URL: 'postgres://prod/db' } }),
    ).toThrow(/DATABASE_URL/);

    // .dev.vars / .env inheritance check
    const dirWithSecrets = mkdtempSync(path.join(os.tmpdir(), 'ember-v2-guard-env-'));
    tempDirsToRemove.push(dirWithSecrets);
    writeFileSync(path.join(dirWithSecrets, '.dev.vars'), 'OPENAI_API_KEY=sk-secret\n', 'utf8');
    expect(() => assertNoAccidentalEnvFiles(dirWithSecrets)).toThrow(/\.dev\.vars/);
  });

  it('refuses to boot FakeModelGatewayServer or workerd when local isolation preflight fails', async () => {
    const gatewayStartSpy = vi.spyOn(FakeModelGatewayServer.prototype, 'start');

    // 1. Pinned var override attempt must fail before starting FakeModelGatewayServer or workerd
    await expect(
      V2LocalRuntimeHarness.start({
        target: { kind: 'harness_smoke' },
        vars: { EMBER_MODEL_MODE: 'real' },
      }),
    ).rejects.toThrow(/pinned/i);
    expect(gatewayStartSpy).not.toHaveBeenCalled();

    // 2. Non-JSON/TOML ab_runtime config must fail before starting FakeModelGatewayServer or workerd
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ember-v2-guard-toml-'));
    tempDirsToRemove.push(dir);
    const tomlPath = path.join(dir, 'wrangler.toml');
    writeFileSync(tomlPath, 'name = "bad"\nmain = "worker.mjs"\n', 'utf8');
    await expect(
      V2LocalRuntimeHarness.start({
        target: { kind: 'ab_runtime', configPath: tomlPath },
      }),
    ).rejects.toThrow(/Unsupported Wrangler config format/);
    expect(gatewayStartSpy).not.toHaveBeenCalled();

    // 3. Unsafe selected env in JSONC must fail before starting FakeModelGatewayServer or workerd
    const jsoncPath = path.join(dir, 'wrangler.jsonc');
    writeFileSync(
      jsoncPath,
      JSON.stringify({
        name: 'ember-v2-test',
        main: 'worker.mjs',
        compatibility_date: '2026-11-01',
        env: {
          staging: {
            route: 'ember-api.slowfast.dev/*',
            vars: { EMBER_ENV: 'staging' },
          },
        },
      }),
      'utf8',
    );
    await expect(
      V2LocalRuntimeHarness.start({
        target: { kind: 'ab_runtime', configPath: jsoncPath, env: 'staging' },
      }),
    ).rejects.toThrow(/route|staging/);
    expect(gatewayStartSpy).not.toHaveBeenCalled();
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
