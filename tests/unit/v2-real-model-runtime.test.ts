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
  type FetchLike,
} from '@ember/model-gateway';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  applyAgentHeadMigrations,
  createDefaultAgentHeadMigrations,
  type D1DatabaseLike,
  type DurableObjectStorageLike,
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
import { resolveV2SandboxConfig } from '../../apps/api/src/local-v2/runtime-config.js';
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

function createInMemoryHarness(options: { globalCeilingMicroUsd?: number } = {}) {
  const headDb = new DatabaseSync(':memory:');
  const gbDb = new DatabaseSync(':memory:');
  const headStorage = createSqliteStorage(headDb);
  const gbStorage = createSqliteStorage(gbDb);
  const globalBudget = new GlobalBudgetAuthorityCore(
    gbStorage,
    options.globalCeilingMicroUsd ?? 100_000,
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
    globalDailyCeilingMicroUsd: options.globalCeilingMicroUsd ?? 100_000,
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
      resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ALPHA_SCOPE: 'authenticated_tenants' })),
    ).toThrow(/allowlist/);
    expect(() => resolveV2ModelRuntime(baseRealEnv({ EMBER_MODEL_ALPHA_SCOPE: 'all' }))).toThrow(
      /allowlist/,
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
      reasonCode: 'sandbox_provider_unavailable',
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

    const upgraded = applyAgentHeadMigrations(storage, allMigrations, 2_000);
    expect(upgraded.appliedVersions).toEqual([7, 8]);
    expect(upgraded.alreadyAppliedVersions).toEqual([1, 2, 3, 4, 5, 6]);
    expect(db.prepare('SELECT content FROM personal_memories').all()).toEqual([
      { content: 'Concise answers' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
