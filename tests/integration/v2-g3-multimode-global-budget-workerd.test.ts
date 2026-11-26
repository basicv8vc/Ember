import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_BUDGET_OBJECT_NAME,
  GLOBAL_BUDGET_REAL_OBJECT_NAME,
  isRealGlobalGrantId,
} from '../../packages/runtime-v2/src/global-budget/platform.js';
import { formatRecoveryAgentKey } from '../../packages/runtime-v2/src/recovery/registry.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const runtimePackage = createRequire(
  new URL('../../packages/runtime-v2/package.json', import.meta.url),
);

const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL('../../packages/runtime-v2/migrations/0001_v2_recovery_registry.sql', import.meta.url),
  ),
  'utf8',
);

interface WorkerdStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Promise<T[]>;
}

interface WorkerdHarness {
  listen(): Promise<void>;
  fetch(path: string, init: RequestInit): Promise<Response>;
  update(options: unknown): Promise<void>;
  getWorker(): {
    evictDurableObject(binding: string, options: { name: string }): Promise<void>;
    getDurableObjectStorage(binding: string, options: { name: string }): Promise<WorkerdStorage>;
  };
  close(): Promise<void>;
}

function buildWorkerConfig(vars: Record<string, string>) {
  return {
    name: 'ember-v2-g3-multimode-budget-test',
    main: 'tests/integration/support/v2-g3-multimode-global-budget.worker.mjs',
    compatibility_date: '2026-11-01',
    send_metrics: false,
    compatibility_flags: ['nodejs_compat'],
    vars,
    alias: {
      '@ember/runtime-v2/global-budget-do': runtimePackage.resolve(
        '@ember/runtime-v2/global-budget-do',
      ),
      '@ember/runtime-v2': runtimePackage.resolve('@ember/runtime-v2'),
    },
    durable_objects: {
      bindings: [
        { name: 'AGENT_HEAD', class_name: 'AgentHeadDO' },
        { name: 'GLOBAL_BUDGET', class_name: 'GlobalBudgetDO' },
      ],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['AgentHeadDO', 'GlobalBudgetDO'] }],
    d1_databases: [{ binding: 'D1_RECOVERY', database_name: 'v2-g3-multimode-d1' }],
    queues: {
      producers: [
        { binding: 'DURABLE_TURN_QUEUE', queue: 'v2-g3-durable-turn' },
        { binding: 'AGENT_TASK_QUEUE', queue: 'v2-g3-agent-task' },
      ],
      consumers: [{ queue: 'v2-g3-durable-turn' }, { queue: 'v2-g3-agent-task' }],
    },
  };
}

const FAKE_VARS = {
  EMBER_ENV: 'v2-staging',
  EMBER_MODEL_MODE: 'fake',
  EMBER_SANDBOX_MODE: 'fake',
  EMBER_V2_STAGING_ISOLATED: 'true',
  EMBER_V2_ALLOWED_HOST: 'ember-v2-staging.slowfast.dev',
};

const REAL_VARS = {
  ...FAKE_VARS,
  EMBER_MODEL_MODE: 'real',
  EMBER_MODEL_PROVIDER: 'openrouter',
  EMBER_MODEL_ID: 'deepseek/deepseek-v4.1-flash-1017',
  EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
  EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD: '5000',
  EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: '50000',
  EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: '50000',
  EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '100000',
  GLOBAL_DAILY_CEILING_MICRO_USD: '100000',
  EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: '20',
};

async function postJson<T>(harness: WorkerdHarness, path: string, body: unknown): Promise<T> {
  const res = await harness.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function headRpc<T>(
  harness: WorkerdHarness,
  params: { tenantId: string; agentId: string; method: string; request: unknown },
): Promise<T> {
  const res = await postJson<{ value?: T; code?: string }>(harness, '/head/rpc', params);
  if ('code' in res && res.code !== undefined) {
    throw new Error(`AgentHeadDO RPC ${params.method} returned error code: ${res.code}`);
  }
  return res.value as T;
}

function makeTurnReservation(mode: 'fake' | 'real') {
  return mode === 'real'
    ? {
        budgetMode: 'real' as const,
        providerId: 'openrouter' as const,
        modelLabel: 'deepseek/deepseek-v4.1-flash-1017',
        rateVersion: 'openrouter-deepseek-v4.1-flash-1017-deepinfra-fp8-2026-11-17',
        maxAttempts: 1,
        estimatedMicroUsd: 935,
      }
    : {
        budgetMode: 'simulated_full_protocol' as const,
        providerId: 'fake' as const,
        modelLabel: 'ember-fake-llm-1',
        rateVersion: 'v2-fake-simulated-2026-11-17',
        maxAttempts: 1,
        estimatedMicroUsd: 250,
      };
}

function makePrepareTurnRequest(params: {
  tenantId: string;
  principalId: string;
  agentId: string;
  conversationId: string;
  mode: 'fake' | 'real';
  text: string;
  transcriptEpoch: number;
  workerId: string;
}) {
  return {
    scope: {
      tenantId: params.tenantId,
      principalId: params.principalId,
      agentId: params.agentId,
      policyVersion: 1,
      requestId: randomUUID(),
    },
    conversationId: params.conversationId,
    request: {
      client_submission_id: randomUUID(),
      text: params.text,
      transcript_epoch: params.transcriptEpoch,
    },
    executionMode: 'fast_interactive' as const,
    workerId: params.workerId,
    leaseMs: 45_000,
    interactiveDeadlineMs: 120_000,
    turnDeadlineMs: 600_000,
    modelReservation: makeTurnReservation(params.mode),
  };
}

describe('V2 G3 multi-mode GlobalBudgetDO transitions in workerd', () => {
  it('preserves populated 5M Fake UTC day across Fake redeploy and isolates Fake -> Real -> Fake transitions with alarms and late settlements', async () => {
    const wrangler = (await import(apiRequire.resolve('wrangler'))) as {
      createTestHarness(options: unknown): WorkerdHarness;
    };

    const harness = wrangler.createTestHarness({
      root: REPO_ROOT,
      workers: [{ config: buildWorkerConfig(FAKE_VARS) }],
    });
    await harness.listen();

    try {
      const tenantId = randomUUID();
      const principalId = randomUUID();
      const agentId = randomUUID();
      const conversationId = randomUUID();
      const todayUtc = new Date().toISOString().slice(0, 10);

      await postJson(harness, '/d1/migrate', { sql: MIGRATION_SQL });
      await postJson(harness, '/head/bootstrap', { tenantId, agentId, conversationId });

      // 1. Fake baseline: populates 'global' DO with 5,000,000 ceiling on today's UTC day.
      const fake1 = await headRpc<{
        kind: string;
        turnId: string;
        attemptNo: number;
        operationId: string;
        leaseEpoch: number;
        globalGrantId: string;
      }>(harness, {
        tenantId,
        agentId,
        method: 'prepareTurn',
        request: makePrepareTurnRequest({
          tenantId,
          principalId,
          agentId,
          conversationId,
          mode: 'fake',
          text: 'fake baseline turn',
          transcriptEpoch: 0,
          workerId: 'worker-fake-1',
        }),
      });
      expect(fake1.kind).toBe('prepared');
      expect(isRealGlobalGrantId(fake1.globalGrantId)).toBe(false);

      await headRpc(harness, {
        tenantId,
        agentId,
        method: 'markAttemptSent',
        request: {
          scope: { tenantId, agentId },
          subjectType: 'turn',
          subjectId: fake1.turnId,
          attemptNo: fake1.attemptNo,
          operationId: fake1.operationId,
          leaseEpoch: fake1.leaseEpoch,
          leaseOwner: 'worker-fake-1',
        },
      });
      await headRpc(harness, {
        tenantId,
        agentId,
        method: 'commitTurn',
        request: {
          scope: { tenantId, agentId },
          conversationId,
          turnId: fake1.turnId,
          leaseEpoch: fake1.leaseEpoch,
          leaseOwner: 'worker-fake-1',
          attemptNo: fake1.attemptNo,
          operationId: fake1.operationId,
          settlement: {
            state: 'settled',
            outcomeCode: 'ok',
            observedCostMicroUsd: 100,
            inputTokens: 10,
            outputTokens: 5,
          },
          result: {
            status: 'completed',
            text: 'fake reply 1',
            modelLabel: 'ember-fake-llm-1',
            simulated: true,
          },
        },
      });

      // 2. Routine Fake redeploy on the SAME UTC day must keep accepting Fake reservations.
      await harness.update({
        root: REPO_ROOT,
        workers: [{ config: buildWorkerConfig(FAKE_VARS) }],
      });

      const fakeInFlight = await headRpc<{
        kind: string;
        turnId: string;
        attemptNo: number;
        operationId: string;
        leaseEpoch: number;
        globalGrantId: string;
      }>(harness, {
        tenantId,
        agentId,
        method: 'prepareTurn',
        request: makePrepareTurnRequest({
          tenantId,
          principalId,
          agentId,
          conversationId,
          mode: 'fake',
          text: 'fake in-flight before real switch',
          transcriptEpoch: 0,
          workerId: 'worker-fake-2',
        }),
      });
      expect(fakeInFlight.kind).toBe('prepared');
      expect(isRealGlobalGrantId(fakeInFlight.globalGrantId)).toBe(false);

      // Also plant a short-TTL fake reservation directly on 'global' whose alarm will fire after switching to Real.
      const fakeAlarmOpId = randomUUID();
      const fakeAlarmGrant = await postJson<{ kind: string; globalGrantId: string }>(
        harness,
        '/gb/reserve',
        {
          target: 'fake',
          request: {
            tenantId,
            principalId,
            agentId,
            operationId: fakeAlarmOpId,
            leaseEpoch: 1,
            utcDay: todayUtc,
            amountMicroUsd: 250,
            ceilingMicroUsd: 5_000_000,
            expiresAtMs: Date.now() + 900,
          },
        },
      );
      expect(fakeAlarmGrant.kind).toBe('reserved');

      // 3. Switch Fake -> Real (100,000 ceiling) on the SAME UTC day!
      await harness.update({
        root: REPO_ROOT,
        workers: [{ config: buildWorkerConfig(REAL_VARS) }],
      });

      // 'global' DO must still load cleanly for its pending alarm (expiring fakeAlarmOpId) despite Real mode!
      await harness
        .getWorker()
        .evictDurableObject('GLOBAL_BUDGET', { name: GLOBAL_BUDGET_OBJECT_NAME })
        .catch(() => undefined);
      const fakeStorage = await harness
        .getWorker()
        .getDurableObjectStorage('GLOBAL_BUDGET', { name: GLOBAL_BUDGET_OBJECT_NAME });
      await expect
        .poll(
          () =>
            fakeStorage.exec<{ state: string }>(
              'SELECT state FROM global_budget_reservations WHERE operation_id = ?',
              fakeAlarmOpId,
            ),
          { timeout: 8_000, interval: 100 },
        )
        .toEqual([{ state: 'expired_consumed' }]);

      // In-flight fake turn from before the switch must authorize & settle on 'global', NOT 'global-real'!
      const fakeAuthAfterSwitch = await headRpc<{ authorized: boolean }>(harness, {
        tenantId,
        agentId,
        method: 'markAttemptSent',
        request: {
          scope: { tenantId, agentId },
          subjectType: 'turn',
          subjectId: fakeInFlight.turnId,
          attemptNo: fakeInFlight.attemptNo,
          operationId: fakeInFlight.operationId,
          leaseEpoch: fakeInFlight.leaseEpoch,
          leaseOwner: 'worker-fake-2',
        },
      });
      expect(fakeAuthAfterSwitch.authorized).toBe(true);

      await headRpc(harness, {
        tenantId,
        agentId,
        method: 'commitTurn',
        request: {
          scope: { tenantId, agentId },
          conversationId,
          turnId: fakeInFlight.turnId,
          leaseEpoch: fakeInFlight.leaseEpoch,
          leaseOwner: 'worker-fake-2',
          attemptNo: fakeInFlight.attemptNo,
          operationId: fakeInFlight.operationId,
          settlement: {
            state: 'settled',
            outcomeCode: 'ok',
            observedCostMicroUsd: 120,
            inputTokens: 12,
            outputTokens: 6,
          },
          result: {
            status: 'completed',
            text: 'fake reply settled after real deploy',
            modelLabel: 'ember-fake-llm-1',
            simulated: true,
          },
        },
      });

      // Real mode must refuse new reservations against the 'global' DO.
      const wrongFakeReserve = await postJson<{ kind: string }>(harness, '/gb/reserve', {
        target: 'fake',
        request: {
          tenantId,
          principalId,
          agentId,
          operationId: randomUUID(),
          leaseEpoch: 1,
          utcDay: todayUtc,
          amountMicroUsd: 250,
          ceilingMicroUsd: 100_000,
          expiresAtMs: Date.now() + 60_000,
        },
      });
      expect(wrongFakeReserve).toEqual({ kind: 'budget_exceeded' });

      // New Real turns reserve cleanly on 'global-real' with 100,000 ceiling!
      const realInFlight = await headRpc<{
        kind: string;
        turnId: string;
        attemptNo: number;
        operationId: string;
        leaseEpoch: number;
        globalGrantId: string;
      }>(harness, {
        tenantId,
        agentId,
        method: 'prepareTurn',
        request: makePrepareTurnRequest({
          tenantId,
          principalId,
          agentId,
          conversationId,
          mode: 'real',
          text: 'real canary turn before rollback',
          transcriptEpoch: 0,
          workerId: 'worker-real-1',
        }),
      });
      expect(realInFlight.kind).toBe('prepared');
      expect(isRealGlobalGrantId(realInFlight.globalGrantId)).toBe(true);

      await headRpc(harness, {
        tenantId,
        agentId,
        method: 'markAttemptSent',
        request: {
          scope: { tenantId, agentId },
          subjectType: 'turn',
          subjectId: realInFlight.turnId,
          attemptNo: realInFlight.attemptNo,
          operationId: realInFlight.operationId,
          leaseEpoch: realInFlight.leaseEpoch,
          leaseOwner: 'worker-real-1',
        },
      });

      const realUnknownInFlight = await headRpc<{
        kind: string;
        turnId: string;
        attemptNo: number;
        operationId: string;
        leaseEpoch: number;
        globalGrantId: string;
      }>(harness, {
        tenantId,
        agentId,
        method: 'prepareTurn',
        request: makePrepareTurnRequest({
          tenantId,
          principalId,
          agentId,
          conversationId,
          mode: 'real',
          text: 'real canary turn unknown outcome before rollback',
          transcriptEpoch: 0,
          workerId: 'worker-real-2',
        }),
      });
      expect(realUnknownInFlight.kind).toBe('prepared');
      expect(isRealGlobalGrantId(realUnknownInFlight.globalGrantId)).toBe(true);

      await headRpc(harness, {
        tenantId,
        agentId,
        method: 'markAttemptSent',
        request: {
          scope: { tenantId, agentId },
          subjectType: 'turn',
          subjectId: realUnknownInFlight.turnId,
          attemptNo: realUnknownInFlight.attemptNo,
          operationId: realUnknownInFlight.operationId,
          leaseEpoch: realUnknownInFlight.leaseEpoch,
          leaseOwner: 'worker-real-2',
        },
      });

      // Also plant a short-TTL real reservation on 'global-real' whose alarm will fire after rollback to Fake!
      const realAlarmOpId = randomUUID();
      const realAlarmGrant = await postJson<{ kind: string; globalGrantId: string }>(
        harness,
        '/gb/reserve',
        {
          target: 'real',
          request: {
            tenantId,
            principalId,
            agentId,
            operationId: realAlarmOpId,
            leaseEpoch: 1,
            utcDay: todayUtc,
            amountMicroUsd: 500,
            ceilingMicroUsd: 100_000,
            expiresAtMs: Date.now() + 900,
          },
        },
      );
      expect(realAlarmGrant.kind).toBe('reserved');

      // 4. Emergency rollback Real -> Fake on the SAME UTC day!
      await harness.update({
        root: REPO_ROOT,
        workers: [{ config: buildWorkerConfig(FAKE_VARS) }],
      });

      // 'global-real' DO must load cleanly under Fake deploy for its pending expiry alarm!
      await harness
        .getWorker()
        .evictDurableObject('GLOBAL_BUDGET', { name: GLOBAL_BUDGET_REAL_OBJECT_NAME })
        .catch(() => undefined);
      const realStorage = await harness
        .getWorker()
        .getDurableObjectStorage('GLOBAL_BUDGET', { name: GLOBAL_BUDGET_REAL_OBJECT_NAME });
      await expect
        .poll(
          () =>
            realStorage.exec<{ state: string }>(
              'SELECT state FROM global_budget_reservations WHERE operation_id = ?',
              realAlarmOpId,
            ),
          { timeout: 8_000, interval: 100 },
        )
        .toEqual([{ state: 'expired_consumed' }]);

      // In-flight Real turns from before rollback settle late AND unknown_billed onto 'global-real' (NOT 'global')!
      await headRpc(harness, {
        tenantId,
        agentId,
        method: 'commitTurn',
        request: {
          scope: { tenantId, agentId },
          conversationId,
          turnId: realInFlight.turnId,
          leaseEpoch: realInFlight.leaseEpoch,
          leaseOwner: 'worker-real-1',
          attemptNo: realInFlight.attemptNo,
          operationId: realInFlight.operationId,
          settlement: {
            state: 'settled',
            outcomeCode: 'ok',
            observedCostMicroUsd: 350,
            inputTokens: 1200,
            outputTokens: 120,
          },
          result: {
            status: 'completed',
            text: 'real reply settled after fake rollback',
            modelLabel: 'deepseek/deepseek-v4.1-flash-1017',
            simulated: false,
          },
        },
      });
      await headRpc(harness, {
        tenantId,
        agentId,
        method: 'commitTurn',
        request: {
          scope: { tenantId, agentId },
          conversationId,
          turnId: realUnknownInFlight.turnId,
          leaseEpoch: realUnknownInFlight.leaseEpoch,
          leaseOwner: 'worker-real-2',
          attemptNo: realUnknownInFlight.attemptNo,
          operationId: realUnknownInFlight.operationId,
          settlement: {
            state: 'unknown_billed',
            outcomeCode: 'model_timeout',
          },
          result: {
            status: 'failed',
            failureReason: 'timeout',
          },
        },
      });

      // Fake mode after rollback must refuse new reservations on 'global-real', and allow new Fake turns on 'global'.
      const wrongRealReserve = await postJson<{ kind: string }>(harness, '/gb/reserve', {
        target: 'real',
        request: {
          tenantId,
          principalId,
          agentId,
          operationId: randomUUID(),
          leaseEpoch: 1,
          utcDay: todayUtc,
          amountMicroUsd: 250,
          ceilingMicroUsd: 5_000_000,
          expiresAtMs: Date.now() + 60_000,
        },
      });
      expect(wrongRealReserve).toEqual({ kind: 'budget_exceeded' });

      const fakeAfterRollback = await headRpc<{ kind: string; globalGrantId: string }>(harness, {
        tenantId,
        agentId,
        method: 'prepareTurn',
        request: makePrepareTurnRequest({
          tenantId,
          principalId,
          agentId,
          conversationId,
          mode: 'fake',
          text: 'fake turn after rollback',
          transcriptEpoch: 0,
          workerId: 'worker-fake-3',
        }),
      });
      expect(fakeAfterRollback.kind).toBe('prepared');
      expect(isRealGlobalGrantId(fakeAfterRollback.globalGrantId)).toBe(false);

      // Verify exact final ledger separation in both DO SQLite databases!
      const fakeStorageAfterRollback = await harness
        .getWorker()
        .getDurableObjectStorage('GLOBAL_BUDGET', { name: GLOBAL_BUDGET_OBJECT_NAME });
      const fakeDay = await fakeStorageAfterRollback.exec<{
        ceiling_micro_usd: number;
        reserved_micro_usd: number;
        consumed_micro_usd: number;
      }>(
        'SELECT ceiling_micro_usd, reserved_micro_usd, consumed_micro_usd FROM global_spend_days WHERE utc_day = ?',
        todayUtc,
      );
      expect(fakeDay).toEqual([
        {
          ceiling_micro_usd: 5_000_000,
          reserved_micro_usd: 250,
          consumed_micro_usd: 100 + 120 + 250,
        },
      ]);

      const realDay = await realStorage.exec<{
        ceiling_micro_usd: number;
        reserved_micro_usd: number;
        consumed_micro_usd: number;
      }>(
        'SELECT ceiling_micro_usd, reserved_micro_usd, consumed_micro_usd FROM global_spend_days WHERE utc_day = ?',
        todayUtc,
      );
      expect(realDay).toEqual([
        {
          ceiling_micro_usd: 100_000,
          reserved_micro_usd: 0,
          consumed_micro_usd: 350 + 935 + 500,
        },
      ]);
    } finally {
      await harness.close();
    }
  });

  it('isolates local AgentHeadDO principalDailyTurns between Fake and Real modes on the same UTC day in workerd (P0-2)', async () => {
    const wrangler = (await import(apiRequire.resolve('wrangler'))) as {
      createTestHarness(options: unknown): WorkerdHarness;
    };

    const harness = wrangler.createTestHarness({
      root: REPO_ROOT,
      workers: [{ config: buildWorkerConfig(FAKE_VARS) }],
    });
    await harness.listen();

    try {
      const tenantId = randomUUID();
      const principalId = randomUUID();
      const agentId = randomUUID();
      const conversationId = randomUUID();
      const todayUtc = new Date().toISOString().slice(0, 10);

      await postJson(harness, '/d1/migrate', { sql: MIGRATION_SQL });
      await postJson(harness, '/head/bootstrap', { tenantId, agentId, conversationId });

      // Run 3 Fake turns (> Real's principalDailyTurns=2 cap) on the same UTC day.
      for (let i = 1; i <= 3; i += 1) {
        const fakeTurn = await headRpc<{
          kind: string;
          turnId: string;
          attemptNo: number;
          operationId: string;
          leaseEpoch: number;
        }>(harness, {
          tenantId,
          agentId,
          method: 'prepareTurn',
          request: makePrepareTurnRequest({
            tenantId,
            principalId,
            agentId,
            conversationId,
            mode: 'fake',
            text: `fake turn ${i}`,
            transcriptEpoch: 0,
            workerId: `worker-fake-${i}`,
          }),
        });
        expect(fakeTurn.kind).toBe('prepared');
        await headRpc(harness, {
          tenantId,
          agentId,
          method: 'markAttemptSent',
          request: {
            scope: { tenantId, agentId },
            subjectType: 'turn',
            subjectId: fakeTurn.turnId,
            attemptNo: fakeTurn.attemptNo,
            operationId: fakeTurn.operationId,
            leaseEpoch: fakeTurn.leaseEpoch,
            leaseOwner: `worker-fake-${i}`,
          },
        });
        await headRpc(harness, {
          tenantId,
          agentId,
          method: 'commitTurn',
          request: {
            scope: { tenantId, agentId },
            conversationId,
            turnId: fakeTurn.turnId,
            leaseEpoch: fakeTurn.leaseEpoch,
            leaseOwner: `worker-fake-${i}`,
            attemptNo: fakeTurn.attemptNo,
            operationId: fakeTurn.operationId,
            settlement: {
              state: 'settled',
              outcomeCode: 'ok',
              observedCostMicroUsd: 100,
              inputTokens: 10,
              outputTokens: 5,
            },
            result: {
              status: 'completed',
              text: `fake reply ${i}`,
              modelLabel: 'ember-fake-llm-1',
              simulated: true,
            },
          },
        });
      }

      // Switch the worker to Real mode with a strict principalDailyTurns=2 limit.
      await harness.update({
        root: REPO_ROOT,
        workers: [
          {
            config: buildWorkerConfig({
              ...REAL_VARS,
              EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: '2',
            }),
          },
        ],
      });

      // Both Real turns succeed despite 3 Fake turns on the same UTC day; the 3rd Real turn hits BUDGET_EXCEEDED.
      for (let i = 1; i <= 2; i += 1) {
        const realTurn = await headRpc<{
          kind: string;
          turnId: string;
          attemptNo: number;
          operationId: string;
          leaseEpoch: number;
        }>(harness, {
          tenantId,
          agentId,
          method: 'prepareTurn',
          request: makePrepareTurnRequest({
            tenantId,
            principalId,
            agentId,
            conversationId,
            mode: 'real',
            text: `real turn ${i}`,
            transcriptEpoch: 0,
            workerId: `worker-real-${i}`,
          }),
        });
        expect(realTurn.kind).toBe('prepared');
      }

      await expect(
        headRpc(harness, {
          tenantId,
          agentId,
          method: 'prepareTurn',
          request: makePrepareTurnRequest({
            tenantId,
            principalId,
            agentId,
            conversationId,
            mode: 'real',
            text: 'real turn 3 blocked',
            transcriptEpoch: 0,
            workerId: 'worker-real-3',
          }),
        }),
      ).rejects.toThrow(/BUDGET_EXCEEDED/);

      // Switch back to Fake mode: Fake turns still succeed independently!
      await harness.update({
        root: REPO_ROOT,
        workers: [{ config: buildWorkerConfig(FAKE_VARS) }],
      });
      const fake4 = await headRpc<{ kind: string }>(harness, {
        tenantId,
        agentId,
        method: 'prepareTurn',
        request: makePrepareTurnRequest({
          tenantId,
          principalId,
          agentId,
          conversationId,
          mode: 'fake',
          text: 'fake turn 4',
          transcriptEpoch: 0,
          workerId: 'worker-fake-4',
        }),
      });
      expect(fake4.kind).toBe('prepared');

      const headStorage = await harness
        .getWorker()
        .getDurableObjectStorage('AGENT_HEAD', { name: formatRecoveryAgentKey(tenantId, agentId) });
      const principalBuckets = await headStorage.exec<{
        budget_mode: string;
        turns_started: number;
        consumed_micro_usd: number;
        reserved_micro_usd: number;
      }>(
        `SELECT budget_mode, turns_started, consumed_micro_usd, reserved_micro_usd
           FROM agent_spend_days
          WHERE scope_kind = 'principal' AND scope_id = ? AND utc_day = ?
          ORDER BY budget_mode ASC`,
        principalId,
        todayUtc,
      );
      expect(principalBuckets).toEqual([
        {
          budget_mode: 'real',
          turns_started: 2,
          consumed_micro_usd: 0,
          reserved_micro_usd: 935 * 2,
        },
        {
          budget_mode: 'simulated_full_protocol',
          turns_started: 4,
          consumed_micro_usd: 300,
          reserved_micro_usd: 250,
        },
      ]);
    } finally {
      await harness.close();
    }
  });
});
