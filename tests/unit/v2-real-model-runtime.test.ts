import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import { DomainError } from '@ember/domain';
import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OpenRouterModelGateway,
  SCHEDULED_BRIEF_SYSTEM_PROMPT,
  type FakeStreamingModelGateway,
  type FetchLike,
} from '@ember/model-gateway';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  GLOBAL_BUDGET_OBJECT_NAME,
  GLOBAL_BUDGET_REAL_OBJECT_NAME,
  PROACTIVE_SCHEDULE_RECURRING_REAL_MODEL_DENIED_REPLY,
  applyAgentHeadMigrations,
  checkLocalBudgetCapacitySync,
  createAgentHeadGlobalBudgetOptions,
  createDefaultAgentHeadMigrations,
  findLocalUnresolvedIncidentSync,
  resolveGlobalBudgetObjectName,
  runV2FakePythonSandbox,
  type AgentBudgetIncidentRow,
  type AgentSpendDayRow,
  type D1DatabaseLike,
  type DurableObjectStorageLike,
  type GlobalBudgetAuthority,
  type LocalBudgetCeilings,
  type ProactiveScheduleDetail,
  type ProactiveScheduleSnapshot,
  type QueueLike,
  type RecoveryRegistryPort,
  type V2DispatchEnvelope,
} from '@ember/runtime-v2';
import { GlobalBudgetAuthorityCore } from '../../packages/runtime-v2/src/global-budget/authority.js';
import type { B1SessionRuntime } from '../../apps/api/src/auth/b1-auth-runtime.js';
import { createLocalV2EdgeWorker } from '../../apps/api/src/local-v2/edge-worker.js';
import { executeInteractive } from '../../apps/api/src/local-v2/interactive-executor.js';
import {
  adaptModelGatewayForV2,
  resolveV2GlobalCeilingOverride,
  resolveV2LocalCeilings,
  resolveV2ModelRuntime,
  type V2ModelRuntimeEnv,
} from '../../apps/api/src/local-v2/model-runtime.js';
import {
  resolveV2AllowRecurringBriefs,
  resolveV2SandboxConfig,
} from '../../apps/api/src/local-v2/runtime-config.js';
import { createDurableExecutor } from '../../apps/api/src/local-v2/runtime-durable.js';

const APPROVED_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_A = '33333333-3333-4333-8333-333333333333';
const AGENT_A = '44444444-4444-4444-8444-444444444444';
const CONVERSATION_A = '55555555-5555-4555-8555-555555555555';

function createSqliteStorage(db: DatabaseSync): DurableObjectStorageLike {
  let txDepth = 0;
  const sql = {
    exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const upper = query.trimStart().toUpperCase();
      if (
        bindings.length === 0 &&
        !upper.startsWith('SELECT') &&
        !upper.startsWith('PRAGMA') &&
        !/\bRETURNING\b/i.test(query)
      ) {
        db.exec(query);
        return {
          toArray: () => [] as T[],
          one: () => {
            throw new Error('Expected one SQL row');
          },
          [Symbol.iterator]: () => ([] as T[])[Symbol.iterator](),
        };
      }
      const stmt = db.prepare(query);
      const rows = (
        upper.startsWith('SELECT') || upper.startsWith('PRAGMA') || /\bRETURNING\b/i.test(query)
          ? stmt.all(...(bindings as never[]))
          : (stmt.run(...(bindings as never[])), [])
      ) as T[];
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length === 0) throw new Error('Expected one SQL row');
          return rows[0]!;
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };

  return {
    sql,
    transactionSync<T>(fn: () => T): T {
      const outer = txDepth === 0;
      if (outer) db.exec('BEGIN IMMEDIATE');
      txDepth += 1;
      try {
        const res = fn();
        txDepth -= 1;
        if (outer) db.exec('COMMIT');
        return res;
      } catch (err) {
        txDepth -= 1;
        if (outer) db.exec('ROLLBACK');
        throw err;
      }
    },
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  } as unknown as DurableObjectStorageLike;
}

function createInMemoryHarness(
  options: {
    globalCeilingMicroUsd?: number;
    nowMs?: () => number;
    allowRecurringModelBriefs?: boolean;
    localCeilings?: LocalBudgetCeilings;
    realGlobalBudget?: GlobalBudgetAuthority;
  } = {},
) {
  const headDb = new DatabaseSync(':memory:');
  const gbDb = new DatabaseSync(':memory:');
  const headStorage = createSqliteStorage(headDb);
  const gbStorage = createSqliteStorage(gbDb);
  const globalBudget = new GlobalBudgetAuthorityCore(
    gbStorage,
    options.globalCeilingMicroUsd ?? 100_000,
    options.nowMs,
  );
  const registry: RecoveryRegistryPort = {
    upsertCoverage: vi.fn((cmd: Parameters<RecoveryRegistryPort['upsertCoverage']>[0]) =>
      Promise.resolve({
        accepted: true,
        currentGeneration: cmd.generation,
        actualRecoveryAtMs: cmd.recoveryAtMs,
      }),
    ),
    postponeCoverage: vi.fn((cmd: Parameters<RecoveryRegistryPort['postponeCoverage']>[0]) =>
      Promise.resolve({
        updated: true,
        currentGeneration: cmd.newGeneration,
        actualRecoveryAtMs: cmd.nextRecoveryAtMs,
      }),
    ),
    retireCoverage: vi.fn(() => Promise.resolve({ retired: true })),
    getCoverage: vi.fn(() =>
      Promise.resolve({
        exists: false,
        currentGeneration: null,
        actualRecoveryAtMs: null,
        status: null,
        retryNotBeforeMs: null,
      }),
    ),
  };

  const sentMessages: V2DispatchEnvelope[] = [];
  const queue: QueueLike<V2DispatchEnvelope> = {
    send: (msg) => {
      sentMessages.push(msg);
      return Promise.resolve();
    },
  };

  let events!: AgentEventRuntimeFacade;
  const core = new AgentHeadCore({
    storage: headStorage,
    tenantId: TENANT_A,
    agentId: AGENT_A,
    recoveryRegistry: registry,
    globalBudget,
    ...(options.realGlobalBudget === undefined
      ? {}
      : { realGlobalBudget: options.realGlobalBudget }),
    globalDailyCeilingMicroUsd: options.globalCeilingMicroUsd ?? 100_000,
    ...(options.localCeilings === undefined ? {} : { localCeilings: options.localCeilings }),
    ...(options.allowRecurringModelBriefs === undefined
      ? {}
      : { allowRecurringModelBriefs: options.allowRecurringModelBriefs }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    eventRuntimeFactory(business) {
      events = new AgentEventRuntimeFacade({
        storage: headStorage,
        tenantId: TENANT_A,
        agentId: AGENT_A,
        business,
      });
      return {
        recoveryAdmission: events.coverage,
        eventCoordinator: events.outbox,
        recoveryHooks: events.asTurnRecoveryHooks({
          globalBudget: {
            settleGlobal: (req) => {
              const { openIncidentReason, ...rest } = req;
              return globalBudget.settleGlobal({
                ...rest,
                ...(openIncidentReason === null ? {} : { openIncidentReason }),
              });
            },
          },
        }),
      };
    },
  });
  core.bootstrapHead({ conversationId: CONVERSATION_A });

  return {
    headDb,
    gbDb,
    core,
    events,
    registry,
    globalBudget,
    sentMessages,
    queue,
  };
}

function baseRealEnv(overrides: Partial<V2ModelRuntimeEnv> = {}): V2ModelRuntimeEnv {
  return {
    EMBER_ENV: 'v2-staging',
    EMBER_V2_STAGING_ISOLATED: 'true',
    EMBER_MODEL_MODE: 'real',
    EMBER_MODEL_PROVIDER: 'openrouter',
    EMBER_MODEL_ID: APPROVED_OPENROUTER_MODEL,
    EMBER_MODEL_API_KEY: 'sk-or-v1-valid-staging-canary-key-1234567890',
    EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
    EMBER_MODEL_ALPHA_TENANT_IDS: TENANT_A,
    ...overrides,
  };
}

describe('V2 real model runtime & sandbox capability decoupling', () => {
  it('decouples EMBER_SANDBOX_MODE from EMBER_MODEL_MODE and fails closed by default', () => {
    expect(resolveV2SandboxConfig({ EMBER_ENV: 'local' })).toEqual({
      kind: 'disabled',
      reason: 'sandbox_mode_unset',
    });
    expect(resolveV2SandboxConfig({ EMBER_ENV: 'local', EMBER_SANDBOX_MODE: 'disabled' })).toEqual({
      kind: 'disabled',
      reason: 'sandbox_disabled',
    });
    expect(resolveV2SandboxConfig({ EMBER_ENV: 'local', EMBER_SANDBOX_MODE: 'fake' })).toEqual({
      kind: 'fake',
    });
    expect(
      resolveV2SandboxConfig({
        EMBER_ENV: 'v2-staging',
        EMBER_V2_STAGING_ISOLATED: 'true',
        EMBER_SANDBOX_MODE: 'fake',
      }),
    ).toEqual({ kind: 'fake' });
    expect(
      resolveV2SandboxConfig({ EMBER_ENV: 'v2-staging', EMBER_SANDBOX_MODE: 'daytona' }),
    ).toEqual({
      kind: 'disabled',
      reason: 'daytona_api_key_missing',
    });
    expect(resolveV2SandboxConfig({ EMBER_ENV: 'local', EMBER_SANDBOX_MODE: 'invalid' })).toEqual({
      kind: 'disabled',
      reason: 'sandbox_mode_invalid',
    });
  });

  it('refuses real mode when allowlist, broad scope, credential, model, or isolated environment is invalid', () => {
    expect(() => resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_API_KEY: undefined }))).toThrow(
      /credential/,
    );
    expect(() =>
      resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: undefined })),
    ).toThrow(/EMBER_MODEL_ALPHA_TENANT_IDS/);
    expect(() =>
      resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: ' , ' })),
    ).toThrow(/EMBER_MODEL_ALPHA_TENANT_IDS/);
    expect(() =>
      resolveV2ModelRuntime(
        baseRealEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: `${TENANT_A},not-a-uuid` }),
      ),
    ).toThrow(/EMBER_MODEL_ALPHA_TENANT_IDS/);
    expect(() =>
      resolveV2ModelRuntime(
        baseRealEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: `${TENANT_A},${TENANT_B}` }),
      ),
    ).toThrow(/at most 1 tenant/);
    expect(() =>
      resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ALPHA_SCOPE: 'authenticated_tenants' })),
    ).toThrow(/EMBER_MODEL_ALPHA_SCOPE=allowlist is required/);
    expect(() => resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ALPHA_SCOPE: 'all' }))).toThrow(
      /EMBER_MODEL_ALPHA_SCOPE=allowlist is required/,
    );
    expect(() =>
      resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ALPHA_SCOPE: undefined })),
    ).toThrow(/EMBER_MODEL_ALPHA_SCOPE=allowlist is required/);
    expect(() => resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ALPHA_SCOPE: '   ' }))).toThrow(
      /EMBER_MODEL_ALPHA_SCOPE=allowlist is required/,
    );
    expect(() =>
      resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ID: 'openai/gpt-4o-mini' })),
    ).toThrow(/model_not_approved/);
    expect(() => resolveV2ModelRuntime(baseRealEnv({ EMBER_ENV: 'production' }))).toThrow(
      /isolated v2-staging/,
    );
    expect(() => resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_MODE: 'disabled' }))).toThrow(
      /refused/,
    );
  });

  it('computes real reservation, enforces tenant allowlist, and parses local/global ceilings', () => {
    const env = baseRealEnv({
      EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD: '2500',
      EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: '50000',
      EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: '50000',
      EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '100000',
      GLOBAL_DAILY_CEILING_MICRO_USD: '100000',
      EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: '20',
    });
    const fetchImpl: FetchLike = () => Promise.reject(new Error('not called'));
    const runtime = resolveV2ModelRuntime(env, { fetchImpl });

    expect(runtime.mode).toBe('real');
    expect(runtime.sandboxConfig).toEqual({ kind: 'disabled', reason: 'sandbox_mode_unset' });
    expect(runtime.providerId).toBe('openrouter');
    expect(runtime.modelLabel).toBe(APPROVED_OPENROUTER_MODEL);
    expect(runtime.simulated).toBe(false);
    expect(runtime.isTenantAuthorized(TENANT_A)).toBe(true);
    expect(runtime.isTenantAuthorized(TENANT_B)).toBe(false);
    expect(runtime.getTurnReservation()).toEqual({
      budgetMode: 'real',
      providerId: 'openrouter',
      modelLabel: APPROVED_OPENROUTER_MODEL,
      rateVersion: 'openrouter-deepseek-v4.1-flash-1017-deepinfra-fp8-2026-11-17',
      maxAttempts: 1,
      estimatedMicroUsd: 935,
    });
    expect(resolveV2LocalCeilings(env)).toEqual({
      perAttemptMicroUsd: 2500,
      principalDailyMicroUsd: 50000,
      tenantDailyMicroUsd: 50000,
      principalDailyTurns: 20,
    });
    expect(resolveV2GlobalCeilingOverride(env)).toBe(100_000);
    expect(() =>
      resolveV2GlobalCeilingOverride({
        EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '100000',
      }),
    ).toThrow(/GLOBAL_DAILY_CEILING_MICRO_USD/);
  });

  it('blocks un-allowlisted tenants on edge submit before reserving budget or calling provider', async () => {
    const fetchCalls: string[] = [];
    const fetchImpl: FetchLike = (url) => {
      fetchCalls.push(url);
      return Promise.reject(new Error('must not be called'));
    };
    const runtime = resolveV2ModelRuntime(baseRealEnv(), { fetchImpl });
    const prepareTurn = vi.fn();

    const sessions: B1SessionRuntime = {
      service: {
        createSession: vi.fn(),
        refreshSession: vi.fn(),
        logout: vi.fn(),
        resolveActiveSession: vi.fn().mockResolvedValue({
          session: {
            sessionId: randomUUID(),
            consumerId: randomUUID(),
            tenantId: TENANT_B,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            revokedAt: null,
          },
          auth: {
            tenantId: TENANT_B,
            principalId: PRINCIPAL_A,
            policyVersion: 1,
          },
        }),
      },
      appleVerifier: { provider: 'apple', verify: () => Promise.resolve(null) },
      devVerifier: { provider: 'dev', verify: () => Promise.resolve(null) },
      devProvider: { evaluate: () => ({ enabled: false, deniedBy: [] }) },
      me: { getMeForTenant: () => Promise.resolve(null) },
    };

    const gatedWorker = createLocalV2EdgeWorker({
      sessions,
      allowedHosts: ['ember-v2-staging.slowfast.dev'],
      resolveAgentHead: () =>
        Promise.resolve({
          agentId: AGENT_A,
          conversationId: CONVERSATION_A,
          rpc: { prepareTurn } as never,
        }),
      stream: {
        gateway: runtime.gateway,
        expectedSimulated: runtime.simulated,
        preflightRate: runtime.rate,
        authorizeModelTurn: (auth) => {
          if (!runtime.isTenantAuthorized(auth.tenantId)) {
            throw new DomainError('POLICY_DENIED', 'tenant not allowlisted');
          }
        },
        resolveModelReservation: () => runtime.getTurnReservation(),
        reportObservedUsage: vi.fn(),
      },
    });

    const res = await gatedWorker.fetch(
      new Request(
        `https://ember-v2-staging.slowfast.dev/v2/conversations/${CONVERSATION_A}/messages/stream`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ems_${'a'.repeat(43)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            client_submission_id: randomUUID(),
            text: 'Hello',
            transcript_epoch: 0,
          }),
        },
      ),
    );

    expect(res.status).toBe(403);
    expect(prepareTurn).not.toHaveBeenCalled();
    expect(fetchCalls).toEqual([]);
  });

  it('executes interactive fast path with real OpenRouter gateway, settles observed cost, and commits simulated=false', async () => {
    const h = createInMemoryHarness();
    const runtime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: (url, init) => {
        expect(url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
        const body = JSON.parse(init.body) as Record<string, unknown>;
        expect(body['model']).toBe(APPROVED_OPENROUTER_MODEL);
        expect(body['stream']).toBe(false);
        expect(body['provider']).toMatchObject({
          only: ['deepinfra'],
          allow_fallbacks: false,
          data_collection: 'deny',
          zdr: true,
          require_parameters: true,
        });
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () =>
            Promise.resolve({
              model: APPROVED_OPENROUTER_MODEL,
              choices: [
                {
                  message: { role: 'assistant', content: 'Real OpenRouter answer.' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.000016 },
            }),
        });
      },
    });

    const prepared = await h.core.prepareTurn({
      scope: {
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: CONVERSATION_A,
      request: {
        client_submission_id: randomUUID(),
        text: 'Say hello from real model',
        transcript_epoch: 0,
      },
      workerId: 'worker-fast-1',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      modelReservation: runtime.getTurnReservation(),
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;

    const events: string[] = [];
    await executeInteractive({
      rpc: h.core,
      gateway: runtime.gateway,
      reportObservedUsage: (req) => h.core.turnService.recordTurnUsage(req),
      expectedSimulated: runtime.simulated,
      preflightRate: runtime.rate,
      prepared,
      scope: { tenantId: TENANT_A, agentId: AGENT_A },
      conversationId: CONVERSATION_A,
      workerId: 'worker-fast-1',
      signal: new AbortController().signal,
      emit: (event) => {
        events.push(event);
      },
    });

    expect(events).toEqual(['turn.delta', 'turn.committed']);
    const page = await h.core.readMessages({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
      after: 0,
      limit: 10,
    });
    expect(page.messages).toHaveLength(2);
    expect(page.messages[1]).toMatchObject({
      kind: 'ember',
      text: 'Real OpenRouter answer.',
      model_label: APPROVED_OPENROUTER_MODEL,
      simulated: false,
    });

    const attempt = h.headDb
      .prepare(
        'SELECT state, budget_mode, provider_id, model_label, observed_cost_micro_usd FROM model_attempts WHERE subject_id = ?',
      )
      .get(prepared.turnId) as Record<string, unknown>;
    expect(attempt).toEqual({
      state: 'settled',
      budget_mode: 'real',
      provider_id: 'openrouter',
      model_label: APPROVED_OPENROUTER_MODEL,
      observed_cost_micro_usd: 16,
    });
  });

  it('retains conservative unknown_billed and never retries on real provider 5xx/timeout', async () => {
    const h = createInMemoryHarness();
    let calls = 0;
    const runtime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve({
          status: 503,
          ok: false,
          json: () => Promise.resolve({ error: 'upstream down' }),
        });
      },
    });

    const prepared = await h.core.prepareTurn({
      scope: {
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: CONVERSATION_A,
      request: {
        client_submission_id: randomUUID(),
        text: 'Trigger upstream 503',
        transcript_epoch: 0,
      },
      workerId: 'worker-fast-2',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      modelReservation: runtime.getTurnReservation(),
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');

    await executeInteractive({
      rpc: h.core,
      gateway: runtime.gateway,
      reportObservedUsage: (req) => h.core.turnService.recordTurnUsage(req),
      expectedSimulated: runtime.simulated,
      preflightRate: runtime.rate,
      prepared,
      scope: { tenantId: TENANT_A, agentId: AGENT_A },
      conversationId: CONVERSATION_A,
      workerId: 'worker-fast-2',
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    expect(calls).toBe(1);
    const attempt = h.headDb
      .prepare(
        'SELECT state, outcome_code, reserved_micro_usd, applied_cost_micro_usd FROM model_attempts WHERE subject_id = ?',
      )
      .get(prepared.turnId) as Record<string, unknown>;
    expect(attempt).toEqual({
      state: 'unknown_billed',
      outcome_code: 'model_unavailable',
      reserved_micro_usd: 935,
      applied_cost_micro_usd: 935,
    });
    const turn = await h.core.getTurn({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
      turnId: prepared.turnId,
    });
    expect(turn?.status).toBe('failed');
  });

  it('executes durable turn via real gateway and does not yield a resumable job handle on failure', async () => {
    const h = createInMemoryHarness();
    let calls = 0;
    const gateway = adaptModelGatewayForV2(
      new OpenRouterModelGateway({
        apiKey: 'sk-or-v1-valid-staging-canary-key-1234567890',
        modelId: APPROVED_OPENROUTER_MODEL,
        rate: resolveV2ModelRuntime(baseRealEnv(), {
          fetchImpl: () => Promise.reject(new Error('unused')),
        }).rate!,
        routing: {
          only: ['deepinfra'],
          allowFallbacks: false,
          dataCollection: 'deny',
          zdr: true,
          requireParameters: true,
        },
        isAuthorized: () => true,
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve({
            status: 200,
            ok: true,
            json: () =>
              Promise.resolve({
                model: APPROVED_OPENROUTER_MODEL,
                choices: [
                  {
                    message: { role: 'assistant', content: 'Durable real reply.' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 50, completion_tokens: 10 },
              }),
          });
        },
      }),
      20_000,
    );

    const runtime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: () => Promise.reject(new Error('unused')),
    });
    const prepared = await h.core.prepareTurn({
      scope: {
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: CONVERSATION_A,
      request: {
        client_submission_id: randomUUID(),
        text: 'Durable real turn',
        transcript_epoch: 0,
      },
      workerId: 'worker-durable-1',
      leaseMs: 25_000,
      interactiveDeadlineMs: 22_000,
      turnDeadlineMs: 60_000,
      executionMode: 'durable_queue',
      modelReservation: runtime.getTurnReservation(),
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');

    const env = {
      ...baseRealEnv(),
      AGENT_HEAD: {
        getByName: () => ({
          markAttemptSent: (req: Parameters<AgentHeadCore['markAttemptSent']>[0]) =>
            h.core.markAttemptSent(req),
          reserveTaskModelAttempt: (req: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) =>
            h.core.reserveTaskModelAttempt(req),
          taskArtifacts: (req: Parameters<AgentHeadCore['taskArtifacts']>[0]) =>
            h.core.taskArtifacts(req),
          edgeRpc: vi.fn(),
        }),
      },
      D1_RECOVERY: {} as D1DatabaseLike,
      DURABLE_TURN_QUEUE: h.queue,
      AGENT_TASK_QUEUE: h.queue,
      GLOBAL_BUDGET: { getByName: () => h.globalBudget },
    } as unknown as Parameters<typeof createDurableExecutor>[0];

    const claim = await h.core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `turn:${prepared.turnId}:epoch:1`,
        tenantId: TENANT_A,
        agentId: AGENT_A,
        entityKind: 'turn',
        entityId: prepared.turnId,
        queueName: 'durable_turn',
        fenceEpoch: 1,
      },
      workerId: 'worker-durable-1',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    const executor = createDurableExecutor(env, gateway, {
      modelRuntime: { ...runtime, gateway },
    });
    const outcome = await executor.executeDurableWork({
      ...claim,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-durable-1',
    });
    const committed = await h.core.commitDurableResult({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      entityType: 'turn',
      entityId: prepared.turnId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-durable-1',
      outcome,
    });

    expect(calls).toBe(1);
    expect(committed.accepted).toBe(true);
    const page = await h.core.readMessages({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
      after: 0,
      limit: 10,
    });
    expect(page.messages[1]).toMatchObject({
      text: 'Durable real reply.',
      model_label: APPROVED_OPENROUTER_MODEL,
      simulated: false,
    });
  });

  it('blocks a fresh durable turn send if the tenant is revoked between enqueue and execution without altering sent recovery', async () => {
    const h = createInMemoryHarness();
    let providerCalls = 0;
    const revokedRuntime = resolveV2ModelRuntime(
      baseRealEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: TENANT_B }),
      {
        fetchImpl: () => {
          providerCalls += 1;
          return Promise.reject(new Error('must not be called after tenant revocation'));
        },
      },
    );
    const markAttemptSent = vi.fn((req: Parameters<AgentHeadCore['markAttemptSent']>[0]) =>
      h.core.markAttemptSent(req),
    );
    const env = {
      ...baseRealEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: TENANT_B }),
      AGENT_HEAD: {
        getByName: () => ({
          markAttemptSent,
          reserveTaskModelAttempt: (req: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) =>
            h.core.reserveTaskModelAttempt(req),
          taskArtifacts: (req: Parameters<AgentHeadCore['taskArtifacts']>[0]) =>
            h.core.taskArtifacts(req),
          edgeRpc: vi.fn(),
        }),
      },
      D1_RECOVERY: {} as D1DatabaseLike,
      DURABLE_TURN_QUEUE: h.queue,
      AGENT_TASK_QUEUE: h.queue,
      GLOBAL_BUDGET: { getByName: () => h.globalBudget },
    } as unknown as Parameters<typeof createDurableExecutor>[0];

    const prepared = await h.core.prepareTurn({
      scope: {
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: CONVERSATION_A,
      executionMode: 'durable_queue',
      request: {
        client_submission_id: randomUUID(),
        text: 'Queued while allowlisted, executed after revocation',
        transcript_epoch: 0,
      },
      workerId: 'edge-1',
      leaseMs: 30_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      modelReservation: revokedRuntime.getTurnReservation(),
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');

    const claim = await h.core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `turn:${prepared.turnId}:epoch:1`,
        tenantId: TENANT_A,
        agentId: AGENT_A,
        entityKind: 'turn',
        entityId: prepared.turnId,
        queueName: 'durable_turn',
        fenceEpoch: 1,
      },
      workerId: 'worker-revoked-1',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    const executor = createDurableExecutor(env, revokedRuntime.gateway, {
      modelRuntime: revokedRuntime,
    });
    const outcome = await executor.executeDurableWork({
      ...claim,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-revoked-1',
    });

    expect(providerCalls).toBe(0);
    expect(markAttemptSent).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      attemptNo: 1,
      operationId: prepared.operationId,
      settlement: { state: 'released', outcomeCode: 'not_sent' },
      status: 'failed',
      failureReason: 'internal_error',
    });

    const committed = await h.core.commitDurableResult({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      entityType: 'turn',
      entityId: prepared.turnId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-revoked-1',
      outcome,
    });
    expect(committed.accepted).toBe(true);

    // Already-sent claims must preserve conservative unknown_billed rather than returning not_sent.
    const sentClaimContext = JSON.parse(claim.contextJson) as Record<string, unknown>;
    sentClaimContext['sendState'] = 'sent';
    sentClaimContext['sendStartedAtMs'] = Date.now();
    const sentOutcome = await executor.executeDurableWork({
      ...claim,
      contextJson: JSON.stringify(sentClaimContext),
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-revoked-1',
    });
    expect(sentOutcome).toMatchObject({
      attemptNo: 1,
      operationId: prepared.operationId,
      settlement: { state: 'unknown_billed' },
      status: 'failed',
    });
  });

  it('exposes real stepPythonAgent from OpenRouterModelGateway without fake fallback', async () => {
    const fetchCalls: string[] = [];
    const runtime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: (url, init) => {
        fetchCalls.push(url);
        const body = JSON.parse(init.body) as Record<string, unknown>;
        expect(body['model']).toBe(APPROVED_OPENROUTER_MODEL);
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () =>
            Promise.resolve({
              model: APPROVED_OPENROUTER_MODEL,
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_py_1',
                        type: 'function',
                        function: {
                          name: 'run_python_script',
                          arguments: JSON.stringify({
                            code: 'print(400)',
                            purpose: 'Summarize sales.csv',
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 150, completion_tokens: 30, cost: 0.000024 },
            }),
        });
      },
    });

    expect(runtime.gateway.providerId).toBe('openrouter');
    expect(runtime.gateway.modelLabel).toBe(APPROVED_OPENROUTER_MODEL);
    expect(runtime.gateway.simulated).toBe(false);
    expect(typeof runtime.gateway.stepPythonAgent).toBe('function');

    const stepResult = await runtime.gateway.stepPythonAgent!(
      {
        taskId: randomUUID(),
        prompt: 'Analyze sales.csv',
        inputFiles: [
          { artifactId: randomUUID(), filename: 'sales.csv', mediaType: 'text/csv', sizeBytes: 42 },
        ],
        messages: [],
        maxOutputTokens: 1_536,
        remainingPythonCalls: 2,
      },
      new AbortController().signal,
    );
    expect(fetchCalls).toEqual([OPENROUTER_CHAT_COMPLETIONS_URL]);
    expect(stepResult.simulated).toBe(false);
    expect(stepResult.modelLabel).toBe(APPROVED_OPENROUTER_MODEL);
    expect(stepResult.output).toMatchObject({
      kind: 'tool_call',
      toolCallId: 'call_py_1',
      code: 'print(400)',
      purpose: 'Summarize sales.csv',
    });
  });

  it('fails closed for python.agent when EMBER_MODEL_MODE=real and EMBER_SANDBOX_MODE is unset', async () => {
    const h = createInMemoryHarness();
    const runtime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: () => Promise.reject(new Error('not called')),
    });
    const env = {
      ...baseRealEnv(),
      AGENT_HEAD: {
        getByName: () => ({
          markAttemptSent: (req: Parameters<AgentHeadCore['markAttemptSent']>[0]) =>
            h.core.markAttemptSent(req),
          reserveTaskModelAttempt: (req: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) =>
            h.core.reserveTaskModelAttempt(req),
          taskArtifacts: (req: Parameters<AgentHeadCore['taskArtifacts']>[0]) =>
            h.core.taskArtifacts(req),
          edgeRpc: vi.fn(),
        }),
      },
      D1_RECOVERY: {} as D1DatabaseLike,
      DURABLE_TURN_QUEUE: h.queue,
      AGENT_TASK_QUEUE: h.queue,
      GLOBAL_BUDGET: { getByName: () => h.globalBudget },
    } as unknown as Parameters<typeof createDurableExecutor>[0];

    const submitted = await h.core.taskArtifacts({
      kind: 'submit_python_task',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      input: { prompt: 'Run python' },
    });
    const taskId = (submitted as { task: { task_id: string } }).task.task_id;
    const claim = await h.core.claimDurableWork({
      envelope: {
        schemaVersion: 2,
        eventId: `task:${taskId}:epoch:0`,
        tenantId: TENANT_A,
        agentId: AGENT_A,
        entityKind: 'task',
        entityId: taskId,
        queueName: 'agent_task',
        fenceEpoch: 0,
      },
      workerId: 'worker-py-1',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    const executor = createDurableExecutor(env, runtime.gateway, { modelRuntime: runtime });
    const outcome = await executor.executeDurableWork({
      ...claim,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-py-1',
    });
    expect(outcome).toEqual({
      status: 'failed',
      reasonCode: 'sandbox_mode_unset',
    });
  });

  it('upgrades existing v6 AgentHeadDO storage (with personal_memories) cleanly to v8', () => {
    const db = new DatabaseSync(':memory:');
    const storage = createSqliteStorage(db);
    const allMigrations = createDefaultAgentHeadMigrations();
    const v1To6 = allMigrations.filter((m) => m.version <= 6);

    const first = applyAgentHeadMigrations(storage, v1To6, 1_000);
    expect(first.appliedVersions).toEqual([1, 2, 3, 4, 5, 6]);

    db.prepare(
      `INSERT INTO agent_head_meta (id, tenant_id, agent_id, policy_version, home_region, created_at_ms, updated_at_ms)
       VALUES (1, ?, ?, 1, NULL, 1000, 1000)`,
    ).run(TENANT_A, AGENT_A);
    db.prepare(
      `INSERT INTO personal_memories (id, tenant_id, principal_id, kind, memory_key, client_request_id, content, provenance_source, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'preference', 'tone', NULL, 'Concise answers', 'user_settings', 1000, 1000)`,
    ).run(randomUUID(), TENANT_A, PRINCIPAL_A);

    const v1To8 = allMigrations.filter((m) => m.version <= 8);
    const upgraded = applyAgentHeadMigrations(storage, v1To8, 2_000);
    expect(upgraded.appliedVersions).toEqual([7, 8]);
    expect(upgraded.alreadyAppliedVersions).toEqual([1, 2, 3, 4, 5, 6]);
    expect(db.prepare('SELECT content FROM personal_memories').all()).toEqual([
      { content: 'Concise answers' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('executes proactive model_brief in real mode with memory/context and without delegation tools', async () => {
    let nowMs = Date.now();
    const h = createInMemoryHarness({ nowMs: () => nowMs });
    const fetchBodies: Array<Record<string, unknown>> = [];
    const runtime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: (url, init) => {
        expect(url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
        fetchBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () =>
            Promise.resolve({
              model: APPROVED_OPENROUTER_MODEL,
              choices: [
                {
                  message: { role: 'assistant', content: 'Kyoto espresso weather check: 14C.' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 95, completion_tokens: 18 },
            }),
        });
      },
    });
    expect(runtime.estimateBriefReservation('Morning check')).toBeLessThan(
      runtime.getTurnReservation().estimatedMicroUsd,
    );

    const headProxy = {
      markAttemptSent: (req: Parameters<AgentHeadCore['markAttemptSent']>[0]) =>
        h.core.markAttemptSent(req),
      reserveTaskModelAttempt: (req: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) =>
        h.core.reserveTaskModelAttempt(req),
      taskArtifacts: (req: Parameters<AgentHeadCore['taskArtifacts']>[0]) =>
        h.core.taskArtifacts(req),
      edgeRpc: async (method: string, req: unknown) => {
        if (method === 'readMessages') {
          return { value: await h.core.readMessages(req as never) };
        }
        if (method === 'proactiveSchedule') {
          return { value: await h.core.proactiveSchedule(req as never) };
        }
        if (method === 'personalMemory') {
          return { value: await h.core.personalMemory(req as never) };
        }
        throw new Error(`Unexpected edgeRpc method: ${method}`);
      },
    };
    const env = {
      ...baseRealEnv(),
      AGENT_HEAD: { getByName: () => headProxy },
      D1_RECOVERY: {} as D1DatabaseLike,
      DURABLE_TURN_QUEUE: h.queue,
      AGENT_TASK_QUEUE: h.queue,
      GLOBAL_BUDGET: { getByName: () => h.globalBudget },
    } as unknown as Parameters<typeof createDurableExecutor>[0];

    await h.core.personalMemory({
      kind: 'save',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      input: {
        kind: 'preference',
        key: 'coffee_city',
        content: 'Prefer Kyoto pour-over updates',
        provenance: { source: 'user_settings' },
      },
    });
    const prepared = await h.core.prepareTurn({
      scope: {
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: CONVERSATION_A,
      executionMode: 'fast_interactive',
      request: {
        client_submission_id: randomUUID(),
        text: 'Watch morning roast availability tomorrow.',
        transcript_epoch: 0,
      },
      workerId: 'edge-ctx-1',
      leaseMs: 30_000,
      interactiveDeadlineMs: 20_000,
      turnDeadlineMs: 60_000,
      modelReservation: runtime.getTurnReservation(),
    });
    if (prepared.kind !== 'prepared') throw new Error('expected prepared');
    await h.core.commitTurn({
      scope: {
        tenantId: TENANT_A,
        agentId: AGENT_A,
      },
      conversationId: CONVERSATION_A,
      turnId: prepared.turnId,
      attemptNo: 1,
      operationId: prepared.operationId,
      leaseEpoch: 1,
      leaseOwner: 'edge-ctx-1',
      settlement: { state: 'released', outcomeCode: 'not_sent' },
      result: {
        status: 'completed',
        text: 'Got it, tracking roast updates.',
        modelLabel: runtime.modelLabel,
        simulated: false,
      },
    });

    const fireAtMs = nowMs + 60_000;
    const created = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'real-brief-1',
        kind: 'follow_up',
        title: 'Morning Coffee Brief',
        prompt: 'Check Kyoto roast notes and summarize.',
        trigger: { type: 'once', fireAt: new Date(fireAtMs).toISOString() },
        timezone: 'UTC',
        deliveryMode: 'model_brief',
      },
    })) as ProactiveScheduleSnapshot;

    nowMs = fireAtMs + 1_000;
    await h.events.handleAlarm({
      nowMs,
      queues: { durable_turn: h.queue, agent_task: h.queue },
      globalBudget: h.core.createGlobalBudgetSettlePort(),
      registry: h.registry,
    });
    const taskEnvelope = h.sentMessages.find((msg) => msg.entityKind === 'task');
    expect(taskEnvelope).toBeDefined();
    if (taskEnvelope === undefined) return;

    const claim = await h.core.claimDurableWork({
      envelope: taskEnvelope,
      workerId: 'worker-brief-real',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    const executor = createDurableExecutor(env, runtime.gateway, { modelRuntime: runtime });
    const outcome = await executor.executeDurableWork({
      ...claim,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-brief-real',
    });
    const committed = await h.core.commitDurableResult({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      entityType: 'task',
      entityId: taskEnvelope.entityId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-brief-real',
      outcome,
    });

    expect(committed.accepted).toBe(true);
    expect(fetchBodies).toHaveLength(1);
    const wireBody = fetchBodies[0]!;
    expect(wireBody['tools']).toBeUndefined();
    expect(wireBody['tool_choice']).toBeUndefined();
    const wireMessages = wireBody['messages'] as Array<{ role: string; content: string }>;
    expect(wireMessages[0]).toEqual({ role: 'system', content: SCHEDULED_BRIEF_SYSTEM_PROMPT });
    const promptMessage = wireMessages.at(-1)?.content ?? '';
    expect(promptMessage).toContain('Prefer Kyoto pour-over updates');
    expect(promptMessage).toContain('Watch morning roast availability tomorrow.');
    expect(promptMessage).toContain('Check Kyoto roast notes and summarize.');

    const msgs = await h.core.readMessages({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
      after: 0,
      limit: 10,
    });
    expect(msgs.messages.at(-1)).toMatchObject({
      kind: 'ember',
      text: '**Morning Coffee Brief**\n\nKyoto espresso weather check: 14C.',
      model_label: APPROVED_OPENROUTER_MODEL,
      simulated: false,
    });

    const schedules = (await h.core.proactiveSchedule({
      kind: 'list',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
    })) as { schedules: ProactiveScheduleSnapshot[] };
    const updatedSchedule = schedules.schedules.find((s) => s.scheduleId === created.scheduleId);
    expect(updatedSchedule?.latestRun?.status).toBe('completed');
    expect(updatedSchedule?.latestRun?.reasonCode).toBe('ok');
  });

  it('blocks recovered unsent proactive model_brief after tenant revocation while preserving sent recovery', async () => {
    let nowMs = Date.now();
    const h = createInMemoryHarness({ nowMs: () => nowMs });
    let providerCalls = 0;
    const revokedRuntime = resolveV2ModelRuntime(
      baseRealEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: TENANT_B }),
      {
        fetchImpl: () => {
          providerCalls += 1;
          return Promise.reject(new Error('must not be called after tenant revocation'));
        },
      },
    );
    const markAttemptSent = vi.fn((req: Parameters<AgentHeadCore['markAttemptSent']>[0]) =>
      h.core.markAttemptSent(req),
    );
    const headProxy = {
      markAttemptSent,
      reserveTaskModelAttempt: (req: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) =>
        h.core.reserveTaskModelAttempt(req),
      taskArtifacts: (req: Parameters<AgentHeadCore['taskArtifacts']>[0]) =>
        h.core.taskArtifacts(req),
      edgeRpc: async (method: string, req: unknown) => {
        if (method === 'readMessages') return { value: await h.core.readMessages(req as never) };
        if (method === 'proactiveSchedule') {
          return { value: await h.core.proactiveSchedule(req as never) };
        }
        if (method === 'personalMemory') {
          return { value: await h.core.personalMemory(req as never) };
        }
        throw new Error(`Unexpected edgeRpc method: ${method}`);
      },
    };
    const env = {
      ...baseRealEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: TENANT_B }),
      AGENT_HEAD: { getByName: () => headProxy },
      D1_RECOVERY: {} as D1DatabaseLike,
      DURABLE_TURN_QUEUE: h.queue,
      AGENT_TASK_QUEUE: h.queue,
      GLOBAL_BUDGET: { getByName: () => h.globalBudget },
    } as unknown as Parameters<typeof createDurableExecutor>[0];

    const fireAtMs = nowMs + 60_000;
    await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'real-brief-revoked',
        kind: 'follow_up',
        title: 'Revoked Canary Brief',
        prompt: 'Check status updates.',
        trigger: { type: 'once', fireAt: new Date(fireAtMs).toISOString() },
        timezone: 'UTC',
        deliveryMode: 'model_brief',
      },
    });

    nowMs = fireAtMs + 1_000;
    await h.events.handleAlarm({
      nowMs,
      queues: { durable_turn: h.queue, agent_task: h.queue },
      globalBudget: h.core.createGlobalBudgetSettlePort(),
      registry: h.registry,
    });
    const taskEnvelope = h.sentMessages.find((msg) => msg.entityKind === 'task')!;
    const claim = await h.core.claimDurableWork({
      envelope: taskEnvelope,
      workerId: 'worker-brief-revoked',
      leaseMs: 30_000,
    });
    if (claim.kind !== 'claimed') throw new Error('expected claimed');
    const rawClaim = JSON.parse(claim.contextJson) as Record<string, unknown>;
    const reserved = await h.core.reserveTaskModelAttempt({
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      taskId: taskEnvelope.entityId,
      runId: rawClaim['runId'] as string,
      leaseEpoch: claim.leaseEpoch,
      budgetMode: 'real',
      providerId: 'openrouter',
      modelLabel: APPROVED_OPENROUTER_MODEL,
      rateVersion: revokedRuntime.rateVersion,
      estimatedMicroUsd: revokedRuntime.estimateBriefReservation('Check status updates.'),
    });
    if (reserved.kind !== 'reserved') throw new Error('expected reserved');

    const unsentRecoveredContext = {
      ...rawClaim,
      attemptId: String(reserved.attemptNo),
      attemptNo: reserved.attemptNo,
      operationId: reserved.operationId,
      sendState: 'unsent',
      sendAuthorizingAtMs: null,
      sendStartedAtMs: null,
      providerJobHandle: null,
    };

    const executor = createDurableExecutor(env, revokedRuntime.gateway, {
      modelRuntime: revokedRuntime,
    });
    const unsentOutcome = await executor.executeDurableWork({
      ...claim,
      contextJson: JSON.stringify(unsentRecoveredContext),
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-brief-revoked',
    });
    expect(providerCalls).toBe(0);
    expect(markAttemptSent).not.toHaveBeenCalled();
    expect(unsentOutcome).toMatchObject({
      attemptNo: reserved.attemptNo,
      operationId: reserved.operationId,
      settlement: { state: 'released', outcomeCode: 'not_sent' },
      status: 'failed',
      summaryText: 'Revoked Canary Brief',
      reasonCode: 'model_unauthorized_tenant',
    });

    const committed = await h.core.commitDurableResult({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      entityType: 'task',
      entityId: taskEnvelope.entityId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-brief-revoked',
      outcome: unsentOutcome,
    });
    expect(committed.accepted).toBe(true);

    // Sent recovery still commits conservatively as unknown_billed without blind replay.
    const sentOutcome = await executor.executeDurableWork({
      ...claim,
      contextJson: JSON.stringify({
        ...unsentRecoveredContext,
        sendState: 'sent',
        sendStartedAtMs: nowMs,
      }),
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-brief-revoked',
    });
    expect(sentOutcome).toMatchObject({
      attemptNo: reserved.attemptNo,
      operationId: reserved.operationId,
      settlement: { state: 'unknown_billed' },
      status: 'failed',
    });
  });

  it('delegates CSV attachments to delegate_python_agent in isolated v2-staging fake mode while preserving image/proactive reply behavior', async () => {
    const runtime = resolveV2ModelRuntime({
      EMBER_ENV: 'v2-staging',
      EMBER_V2_STAGING_ISOLATED: 'true',
      EMBER_MODEL_MODE: 'fake',
      EMBER_SANDBOX_MODE: 'fake',
    });
    expect(runtime.mode).toBe('fake');
    expect(runtime.sandboxConfig).toEqual({ kind: 'fake' });
    const fakeGateway = runtime.gateway as unknown as FakeStreamingModelGateway;

    const csvUploadId = randomUUID();
    const delegated = await fakeGateway.generateConversationTurn(
      {
        conversationId: CONVERSATION_A,
        turnId: randomUUID(),
        context: [
          {
            role: 'user',
            text: 'Analyze sales.csv and summarize total revenue.',
            attachments: [
              {
                uploadId: csvUploadId,
                filename: 'sales.csv',
                mediaType: 'text/csv',
                sizeBytes: 34,
              },
            ],
          },
        ],
        maxOutputTokens: 512,
      },
      new AbortController().signal,
    );
    expect(delegated.simulated).toBe(true);
    expect(delegated.output).toMatchObject({
      kind: 'delegate',
      toolName: 'delegate_python_agent',
      delegation: {
        toolName: 'delegate_python_agent',
        arguments: {
          title: 'Analyze sales.csv',
          prompt: 'Analyze sales.csv and summarize total revenue.',
          attachmentIds: [csvUploadId],
        },
      },
    });

    // Image-only attachments and proactive briefs (allowDelegationTools: false) do not delegate.
    const imageTurn = await fakeGateway.generateConversationTurn(
      {
        conversationId: CONVERSATION_A,
        turnId: randomUUID(),
        context: [
          {
            role: 'user',
            text: 'What is in this image?',
            attachments: [
              {
                uploadId: randomUUID(),
                filename: 'photo.jpg',
                mediaType: 'image/jpeg',
                sizeBytes: 1200,
              },
            ],
          },
        ],
        maxOutputTokens: 512,
      },
      new AbortController().signal,
    );
    expect(imageTurn.output.kind).toBe('reply');

    const disabledDelegation = await fakeGateway.generateConversationTurn(
      {
        conversationId: CONVERSATION_A,
        turnId: randomUUID(),
        context: [
          {
            role: 'user',
            text: 'Summarize CSV without delegation tools.',
            attachments: [
              {
                uploadId: csvUploadId,
                filename: 'sales.csv',
                mediaType: 'text/csv',
                sizeBytes: 34,
              },
            ],
          },
        ],
        allowDelegationTools: false,
        maxOutputTokens: 512,
      },
      new AbortController().signal,
    );
    expect(disabledDelegation.output.kind).toBe('reply');

    // BOM-prefixed CSVs exported from Excel/Numbers still summarize numeric columns cleanly.
    const bomSandbox = runV2FakePythonSandbox({
      prompt: 'Analyze sales.csv',
      inputFiles: [
        {
          filename: 'sales.csv',
          mediaType: 'text/csv',
          bytes: new TextEncoder().encode('\uFEFFregion,revenue\nnorth,120\nsouth,80\n'),
        },
      ],
    });
    expect(bomSandbox.outputFiles[0]?.filename).toBe('analysis-summary.csv');
    const summaryCsv = new TextDecoder().decode(bomSandbox.outputFiles[0]!.bytes);
    expect(summaryCsv).toContain('sales.csv,revenue,2,200,80,120,100');
  });

  it('binds both global and global-real DO instances while selecting new-reserve ledger by mode', () => {
    expect(resolveGlobalBudgetObjectName({})).toBe(GLOBAL_BUDGET_OBJECT_NAME);
    expect(resolveGlobalBudgetObjectName({ EMBER_MODEL_MODE: 'fake' })).toBe(
      GLOBAL_BUDGET_OBJECT_NAME,
    );
    expect(resolveGlobalBudgetObjectName({ EMBER_MODEL_MODE: 'real' })).toBe(
      GLOBAL_BUDGET_REAL_OBJECT_NAME,
    );

    const requestedNames: string[] = [];
    const options = createAgentHeadGlobalBudgetOptions({
      EMBER_MODEL_MODE: 'real',
      GLOBAL_DAILY_CEILING_MICRO_USD: '100000',
      GLOBAL_BUDGET: {
        getByName(name: string) {
          requestedNames.push(name);
          return { name } as unknown as GlobalBudgetAuthority;
        },
      },
    });

    expect(requestedNames).toEqual([GLOBAL_BUDGET_OBJECT_NAME, GLOBAL_BUDGET_REAL_OBJECT_NAME]);
    expect((options.globalBudget as unknown as { name: string }).name).toBe(
      GLOBAL_BUDGET_OBJECT_NAME,
    );
    expect((options.realGlobalBudget as unknown as { name: string }).name).toBe(
      GLOBAL_BUDGET_REAL_OBJECT_NAME,
    );
    expect(options.globalDailyCeilingMicroUsd).toBe(100_000);
  });

  it('blocks unauthorized recurring real-model briefs across config, creation/resume/NL tool, and durable execution', async () => {
    expect(resolveV2AllowRecurringBriefs({ EMBER_MODEL_MODE: 'fake' })).toBe(true);
    expect(resolveV2AllowRecurringBriefs({ EMBER_MODEL_MODE: 'real' })).toBe(false);
    expect(
      resolveV2AllowRecurringBriefs({
        EMBER_MODEL_MODE: 'real',
        EMBER_MODEL_ALLOW_RECURRING_BRIEFS: 'false',
      }),
    ).toBe(false);
    expect(
      resolveV2AllowRecurringBriefs({
        EMBER_MODEL_MODE: 'real',
        EMBER_MODEL_ALLOW_RECURRING_BRIEFS: 'true',
      }),
    ).toBe(true);
    expect(() =>
      resolveV2AllowRecurringBriefs({
        EMBER_MODEL_MODE: 'real',
        EMBER_MODEL_ALLOW_RECURRING_BRIEFS: 'yes',
      }),
    ).toThrow(/EMBER_MODEL_ALLOW_RECURRING_BRIEFS/);

    let providerCalls = 0;
    const runtime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: () => {
        providerCalls += 1;
        return Promise.reject(new Error('recurring real-model brief must not call OpenRouter'));
      },
    });
    expect(runtime.allowRecurringBriefs).toBe(false);

    // 1. AgentHeadCore with allowRecurringModelBriefs=false blocks recurring model_brief creation & resume,
    //    while allowing recurring direct_reminder and one-time model_brief.
    let nowMs = Date.now();
    const h = createInMemoryHarness({ nowMs: () => nowMs, allowRecurringModelBriefs: false });

    await expect(
      h.core.proactiveSchedule({
        kind: 'create',
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        requestId: randomUUID(),
        input: {
          idempotencyKey: 'recurring-brief-denied',
          kind: 'brief',
          title: 'Daily Real Brief',
          prompt: 'Summarize morning priorities.',
          trigger: { type: 'interval', intervalSeconds: 300 },
          timezone: 'UTC',
          deliveryMode: 'model_brief',
        },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    const reminder = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'recurring-reminder-allowed',
        kind: 'reminder',
        title: 'Standup Reminder',
        prompt: 'Standup in 5 minutes',
        trigger: { type: 'interval', intervalSeconds: 300 },
        timezone: 'UTC',
        deliveryMode: 'direct_reminder',
      },
    })) as ProactiveScheduleSnapshot;
    expect(reminder.status).toBe('active');

    // NL create_proactive_schedule tool refuses recurring model_brief cleanly without creating a schedule.
    const preparedTurn = await h.core.prepareTurn({
      scope: {
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: CONVERSATION_A,
      executionMode: 'fast_interactive',
      request: {
        client_submission_id: randomUUID(),
        text: 'Send me a brief every hour',
        transcript_epoch: 0,
      },
      workerId: 'edge-nl-1',
      leaseMs: 30_000,
      interactiveDeadlineMs: 20_000,
      turnDeadlineMs: 60_000,
      modelReservation: runtime.getTurnReservation(),
    });
    if (preparedTurn.kind !== 'prepared') throw new Error('expected prepared');
    await h.core.commitTurn({
      scope: { tenantId: TENANT_A, agentId: AGENT_A },
      conversationId: CONVERSATION_A,
      turnId: preparedTurn.turnId,
      attemptNo: 1,
      operationId: preparedTurn.operationId,
      leaseEpoch: 1,
      leaseOwner: 'edge-nl-1',
      settlement: { state: 'released', outcomeCode: 'not_sent' },
      result: {
        status: 'completed',
        text: 'Creating recurring brief.',
        modelLabel: runtime.modelLabel,
        simulated: false,
        proactiveScheduleCreate: {
          kind: 'brief',
          title: 'Hourly AI Brief',
          prompt: 'Give me an hourly brief.',
          triggerType: 'interval',
          intervalSeconds: 3_600,
          deliveryMode: 'model_brief',
        },
      },
    });
    const nlMessages = await h.core.readMessages({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
      after: 0,
      limit: 10,
    });
    expect(nlMessages.messages.at(-1)).toMatchObject({
      kind: 'ember',
      text: PROACTIVE_SCHEDULE_RECURRING_REAL_MODEL_DENIED_REPLY,
    });

    // 2. Simulate an interval model_brief that was created previously in fake mode (allowRecurringModelBriefs=true),
    //    paused, and then evaluated after switching to real mode.
    const legacyHarness = createInMemoryHarness({
      nowMs: () => nowMs,
      allowRecurringModelBriefs: true,
    });
    const preExisting = (await legacyHarness.core.proactiveSchedule({
      kind: 'create',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'fake-mode-recurring-brief',
        kind: 'brief',
        title: 'Pre-existing Fake Recurring Brief',
        prompt: 'Should never call real LLM when recurring is disallowed.',
        trigger: { type: 'interval', intervalSeconds: 300 },
        timezone: 'UTC',
        deliveryMode: 'model_brief',
      },
    })) as ProactiveScheduleSnapshot;

    nowMs += 305_000;
    await legacyHarness.events.handleAlarm({
      nowMs,
      queues: { durable_turn: legacyHarness.queue, agent_task: legacyHarness.queue },
      globalBudget: legacyHarness.core.createGlobalBudgetSettlePort(),
      registry: legacyHarness.registry,
    });
    const taskEnvelope = legacyHarness.sentMessages.find((msg) => msg.entityKind === 'task');
    expect(taskEnvelope).toBeDefined();
    if (taskEnvelope === undefined) return;

    const claim = await legacyHarness.core.claimDurableWork({
      envelope: taskEnvelope,
      workerId: 'worker-recurring-guard',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    const reserveTaskModelAttempt = vi.fn(
      (req: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) =>
        legacyHarness.core.reserveTaskModelAttempt(req),
    );
    const executorEnv = {
      ...baseRealEnv(),
      AGENT_HEAD: {
        getByName: () => ({
          markAttemptSent: (req: Parameters<AgentHeadCore['markAttemptSent']>[0]) =>
            legacyHarness.core.markAttemptSent(req),
          reserveTaskModelAttempt,
          taskArtifacts: (req: Parameters<AgentHeadCore['taskArtifacts']>[0]) =>
            legacyHarness.core.taskArtifacts(req),
          edgeRpc: vi.fn(),
        }),
      },
      D1_RECOVERY: {} as D1DatabaseLike,
      DURABLE_TURN_QUEUE: legacyHarness.queue,
      AGENT_TASK_QUEUE: legacyHarness.queue,
      GLOBAL_BUDGET: { getByName: () => legacyHarness.globalBudget },
    } as unknown as Parameters<typeof createDurableExecutor>[0];

    const executor = createDurableExecutor(executorEnv, runtime.gateway, { modelRuntime: runtime });
    const outcome = await executor.executeDurableWork({
      ...claim,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-recurring-guard',
    });
    expect(outcome).toEqual({
      status: 'failed',
      summaryText: preExisting.title,
      detailText: null,
      modelLabel: runtime.modelLabel,
      simulated: false,
      reasonCode: 'recurring_real_model_unauthorized',
    });
    expect(reserveTaskModelAttempt).not.toHaveBeenCalled();
    expect(providerCalls).toBe(0);

    // Legacy payload missing scheduleKind also fails closed when recurring real-model briefs are disabled.
    const legacyCtx = JSON.parse(claim.contextJson) as Record<string, unknown>;
    const legacyInput = JSON.parse(legacyCtx['inputJson'] as string) as {
      proactiveSchedule: Record<string, unknown>;
    };
    delete legacyInput.proactiveSchedule['scheduleKind'];
    legacyCtx['inputJson'] = JSON.stringify(legacyInput);
    const legacyOutcome = await executor.executeDurableWork({
      ...claim,
      contextJson: JSON.stringify(legacyCtx),
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-recurring-guard',
    });
    expect(legacyOutcome).toMatchObject({
      status: 'failed',
      reasonCode: 'recurring_real_model_unauthorized',
    });
    expect(providerCalls).toBe(0);

    // 3. Committing recurring_real_model_unauthorized auto-pauses the recurring schedule,
    //    delivers one honest failure notice, prevents future alarm firings, and denies resume.
    const commitRes = await legacyHarness.core.commitDurableResult({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      entityType: 'task',
      entityId: taskEnvelope.entityId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-recurring-guard',
      outcome,
    });
    expect(commitRes.accepted).toBe(true);

    const autoPausedDetail = (await legacyHarness.core.proactiveSchedule({
      kind: 'get',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      scheduleId: preExisting.scheduleId,
    })) as ProactiveScheduleDetail;
    expect(autoPausedDetail.status).toBe('paused');

    const failureMessages = await legacyHarness.core.readMessages({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
      after: 0,
      limit: 10,
    });
    const lastFailureMsg = failureMessages.messages.at(-1);
    expect(lastFailureMsg?.kind).toBe('ember');
    if (lastFailureMsg?.kind === 'ember') {
      expect(lastFailureMsg.text).toContain(
        'recurring AI briefs are not enabled for this account, so this schedule was paused',
      );
    }

    const tasksBeforeNextTick = legacyHarness.sentMessages.filter(
      (msg) => msg.entityKind === 'task',
    ).length;
    nowMs += 600_000;
    await legacyHarness.events.handleAlarm({
      nowMs,
      queues: { durable_turn: legacyHarness.queue, agent_task: legacyHarness.queue },
      globalBudget: legacyHarness.core.createGlobalBudgetSettlePort(),
      registry: legacyHarness.registry,
    });
    expect(legacyHarness.sentMessages.filter((msg) => msg.entityKind === 'task')).toHaveLength(
      tasksBeforeNextTick,
    );

    const guardedResumeCore = new AgentHeadCore({
      storage: (legacyHarness.core as unknown as { storage: DurableObjectStorageLike }).storage,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      recoveryRegistry: legacyHarness.registry,
      globalBudget: legacyHarness.globalBudget,
      globalDailyCeilingMicroUsd: 100_000,
      allowRecurringModelBriefs: false,
      eventRuntimeFactory: (business) => {
        const events = new AgentEventRuntimeFacade({
          storage: (legacyHarness.core as unknown as { storage: DurableObjectStorageLike }).storage,
          tenantId: TENANT_A,
          agentId: AGENT_A,
          business,
        });
        return {
          recoveryAdmission: events.coverage,
          eventCoordinator: events.outbox,
          recoveryHooks: events.asTurnRecoveryHooks({
            globalBudget: { settleGlobal: () => Promise.resolve({ accepted: true }) },
          }),
        };
      },
    });
    await expect(
      guardedResumeCore.proactiveSchedule({
        kind: 'resume',
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        requestId: randomUUID(),
        scheduleId: preExisting.scheduleId,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('combined negative: recurring real model_brief disabled incurs zero paid egress and existing one-time brief failure delivers one honest Chat notice', async () => {
    let nowMs = Date.now();
    const h = createInMemoryHarness({
      nowMs: () => nowMs,
      allowRecurringModelBriefs: false,
    });

    // 1. Recurring model_brief attempt in real mode with recurring disabled -> 0 provider calls
    let recurringProviderCalls = 0;
    const disabledRecurringRuntime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: () => {
        recurringProviderCalls += 1;
        return Promise.reject(new Error('must not incur paid egress'));
      },
    });
    expect(disabledRecurringRuntime.allowRecurringBriefs).toBe(false);

    await expect(
      h.core.proactiveSchedule({
        kind: 'create',
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        agentId: AGENT_A,
        requestId: randomUUID(),
        input: {
          idempotencyKey: 'combined-recurring-disabled',
          kind: 'brief',
          title: 'Disabled Recurring Brief',
          prompt: 'Should never execute.',
          trigger: { type: 'interval', intervalSeconds: 600 },
          timezone: 'Asia/Shanghai',
          deliveryMode: 'model_brief',
        },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(recurringProviderCalls).toBe(0);

    // 2. Existing one-time model_brief fails on OpenRouter 503 -> commits exactly one honest Chat notice
    const oneTimeBrief = (await h.core.proactiveSchedule({
      kind: 'create',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      input: {
        idempotencyKey: 'combined-onetime-brief-failure',
        kind: 'brief',
        title: 'One-Time Real Brief',
        prompt: 'Summarize urgent release notes.',
        trigger: { type: 'once', fireAt: new Date(nowMs + 1_000).toISOString() },
        timezone: 'Asia/Shanghai',
        deliveryMode: 'model_brief',
      },
    })) as ProactiveScheduleSnapshot;

    nowMs += 2_000;
    await h.events.handleAlarm({
      nowMs,
      queues: { durable_turn: h.queue, agent_task: h.queue },
      globalBudget: h.core.createGlobalBudgetSettlePort(),
      registry: h.registry,
    });
    const taskEnvelope = h.sentMessages.find((msg) => msg.entityKind === 'task');
    expect(taskEnvelope).toBeDefined();
    if (taskEnvelope === undefined) return;

    const claim = await h.core.claimDurableWork({
      envelope: taskEnvelope,
      workerId: 'worker-onetime-fail',
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    let providerCalls = 0;
    const failingRealRuntime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: () => {
        providerCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    const executorEnv = {
      ...baseRealEnv(),
      AGENT_HEAD: {
        getByName: () => ({
          markAttemptSent: (req: Parameters<AgentHeadCore['markAttemptSent']>[0]) =>
            h.core.markAttemptSent(req),
          reserveTaskModelAttempt: (req: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) =>
            h.core.reserveTaskModelAttempt(req),
          taskArtifacts: (req: Parameters<AgentHeadCore['taskArtifacts']>[0]) =>
            h.core.taskArtifacts(req),
          edgeRpc: vi.fn(),
        }),
      },
      D1_RECOVERY: {} as D1DatabaseLike,
      DURABLE_TURN_QUEUE: h.queue,
      AGENT_TASK_QUEUE: h.queue,
      GLOBAL_BUDGET: { getByName: () => h.globalBudget },
    } as unknown as Parameters<typeof createDurableExecutor>[0];

    const executor = createDurableExecutor(executorEnv, failingRealRuntime.gateway, {
      modelRuntime: failingRealRuntime,
    });
    const outcome = await executor.executeDurableWork({
      ...claim,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      workerId: 'worker-onetime-fail',
    });
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(providerCalls).toBe(1);

    const committed = await h.core.commitDurableResult({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      entityType: 'task',
      entityId: claim.targetId,
      leaseEpoch: claim.leaseEpoch,
      workerId: 'worker-onetime-fail',
      outcome,
    });
    expect(committed.accepted).toBe(true);

    const detail = (await h.core.proactiveSchedule({
      kind: 'get',
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      requestId: randomUUID(),
      scheduleId: oneTimeBrief.scheduleId,
    })) as {
      readonly latestRun: {
        readonly status: string;
        readonly resultMessageId: string | null;
      } | null;
    };
    expect(detail.latestRun?.status).toBe('failed');
    expect(detail.latestRun?.resultMessageId).toBeTruthy();

    const page = await h.core.readMessages({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
      after: 0,
      limit: 10,
    });
    const notices = page.messages.filter(
      (msg): msg is Extract<typeof msg, { readonly kind: 'ember' }> =>
        msg.kind === 'ember' && msg.text.includes('One-Time Real Brief'),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('Could not deliver "**One-Time Real Brief**"');
    expect(notices[0]?.message_id).toBe(detail.latestRun?.resultMessageId);
  });

  it('blocks un-allowlisted tenants on POST /v2/tasks/python at HTTP ingress', async () => {
    const runtime = resolveV2ModelRuntime(baseRealEnv(), {
      fetchImpl: () => Promise.reject(new Error('must not be called')),
    });
    const taskArtifacts = vi.fn();
    const sessions: B1SessionRuntime = {
      service: {
        createSession: vi.fn(),
        refreshSession: vi.fn(),
        logout: vi.fn(),
        resolveActiveSession: vi.fn().mockResolvedValue({
          session: {
            sessionId: randomUUID(),
            consumerId: randomUUID(),
            tenantId: TENANT_B,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            revokedAt: null,
          },
          auth: {
            tenantId: TENANT_B,
            principalId: PRINCIPAL_A,
            policyVersion: 1,
          },
        }),
      },
      appleVerifier: { provider: 'apple', verify: () => Promise.resolve(null) },
      devVerifier: { provider: 'dev', verify: () => Promise.resolve(null) },
      devProvider: { evaluate: () => ({ enabled: false, deniedBy: [] }) },
      me: { getMeForTenant: () => Promise.resolve(null) },
    };

    const worker = createLocalV2EdgeWorker({
      sessions,
      allowedHosts: ['ember-v2-staging.slowfast.dev'],
      resolveAgentHead: () =>
        Promise.resolve({
          agentId: AGENT_A,
          conversationId: CONVERSATION_A,
          rpc: { taskArtifacts } as never,
        }),
      stream: {
        gateway: runtime.gateway,
        expectedSimulated: runtime.simulated,
        preflightRate: runtime.rate,
        authorizeModelTurn: (auth) => {
          if (!runtime.isTenantAuthorized(auth.tenantId)) {
            throw new DomainError('POLICY_DENIED', 'tenant not allowlisted');
          }
        },
        resolveModelReservation: () => runtime.getTurnReservation(),
        reportObservedUsage: vi.fn(),
      },
    });

    const res = await worker.fetch(
      new Request('https://ember-v2-staging.slowfast.dev/v2/tasks/python', {
        method: 'POST',
        headers: {
          authorization: `Bearer ems_${'a'.repeat(43)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'Run python' }),
      }),
    );

    expect(res.status).toBe(403);
    expect(taskArtifacts).not.toHaveBeenCalled();
  });

  it('upgrades v8 AgentHeadDO spend/incident tables cleanly to v9, preserves mixed-mode spend/reservations, and fails closed on unprovable rows', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = createSqliteStorage(db);
    const allMigrations = createDefaultAgentHeadMigrations();
    const v1To8 = allMigrations.filter((m) => m.version <= 8);

    const first = applyAgentHeadMigrations(storage, v1To8, 1_000);
    expect(first.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    db.prepare(
      `INSERT INTO agent_head_meta (id, tenant_id, agent_id, policy_version, home_region, created_at_ms, updated_at_ms)
       VALUES (1, ?, ?, 1, NULL, 1000, 1000)`,
    ).run(TENANT_A, AGENT_A);
    db.prepare(
      `INSERT INTO conversations (id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms)
       VALUES (?, 'main', 2, 0, 1000, 1000)`,
    ).run(CONVERSATION_A);
    const activeTurnId = randomUUID();
    const activeMsgId = randomUUID();
    db.prepare(
      `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
       VALUES (?, ?, 1, 'user', 'in-flight real turn', ?, 3000)`,
    ).run(activeMsgId, CONVERSATION_A, randomUUID());
    db.prepare(
      `INSERT INTO assistant_turns (
         id, conversation_id, source_message_id, response_message_id, status,
         execution_mode, deadline_at_ms, lease_epoch, lease_owner, lease_expires_at_ms, claim_count, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, NULL, 'running', 'fast_interactive', 600000, 1, 'edge-1', 60000, 1, 3000, 3000)`,
    ).run(activeTurnId, CONVERSATION_A, activeMsgId);

    const activeRealOpId = randomUUID();
    db.prepare(
      `INSERT INTO model_attempts (
         subject_type, subject_id, attempt_no, operation_id, principal_id, utc_day,
         lease_epoch, provider_id, model_label, rate_version, budget_mode, state,
         reserved_micro_usd, applied_cost_micro_usd, observed_cost_micro_usd, started_at_ms, settled_at_ms
       ) VALUES
         ('turn', 'turn-real-only', 1, 'op-real-only', ?, '2026-11-21', 1, 'openrouter', ?, 'r1', 'real', 'settled', 935, 220, 220, 1000, 1100),
         ('turn', 'turn-fake-only', 1, 'op-fake-only', ?, '2026-11-22', 1, 'fake', 'ember-fake-llm-1', 'v1', 'simulated_full_protocol', 'conservative_billed', 250, 250, NULL, 2000, 2100),
         ('turn', 'turn-real-mix', 1, 'op-real-mix', ?, '2026-11-23', 1, 'openrouter', ?, 'r1', 'real', 'settled', 935, 900, 900, 3000, 3100),
         ('turn', 'turn-fake-mix', 1, 'op-fake-mix', ?, '2026-11-23', 1, 'fake', 'ember-fake-llm-1', 'v1', 'simulated_full_protocol', 'settled', 250, 200, 200, 3200, 3300),
         ('turn', ?, 1, ?, ?, '2026-11-24', 1, 'openrouter', ?, 'r1', 'real', 'reserved', 935, 0, NULL, 3400, NULL),
         ('turn', 'turn-fake-day24', 1, 'op-fake-day24', ?, '2026-11-24', 1, 'fake', 'ember-fake-llm-1', 'v1', 'simulated_full_protocol', 'settled', 250, 200, 200, 3500, 3600)`,
    ).run(
      PRINCIPAL_A,
      APPROVED_OPENROUTER_MODEL,
      PRINCIPAL_A,
      PRINCIPAL_A,
      APPROVED_OPENROUTER_MODEL,
      PRINCIPAL_A,
      activeTurnId,
      activeRealOpId,
      PRINCIPAL_A,
      APPROVED_OPENROUTER_MODEL,
      PRINCIPAL_A,
    );

    db.prepare(
      `INSERT INTO agent_spend_days (
         scope_kind, scope_id, utc_day, reserved_micro_usd, consumed_micro_usd,
         overage_micro_usd, turns_started, updated_at_ms
       ) VALUES
         ('tenant', ?, '2026-11-20', 0, 400, 0, 0, 900),
         ('tenant', ?, '2026-11-21', 0, 220, 0, 0, 1100),
         ('principal', ?, '2026-11-21', 0, 220, 0, 1, 1100),
         ('tenant', ?, '2026-11-22', 0, 250, 0, 0, 2100),
         ('tenant', ?, '2026-11-23', 0, 1100, 0, 0, 3300),
         ('principal', ?, '2026-11-23', 0, 1100, 0, 2, 3300),
         ('tenant', ?, '2026-11-24', 935, 200, 0, 0, 3600),
         ('principal', ?, '2026-11-24', 935, 200, 0, 2, 3600)`,
    ).run(TENANT_A, TENANT_A, PRINCIPAL_A, TENANT_A, TENANT_A, PRINCIPAL_A, TENANT_A, PRINCIPAL_A);

    db.prepare(
      `INSERT INTO agent_budget_incidents (
         id, scope_kind, scope_id, utc_day, reason, subject_type, subject_id, attempt_no,
         observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd, detected_at_ms
       ) VALUES
         ('inc-fake', 'tenant', ?, '2026-11-22', 'usage_missing', 'turn', 'turn-fake-only', 1, 250, 250, 0, 250, 2100),
         ('inc-orphaned', 'tenant', ?, '2026-11-20', 'reservation_exceeded', 'turn', 'missing-turn', 1, 500, 500, 100, 400, 950),
         ('inc-real', 'tenant', ?, '2026-11-23', 'reservation_exceeded', 'turn', 'turn-real-mix', 1, 1200, 1200, 265, 935, 3100),
         ('inc-unlinked', 'tenant', ?, '2026-11-20', 'day_ceiling_exceeded', NULL, NULL, NULL, 500, 500, 100, 400, 900)`,
    ).run(TENANT_A, TENANT_A, TENANT_A, TENANT_A);

    const v1To9 = allMigrations.filter((m) => m.version <= 9);
    const upgraded = applyAgentHeadMigrations(storage, v1To9, 4_000);
    expect(upgraded.alreadyAppliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(upgraded.appliedVersions).toEqual([9]);

    const upgradedV10 = applyAgentHeadMigrations(storage, allMigrations, 4_500);
    expect(upgradedV10.alreadyAppliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(upgradedV10.appliedVersions).toEqual([10, 11]);

    const rerun = applyAgentHeadMigrations(storage, allMigrations, 5_000);
    expect(rerun.appliedVersions).toEqual([]);
    expect(rerun.alreadyAppliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const spendDdl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_spend_days'")
      .get() as { sql: string };
    expect(spendDdl.sql).toMatch(/\bWITHOUT\s+ROWID\b/i);
    expect(spendDdl.sql).toMatch(/PRIMARY KEY \(scope_kind, scope_id, utc_day, budget_mode\)/i);

    const spendRows = db
      .prepare(
        `SELECT scope_kind, utc_day, budget_mode, reserved_micro_usd, consumed_micro_usd, overage_micro_usd, turns_started
           FROM agent_spend_days
          ORDER BY utc_day ASC, scope_kind ASC, budget_mode ASC`,
      )
      .all() as Array<
      Pick<
        AgentSpendDayRow,
        | 'scope_kind'
        | 'utc_day'
        | 'budget_mode'
        | 'reserved_micro_usd'
        | 'consumed_micro_usd'
        | 'overage_micro_usd'
        | 'turns_started'
      >
    >;
    expect(spendRows).toEqual([
      // 2026-11-20: unprovable row (no model_attempts) is conservatively preserved in BOTH modes
      {
        scope_kind: 'tenant',
        utc_day: '2026-11-20',
        budget_mode: 'real',
        reserved_micro_usd: 0,
        consumed_micro_usd: 400,
        overage_micro_usd: 0,
        turns_started: 0,
      },
      {
        scope_kind: 'tenant',
        utc_day: '2026-11-20',
        budget_mode: 'simulated_full_protocol',
        reserved_micro_usd: 0,
        consumed_micro_usd: 400,
        overage_micro_usd: 0,
        turns_started: 0,
      },
      // 2026-11-21: real-only day
      {
        scope_kind: 'principal',
        utc_day: '2026-11-21',
        budget_mode: 'real',
        reserved_micro_usd: 0,
        consumed_micro_usd: 220,
        overage_micro_usd: 0,
        turns_started: 1,
      },
      {
        scope_kind: 'tenant',
        utc_day: '2026-11-21',
        budget_mode: 'real',
        reserved_micro_usd: 0,
        consumed_micro_usd: 220,
        overage_micro_usd: 0,
        turns_started: 0,
      },
      // 2026-11-22: simulated-only day
      {
        scope_kind: 'tenant',
        utc_day: '2026-11-22',
        budget_mode: 'simulated_full_protocol',
        reserved_micro_usd: 0,
        consumed_micro_usd: 250,
        overage_micro_usd: 0,
        turns_started: 0,
      },
      // 2026-11-23: mixed day faithfully splits 900 real + 200 simulated (conserving 1100 total & 2 turns)
      {
        scope_kind: 'principal',
        utc_day: '2026-11-23',
        budget_mode: 'real',
        reserved_micro_usd: 0,
        consumed_micro_usd: 900,
        overage_micro_usd: 0,
        turns_started: 1,
      },
      {
        scope_kind: 'principal',
        utc_day: '2026-11-23',
        budget_mode: 'simulated_full_protocol',
        reserved_micro_usd: 0,
        consumed_micro_usd: 200,
        overage_micro_usd: 0,
        turns_started: 1,
      },
      {
        scope_kind: 'tenant',
        utc_day: '2026-11-23',
        budget_mode: 'real',
        reserved_micro_usd: 0,
        consumed_micro_usd: 900,
        overage_micro_usd: 0,
        turns_started: 0,
      },
      {
        scope_kind: 'tenant',
        utc_day: '2026-11-23',
        budget_mode: 'simulated_full_protocol',
        reserved_micro_usd: 0,
        consumed_micro_usd: 200,
        overage_micro_usd: 0,
        turns_started: 0,
      },
      // 2026-11-24: mixed day keeps active real reservation (935) in real and settled fake (200) in simulated
      {
        scope_kind: 'principal',
        utc_day: '2026-11-24',
        budget_mode: 'real',
        reserved_micro_usd: 935,
        consumed_micro_usd: 0,
        overage_micro_usd: 0,
        turns_started: 1,
      },
      {
        scope_kind: 'principal',
        utc_day: '2026-11-24',
        budget_mode: 'simulated_full_protocol',
        reserved_micro_usd: 0,
        consumed_micro_usd: 200,
        overage_micro_usd: 0,
        turns_started: 1,
      },
      {
        scope_kind: 'tenant',
        utc_day: '2026-11-24',
        budget_mode: 'real',
        reserved_micro_usd: 935,
        consumed_micro_usd: 0,
        overage_micro_usd: 0,
        turns_started: 0,
      },
      {
        scope_kind: 'tenant',
        utc_day: '2026-11-24',
        budget_mode: 'simulated_full_protocol',
        reserved_micro_usd: 0,
        consumed_micro_usd: 200,
        overage_micro_usd: 0,
        turns_started: 0,
      },
    ]);

    const incidentRows = db
      .prepare('SELECT id, budget_mode, reason FROM agent_budget_incidents ORDER BY id ASC')
      .all() as Array<Pick<AgentBudgetIncidentRow, 'id' | 'budget_mode' | 'reason'>>;
    expect(incidentRows).toEqual([
      { id: 'inc-fake', budget_mode: 'simulated_full_protocol', reason: 'usage_missing' },
      { id: 'inc-orphaned', budget_mode: null, reason: 'reservation_exceeded' },
      { id: 'inc-real', budget_mode: 'real', reason: 'reservation_exceeded' },
      { id: 'inc-unlinked', budget_mode: null, reason: 'day_ceiling_exceeded' },
    ]);

    // Unlinked/orphaned unresolved incidents fail closed for BOTH real and simulated modes!
    expect(
      findLocalUnresolvedIncidentSync(storage.sql, TENANT_A, PRINCIPAL_A, 'real'),
    ).not.toBeNull();
    expect(
      findLocalUnresolvedIncidentSync(
        storage.sql,
        TENANT_A,
        PRINCIPAL_A,
        'simulated_full_protocol',
      ),
    ).not.toBeNull();

    // Resolving unlinked/orphaned + real incidents clears real while inc-fake still halts simulated only.
    db.prepare(
      `UPDATE agent_budget_incidents
          SET resolved_at_ms = 4500
        WHERE id IN ('inc-unlinked', 'inc-orphaned', 'inc-real')`,
    ).run();
    expect(findLocalUnresolvedIncidentSync(storage.sql, TENANT_A, PRINCIPAL_A, 'real')).toBeNull();
    expect(
      findLocalUnresolvedIncidentSync(
        storage.sql,
        TENANT_A,
        PRINCIPAL_A,
        'simulated_full_protocol',
      ),
    ).toEqual({ scopeKind: 'tenant', reason: 'usage_missing' });

    // Post-upgrade real capacity reflects the migrated 900 real spend on 2026-11-23 (ceiling 1000: 100 passes, 101 fails).
    expect(
      checkLocalBudgetCapacitySync({
        sql: storage.sql,
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        utcDay: '2026-11-23',
        budgetMode: 'real',
        amountMicroUsd: 100,
        turnsStartedDelta: 1,
        ceilings: {
          perAttemptMicroUsd: 5_000,
          principalDailyMicroUsd: 1_000,
          tenantDailyMicroUsd: 1_000,
          principalDailyTurns: 20,
        },
      }),
    ).toEqual({ ok: true });
    expect(
      checkLocalBudgetCapacitySync({
        sql: storage.sql,
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        utcDay: '2026-11-23',
        budgetMode: 'real',
        amountMicroUsd: 101,
        turnsStartedDelta: 1,
        ceilings: {
          perAttemptMicroUsd: 5_000,
          principalDailyMicroUsd: 1_000,
          tenantDailyMicroUsd: 1_000,
          principalDailyTurns: 20,
        },
      }),
    ).toEqual({ ok: false, reason: 'budget_exceeded' });

    // Settling the pre-upgrade in-progress real reserved attempt after upgrade releases 935 from 'real' and books 220 without stranding or distorting 'simulated_full_protocol'.
    const fakeGbStorage = createSqliteStorage(new DatabaseSync(':memory:'));
    const fakeGb = new GlobalBudgetAuthorityCore(fakeGbStorage, 100_000);
    const postUpgradeCore = new AgentHeadCore({
      storage,
      tenantId: TENANT_A,
      agentId: AGENT_A,
      recoveryRegistry: {
        upsertCoverage: () =>
          Promise.resolve({ accepted: true, currentGeneration: 1, actualRecoveryAtMs: 5_000 }),
        postponeCoverage: () =>
          Promise.resolve({ updated: true, currentGeneration: 1, actualRecoveryAtMs: 5_000 }),
        retireCoverage: () => Promise.resolve({ retired: true }),
        getCoverage: () =>
          Promise.resolve({
            exists: false,
            currentGeneration: null,
            actualRecoveryAtMs: null,
            status: null,
            retryNotBeforeMs: null,
          }),
      },
      globalBudget: fakeGb,
      globalDailyCeilingMicroUsd: 100_000,
      nowMs: () => 4_600,
      eventRuntimeFactory(business) {
        const events = new AgentEventRuntimeFacade({
          storage,
          tenantId: TENANT_A,
          agentId: AGENT_A,
          business,
        });
        return {
          recoveryAdmission: events.coverage,
          eventCoordinator: events.outbox,
          recoveryHooks: events.asTurnRecoveryHooks({
            globalBudget: { settleGlobal: () => Promise.resolve({ accepted: true }) },
          }),
        };
      },
    });

    const settledPostUpgrade = await postUpgradeCore.commitTurn({
      scope: { tenantId: TENANT_A, agentId: AGENT_A },
      conversationId: CONVERSATION_A,
      turnId: activeTurnId,
      leaseEpoch: 1,
      leaseOwner: 'edge-1',
      attemptNo: 1,
      operationId: activeRealOpId,
      settlement: {
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 220,
        inputTokens: 100,
        outputTokens: 20,
      },
      result: {
        status: 'completed',
        text: 'settled after v9 upgrade',
        modelLabel: APPROVED_OPENROUTER_MODEL,
        simulated: false,
      },
    });
    expect(settledPostUpgrade.outcome).toBe('published');

    const day24Rows = db
      .prepare(
        `SELECT scope_kind, budget_mode, reserved_micro_usd, consumed_micro_usd, turns_started
           FROM agent_spend_days
          WHERE utc_day = '2026-11-24'
          ORDER BY scope_kind ASC, budget_mode ASC`,
      )
      .all() as Array<
      Pick<
        AgentSpendDayRow,
        'scope_kind' | 'budget_mode' | 'reserved_micro_usd' | 'consumed_micro_usd' | 'turns_started'
      >
    >;
    expect(day24Rows).toEqual([
      {
        scope_kind: 'principal',
        budget_mode: 'real',
        reserved_micro_usd: 0,
        consumed_micro_usd: 220,
        turns_started: 1,
      },
      {
        scope_kind: 'principal',
        budget_mode: 'simulated_full_protocol',
        reserved_micro_usd: 0,
        consumed_micro_usd: 200,
        turns_started: 1,
      },
      {
        scope_kind: 'tenant',
        budget_mode: 'real',
        reserved_micro_usd: 0,
        consumed_micro_usd: 220,
        turns_started: 0,
      },
      {
        scope_kind: 'tenant',
        budget_mode: 'simulated_full_protocol',
        reserved_micro_usd: 0,
        consumed_micro_usd: 200,
        turns_started: 0,
      },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('isolates AgentHeadDO turns, spend buckets, and unresolved incidents between simulated_full_protocol and real modes on the same UTC day (P0-2)', async () => {
    const nowMs = Date.parse('2026-11-23T00:00:00.000Z');
    const realGbStorage = createSqliteStorage(new DatabaseSync(':memory:'));
    const realGlobalBudget = new GlobalBudgetAuthorityCore(
      realGbStorage,
      100_000,
      () => nowMs,
      () => `real:${randomUUID()}`,
    );
    const h = createInMemoryHarness({
      nowMs: () => nowMs,
      realGlobalBudget,
      localCeilings: {
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 5_000,
        tenantDailyMicroUsd: 5_000,
        principalDailyTurns: 2,
      },
    });

    const fakeReservation = {
      budgetMode: 'simulated_full_protocol' as const,
      providerId: 'fake' as const,
      modelLabel: 'ember-fake-llm-1',
      rateVersion: 'v1',
      maxAttempts: 1,
      estimatedMicroUsd: 2_500,
    };
    const realReservation = {
      budgetMode: 'real' as const,
      providerId: 'openrouter' as const,
      modelLabel: APPROVED_OPENROUTER_MODEL,
      rateVersion: 'openrouter-deepseek-v4.1-flash-1017-deepinfra-fp8-2026-11-17',
      maxAttempts: 1,
      estimatedMicroUsd: 935,
    };

    const runTurn = async (
      reservation: typeof fakeReservation | typeof realReservation,
      text: string,
      settlement:
        | { state: 'settled'; outcomeCode: 'ok'; observedCostMicroUsd: number }
        | { state: 'conservative_billed'; outcomeCode: 'usage_missing' },
    ) => {
      const prep = await h.core.prepareTurn({
        scope: {
          tenantId: TENANT_A,
          principalId: PRINCIPAL_A,
          agentId: AGENT_A,
          policyVersion: 1,
          requestId: randomUUID(),
        },
        conversationId: CONVERSATION_A,
        request: {
          client_submission_id: randomUUID(),
          text,
          transcript_epoch: 0,
        },
        workerId: 'edge-1',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 600_000,
        executionMode: 'fast_interactive',
        modelReservation: reservation,
      });
      if (prep.kind !== 'prepared') throw new Error('expected prepared');
      const sent = await h.core.markAttemptSent({
        scope: { tenantId: TENANT_A, agentId: AGENT_A },
        subjectType: 'turn',
        subjectId: prep.turnId,
        attemptNo: prep.attemptNo,
        operationId: prep.operationId,
        leaseEpoch: prep.leaseEpoch,
        leaseOwner: 'edge-1',
      });
      expect(sent.authorized).toBe(true);
      await h.core.commitTurn({
        scope: { tenantId: TENANT_A, agentId: AGENT_A },
        conversationId: CONVERSATION_A,
        turnId: prep.turnId,
        leaseEpoch: prep.leaseEpoch,
        leaseOwner: 'edge-1',
        attemptNo: prep.attemptNo,
        operationId: prep.operationId,
        settlement,
        result: {
          status: 'completed',
          text: `reply:${text}`,
          modelLabel: reservation.modelLabel,
          simulated: reservation.budgetMode !== 'real',
        },
      });
    };

    // Exhaust BOTH principalDailyTurns (2) and daily micro-USD (5_000) in fake mode,
    // plus open an unresolved fake `usage_missing` incident.
    await runTurn(fakeReservation, 'fake-1', {
      state: 'settled',
      outcomeCode: 'ok',
      observedCostMicroUsd: 2_500,
    });
    await runTurn(fakeReservation, 'fake-2', {
      state: 'conservative_billed',
      outcomeCode: 'usage_missing',
    });

    await expect(
      h.core.prepareTurn({
        scope: {
          tenantId: TENANT_A,
          principalId: PRINCIPAL_A,
          agentId: AGENT_A,
          policyVersion: 1,
          requestId: randomUUID(),
        },
        conversationId: CONVERSATION_A,
        request: {
          client_submission_id: randomUUID(),
          text: 'fake-3-blocked',
          transcript_epoch: 0,
        },
        workerId: 'edge-1',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 600_000,
        executionMode: 'fast_interactive',
        modelReservation: fakeReservation,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

    // Real turns AND real task model attempts must remain completely unaffected on the same UTC day!
    await runTurn(realReservation, 'real-1', {
      state: 'settled',
      outcomeCode: 'ok',
      observedCostMicroUsd: 220,
    });

    const taskId = randomUUID();
    const runId = randomUUID();
    h.headDb
      .prepare(
        `INSERT INTO tasks (id, kind, input_json, digest, idempotency_key, status, execution_path, execution_target, attempt_count, max_attempts, current_run_id, lease_epoch, lease_expires_at_ms, next_run_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'python.agent', '{"prompt":"p"}', 'd', ?, 'running', 'heavy', 'cloud', 1, 3, ?, 1, ?, ?, ?, ?)`,
      )
      .run(taskId, randomUUID(), runId, nowMs + 30_000, nowMs, nowMs, nowMs);
    h.headDb
      .prepare(
        `INSERT INTO runs (id, task_id, attempt, lease_epoch, status, worker_id, executor_kind, leased_until_ms, started_at_ms, updated_at_ms)
         VALUES (?, ?, 1, 1, 'running', 'py-worker', 'queue_worker', ?, ?, ?)`,
      )
      .run(runId, taskId, nowMs + 30_000, nowMs, nowMs);

    const realTaskRes = await h.core.reserveTaskModelAttempt({
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      agentId: AGENT_A,
      taskId,
      runId,
      leaseEpoch: 1,
      providerId: 'openrouter',
      modelLabel: APPROVED_OPENROUTER_MODEL,
      rateVersion: realReservation.rateVersion,
      budgetMode: 'real',
      estimatedMicroUsd: 500,
    });
    expect(realTaskRes.kind).toBe('reserved');
    if (realTaskRes.kind !== 'reserved') throw new Error('expected reserved');
    const taskSent = await h.core.markAttemptSent({
      scope: { tenantId: TENANT_A, agentId: AGENT_A },
      subjectType: 'task',
      subjectId: taskId,
      attemptNo: realTaskRes.attemptNo,
      operationId: realTaskRes.operationId,
      leaseEpoch: 1,
      leaseOwner: 'py-worker',
    });
    expect(taskSent.authorized).toBe(true);
    await h.core.settleTaskModelAttempt({
      tenantId: TENANT_A,
      agentId: AGENT_A,
      taskId,
      attemptNo: realTaskRes.attemptNo,
      operationId: realTaskRes.operationId,
      requestedState: 'settled',
      outcomeCode: 'ok',
      observedCostMicroUsd: 180,
    });

    // Reverse isolation: an unresolved real incident halts real turns without halting fake turns
    // (after resolving the fake incident while keeping fake turns under a fresh principal).
    await runTurn(realReservation, 'real-2-incident', {
      state: 'conservative_billed',
      outcomeCode: 'usage_missing',
    });
    await expect(
      h.core.prepareTurn({
        scope: {
          tenantId: TENANT_A,
          principalId: PRINCIPAL_A,
          agentId: AGENT_A,
          policyVersion: 1,
          requestId: randomUUID(),
        },
        conversationId: CONVERSATION_A,
        request: {
          client_submission_id: randomUUID(),
          text: 'real-3-blocked',
          transcript_epoch: 0,
        },
        workerId: 'edge-1',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 600_000,
        executionMode: 'fast_interactive',
        modelReservation: realReservation,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

    const spendRows = h.headDb
      .prepare(
        `SELECT scope_kind, budget_mode, consumed_micro_usd, turns_started
           FROM agent_spend_days
          WHERE utc_day = '2026-11-23'
          ORDER BY budget_mode ASC, scope_kind ASC`,
      )
      .all() as Array<
      Pick<AgentSpendDayRow, 'scope_kind' | 'budget_mode' | 'consumed_micro_usd' | 'turns_started'>
    >;
    expect(spendRows).toEqual([
      {
        scope_kind: 'principal',
        budget_mode: 'real',
        consumed_micro_usd: 220 + 180 + 935,
        turns_started: 2,
      },
      {
        scope_kind: 'tenant',
        budget_mode: 'real',
        consumed_micro_usd: 220 + 180 + 935,
        turns_started: 0,
      },
      {
        scope_kind: 'principal',
        budget_mode: 'simulated_full_protocol',
        consumed_micro_usd: 2_500 + 2_500,
        turns_started: 2,
      },
      {
        scope_kind: 'tenant',
        budget_mode: 'simulated_full_protocol',
        consumed_micro_usd: 2_500 + 2_500,
        turns_started: 0,
      },
    ]);
  });
});
