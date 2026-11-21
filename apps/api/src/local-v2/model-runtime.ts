import { DomainError } from '@ember/domain';
import {
  FAKE_MODEL_LABEL,
  FAKE_V2_RATE_VERSION,
  FakeStreamingModelGateway,
  LoopbackFakeModelGateway,
  MODEL_LIMITS,
  ModelGatewayFailure,
  createModelGateway,
  estimateCostMicroUsd,
  preflightConversationTurn,
  resolveModelExecution,
  type ConversationTurnOutput,
  type FakeConversationJob,
  type FakeConversationJobStatus,
  type FakeConversationStreamRequest,
  type FetchLike,
  type ModelBudgetCeilings,
  type ModelCallResult,
  type ModelGateway,
  type ModelRateRow,
  type PythonAgentStepInput,
  type PythonAgentStepOutput,
} from '@ember/model-gateway';
import {
  V2_BUDGET_LIMITS,
  type B2TaskDelegationCommand,
  type LocalBudgetCeilings,
  type ModelReservationInput,
} from '@ember/runtime-v2';
import {
  resolveV2SandboxConfig,
  type V2SandboxConfig,
  type V2SandboxEnv,
} from './runtime-config.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_INT_REGEX = /^\d+$/;

export type V2ConversationStreamEvent =
  | { readonly kind: 'job'; readonly handle: string }
  | { readonly kind: 'progress' }
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'result'; readonly result: ModelCallResult<ConversationTurnOutput> };

export interface V2StreamingModelGateway {
  readonly providerId?: 'fake' | 'openai' | 'openrouter';
  readonly modelLabel?: string;
  readonly simulated?: boolean;
  streamConversationTurn(
    request: FakeConversationStreamRequest,
    signal: AbortSignal,
  ): AsyncGenerator<V2ConversationStreamEvent, void>;
  queryConversationJob(
    operationId: string,
    handle: string,
    signal: AbortSignal,
  ): Promise<FakeConversationJobStatus>;
  stepPythonAgent?(
    input: PythonAgentStepInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<PythonAgentStepOutput>>;
}

export interface V2ModelRuntimeEnv extends V2SandboxEnv {
  readonly EMBER_ENV: string;
  readonly NODE_ENV?: string;
  readonly EMBER_MODEL_MODE: string;
  readonly EMBER_V2_ISOLATED_HARNESS?: string;
  readonly EMBER_V2_STAGING_ISOLATED?: string;
  readonly FAKE_MODEL_GATEWAY_URL?: string;
  readonly EMBER_MODEL_PROVIDER?: string;
  readonly EMBER_MODEL_ID?: string;
  readonly EMBER_MODEL_API_KEY?: string;
  readonly EMBER_MODEL_ALPHA_SCOPE?: string;
  readonly EMBER_MODEL_ALPHA_TENANT_IDS?: string;
  readonly EMBER_MODEL_ATTEMPT_TIMEOUT_MS?: string;
  readonly EMBER_MODEL_TURN_LEASE_MS?: string;
  readonly EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD?: string;
  readonly EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD?: string;
  readonly EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD?: string;
  readonly EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD?: string;
  readonly EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS?: string;
  readonly GLOBAL_DAILY_CEILING_MICRO_USD?: string;
}

export interface V2ModelRuntime {
  readonly mode: 'fake' | 'real';
  readonly sandboxConfig: V2SandboxConfig;
  readonly gateway: V2StreamingModelGateway;
  readonly providerId: 'fake' | 'openai' | 'openrouter';
  readonly modelLabel: string;
  readonly rateVersion: string;
  readonly rate: ModelRateRow | null;
  readonly simulated: boolean;
  readonly budgetMode: 'simulated_full_protocol' | 'real';
  readonly attemptTimeoutMs: number;
  readonly perAttemptCeilingMicroUsd: number;
  isTenantAuthorized(tenantId: string): boolean;
  getTurnReservation(): ModelReservationInput;
  estimateBriefReservation(prompt: string): number;
}

export interface ResolveV2ModelRuntimeOptions {
  /** Test-only transport substitution for real providers. Never overrides provider URL. */
  readonly fetchImpl?: FetchLike;
  /** Test-only fake gateway injection. */
  readonly fakeGateway?: V2StreamingModelGateway;
  readonly now?: () => Date;
}

function createInWorkerFakeGateway(): V2StreamingModelGateway {
  const jobs = new Map<string, FakeConversationJob>();
  return new FakeStreamingModelGateway(
    {
      create(job: FakeConversationJob) {
        if ([...jobs.values()].some((stored) => stored.operationId === job.operationId)) {
          return Promise.reject(new Error('operation exists'));
        }
        jobs.set(job.handle, job);
        return Promise.resolve();
      },
      get(handle: string) {
        return Promise.resolve(jobs.get(handle) ?? null);
      },
      findByOperationId(operationId: string) {
        return Promise.resolve(
          [...jobs.values()].find((job) => job.operationId === operationId) ?? null,
        );
      },
    },
    { reasoningMs: 0, usageCostMicroUsd: 0 },
  );
}

function parseBoundedInt(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (!SAFE_INT_REGEX.test(trimmed)) {
    throw new Error(`Invalid integer config for ${name}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Out-of-range integer config for ${name}`);
  }
  return value;
}

/**
 * Resolve optional local AgentHeadDO spend ceiling overrides from Worker env.
 * Returns undefined when no overrides are configured so AgentHeadCore uses its defaults.
 */
export function resolveV2LocalCeilings(
  env: Pick<
    V2ModelRuntimeEnv,
    | 'EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD'
    | 'EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD'
    | 'EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD'
    | 'EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS'
  >,
): LocalBudgetCeilings | undefined {
  const perAttemptMicroUsd = parseBoundedInt(
    env.EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD,
    'EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD',
    1,
    V2_BUDGET_LIMITS.perAttemptMicroUsd,
  );
  const principalDailyMicroUsd = parseBoundedInt(
    env.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD,
    'EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD',
    0,
    V2_BUDGET_LIMITS.principalDailyMicroUsd,
  );
  const tenantDailyMicroUsd = parseBoundedInt(
    env.EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD,
    'EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD',
    0,
    V2_BUDGET_LIMITS.tenantDailyMicroUsd,
  );
  const principalDailyTurns = parseBoundedInt(
    env.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS,
    'EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS',
    0,
    V2_BUDGET_LIMITS.principalDailyTurns,
  );

  if (
    perAttemptMicroUsd === undefined &&
    principalDailyMicroUsd === undefined &&
    tenantDailyMicroUsd === undefined &&
    principalDailyTurns === undefined
  ) {
    return undefined;
  }

  const resolved: LocalBudgetCeilings = {
    perAttemptMicroUsd: perAttemptMicroUsd ?? V2_BUDGET_LIMITS.perAttemptMicroUsd,
    principalDailyMicroUsd: principalDailyMicroUsd ?? V2_BUDGET_LIMITS.principalDailyMicroUsd,
    tenantDailyMicroUsd: tenantDailyMicroUsd ?? V2_BUDGET_LIMITS.tenantDailyMicroUsd,
    principalDailyTurns: principalDailyTurns ?? V2_BUDGET_LIMITS.principalDailyTurns,
  };
  if (resolved.principalDailyMicroUsd > resolved.tenantDailyMicroUsd) {
    throw new Error('principalDailyMicroUsd cannot exceed tenantDailyMicroUsd');
  }
  return Object.freeze(resolved);
}

/**
 * Resolve the effective global daily ceiling, ensuring `GLOBAL_DAILY_CEILING_MICRO_USD` (which
 * `GlobalBudgetDO` reads directly) is never looser than `EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD`.
 */
export function resolveV2GlobalCeilingOverride(
  env: Pick<
    V2ModelRuntimeEnv,
    'GLOBAL_DAILY_CEILING_MICRO_USD' | 'EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD'
  >,
): number | undefined {
  const platformCeiling = parseBoundedInt(
    env.GLOBAL_DAILY_CEILING_MICRO_USD,
    'GLOBAL_DAILY_CEILING_MICRO_USD',
    0,
    V2_BUDGET_LIMITS.globalDailyMicroUsd,
  );
  const modelCeiling = parseBoundedInt(
    env.EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD,
    'EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD',
    0,
    V2_BUDGET_LIMITS.globalDailyMicroUsd,
  );
  if (modelCeiling !== undefined) {
    const effectivePlatformCeiling = platformCeiling ?? V2_BUDGET_LIMITS.globalDailyMicroUsd;
    if (effectivePlatformCeiling > modelCeiling) {
      throw new Error(
        'GLOBAL_DAILY_CEILING_MICRO_USD must be set and <= EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD so GlobalBudgetDO and AgentHeadDO share the same ceiling',
      );
    }
    return effectivePlatformCeiling;
  }
  return platformCeiling;
}

function resolveTenantAllowlist(
  env: Pick<V2ModelRuntimeEnv, 'EMBER_MODEL_ALPHA_SCOPE' | 'EMBER_MODEL_ALPHA_TENANT_IDS'>,
): { readonly scope: 'allowlist'; readonly tenantIds: ReadonlySet<string> } {
  const rawScope = env.EMBER_MODEL_ALPHA_SCOPE?.trim().toLowerCase();
  if (rawScope !== undefined && rawScope.length > 0 && rawScope !== 'allowlist') {
    throw new Error(
      `EMBER_MODEL_ALPHA_SCOPE=${JSON.stringify(env.EMBER_MODEL_ALPHA_SCOPE)} is refused for V2 real canary; only "allowlist" is permitted`,
    );
  }
  const rawIds = env.EMBER_MODEL_ALPHA_TENANT_IDS?.trim() ?? '';
  if (rawIds.length === 0) {
    throw new Error(
      'EMBER_MODEL_ALPHA_TENANT_IDS is required when EMBER_MODEL_ALPHA_SCOPE=allowlist',
    );
  }
  const ids = rawIds.split(',').map((entry) => entry.trim().toLowerCase());
  if (ids.length === 0 || ids.length > 100 || ids.some((id) => !UUID_REGEX.test(id))) {
    throw new Error('Invalid UUID in EMBER_MODEL_ALPHA_TENANT_IDS');
  }
  return { scope: 'allowlist', tenantIds: new Set(ids) };
}

/**
 * Wrap a single-shot `ModelGateway` (`OpenAiModelGateway` / `OpenRouterModelGateway`) into the
 * V2 streaming/durable gateway interface without inventing a fake provider job handle.
 * Never yields `{ kind: 'job' }`, so interrupted in-flight requests retain conservative
 * unknown-outcome handling and are never blindly replayed.
 * Also exposes `stepPythonAgent` from the real `ModelGateway` for F's runner.
 */
export function adaptModelGatewayForV2(
  gateway: ModelGateway,
  attemptTimeoutMs: number,
): V2StreamingModelGateway {
  if (gateway.providerId === 'fake' || gateway.simulated) {
    throw new Error(
      'adaptModelGatewayForV2 is strictly for real non-simulated ModelGateway instances',
    );
  }
  return {
    providerId: gateway.providerId,
    modelLabel: gateway.modelLabel,
    simulated: false,
    async *streamConversationTurn(request, signal) {
      signal.throwIfAborted();
      const remainingMs = request.deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        // Deadline already elapsed before egress; abort cleanly before fetch.
        throw new ModelGatewayFailure('model_timeout');
      }
      const timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, remainingMs));
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
      const result = await gateway.generateConversationTurn(request.input, combinedSignal);
      signal.throwIfAborted();
      if (result.output.kind === 'reply' && result.output.text.length > 0) {
        yield { kind: 'delta', text: result.output.text };
      }
      yield { kind: 'result', result };
    },
    queryConversationJob() {
      // Single-shot Chat Completions has no resumable provider-side job handle.
      return Promise.resolve({ state: 'unavailable' });
    },
    stepPythonAgent(input, signal) {
      signal.throwIfAborted();
      const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]);
      return gateway.stepPythonAgent(input, combinedSignal);
    },
  };
}

/**
 * Resolve V2 model & sandbox runtime from Worker env. Fails closed on disabled, unapproved,
 * expired, unverified-price, invalid-credential, or missing-allowlist configurations.
 */
export function resolveV2ModelRuntime(
  env: V2ModelRuntimeEnv,
  options: ResolveV2ModelRuntimeOptions = {},
): V2ModelRuntime {
  const sandboxConfig = resolveV2SandboxConfig(env);
  const fakeReservationMicroUsd = 250;

  if (env.EMBER_MODEL_MODE === 'fake') {
    let gateway: V2StreamingModelGateway;
    if (options.fakeGateway !== undefined) {
      gateway = options.fakeGateway;
    } else if (['local', 'test', 'ci'].includes(env.EMBER_ENV)) {
      if (env.EMBER_V2_ISOLATED_HARNESS !== 'true' || !env.FAKE_MODEL_GATEWAY_URL) {
        throw new Error('Expected isolated V2 runtime with fake model gateway');
      }
      gateway = new LoopbackFakeModelGateway(env.FAKE_MODEL_GATEWAY_URL);
    } else if (env.EMBER_ENV === 'v2-staging' && env.EMBER_V2_STAGING_ISOLATED === 'true') {
      gateway = createInWorkerFakeGateway();
    } else {
      throw new Error('Expected isolated V2 runtime with fake model gateway');
    }

    return {
      mode: 'fake',
      sandboxConfig,
      gateway,
      providerId: 'fake',
      modelLabel: FAKE_MODEL_LABEL,
      rateVersion: FAKE_V2_RATE_VERSION,
      rate: null,
      simulated: true,
      budgetMode: 'simulated_full_protocol',
      attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
      perAttemptCeilingMicroUsd: V2_BUDGET_LIMITS.perAttemptMicroUsd,
      isTenantAuthorized: () => true,
      getTurnReservation: () => ({
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: FAKE_MODEL_LABEL,
        rateVersion: FAKE_V2_RATE_VERSION,
        maxAttempts: 1,
        estimatedMicroUsd: fakeReservationMicroUsd,
      }),
      estimateBriefReservation: () => fakeReservationMicroUsd,
    };
  }

  if (env.EMBER_MODEL_MODE !== 'real') {
    throw new Error(`V2 model execution refused: mode=${JSON.stringify(env.EMBER_MODEL_MODE)}`);
  }

  const isIsolatedStaging =
    env.EMBER_ENV === 'v2-staging' && env.EMBER_V2_STAGING_ISOLATED === 'true';
  const isTestHarness =
    ['local', 'test'].includes(env.EMBER_ENV) &&
    env.EMBER_V2_ISOLATED_HARNESS === 'true' &&
    options.fetchImpl !== undefined;
  if (!isIsolatedStaging && !isTestHarness) {
    throw new Error('V2 real model execution requires isolated v2-staging environment');
  }
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new Error('V2 real model execution refused in production NODE_ENV');
  }

  const tenantAllowlist = resolveTenantAllowlist(env);
  const localCeilings = resolveV2LocalCeilings(env);
  const globalCeiling = resolveV2GlobalCeilingOverride(env);
  const attemptTimeoutMs = parseBoundedInt(
    env.EMBER_MODEL_ATTEMPT_TIMEOUT_MS,
    'EMBER_MODEL_ATTEMPT_TIMEOUT_MS',
    1_000,
    MODEL_LIMITS.turnDeadlineMs,
  );
  const leaseMs = parseBoundedInt(
    env.EMBER_MODEL_TURN_LEASE_MS,
    'EMBER_MODEL_TURN_LEASE_MS',
    1_000,
    MODEL_LIMITS.turnDeadlineMs,
  );

  const ceilings: Partial<ModelBudgetCeilings> = {
    ...(localCeilings === undefined
      ? {}
      : {
          perAttemptMicroUsd: localCeilings.perAttemptMicroUsd,
          principalDailyMicroUsd: localCeilings.principalDailyMicroUsd,
          tenantDailyMicroUsd: localCeilings.tenantDailyMicroUsd,
          principalDailyTurns: localCeilings.principalDailyTurns,
        }),
    ...(globalCeiling === undefined ? {} : { globalDailyMicroUsd: globalCeiling }),
  };

  const resolution = resolveModelExecution(
    {
      mode: 'real',
      providerId: env.EMBER_MODEL_PROVIDER,
      modelId: env.EMBER_MODEL_ID,
      apiKey: env.EMBER_MODEL_API_KEY,
      executionPurpose: 'staging_alpha',
      ceilings,
      maxAttempts: 1,
      attemptTimeoutMs,
      leaseMs,
    },
    undefined,
    options.now?.() ?? new Date(),
  );

  if (!resolution.ok || resolution.mode !== 'real') {
    const reason = resolution.ok ? 'invalid_mode' : resolution.reason;
    throw new Error(`V2 real model execution refused: ${reason}`);
  }
  if (
    resolution.executionScope !== 'staging_alpha' ||
    resolution.settings.maxAttempts !== 1 ||
    resolution.settings.modelId === null
  ) {
    throw new Error('V2 real model execution requires staging_alpha single-attempt authorization');
  }

  const modelId = resolution.settings.modelId;
  const providerId = resolution.settings.providerId;
  const rate = resolution.rate;
  const perAttemptCeiling = resolution.settings.ceilings.perAttemptMicroUsd;
  const rawGateway = createModelGateway(
    resolution,
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  );
  const gateway = adaptModelGatewayForV2(rawGateway, resolution.settings.attemptTimeoutMs);

  return {
    mode: 'real',
    sandboxConfig,
    gateway,
    providerId,
    modelLabel: modelId,
    rateVersion: rate.rateVersion,
    rate,
    simulated: false,
    budgetMode: 'real',
    attemptTimeoutMs: resolution.settings.attemptTimeoutMs,
    perAttemptCeilingMicroUsd: perAttemptCeiling,
    isTenantAuthorized(tenantId: string) {
      return tenantAllowlist.tenantIds.has(tenantId.trim().toLowerCase());
    },
    getTurnReservation() {
      const estimatedMicroUsd = estimateCostMicroUsd(
        rate,
        MODEL_LIMITS.maxInputTokens,
        MODEL_LIMITS.maxOutputTokens,
      );
      if (estimatedMicroUsd > perAttemptCeiling) {
        throw new DomainError(
          'BUDGET_EXCEEDED',
          'worst-case turn reservation exceeds per-attempt budget ceiling',
        );
      }
      return {
        budgetMode: 'real',
        providerId,
        modelLabel: modelId,
        rateVersion: rate.rateVersion,
        maxAttempts: 1,
        estimatedMicroUsd,
      };
    },
    estimateBriefReservation(prompt: string) {
      const preflight = preflightConversationTurn({
        messages: [{ role: 'user', text: prompt }],
        allowDelegationTools: false,
        maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
      });
      const estimatedMicroUsd = estimateCostMicroUsd(
        rate,
        preflight.inputTokens,
        preflight.maxOutputTokens,
      );
      if (estimatedMicroUsd > perAttemptCeiling) {
        throw new DomainError(
          'BUDGET_EXCEEDED',
          'proactive brief reservation exceeds per-attempt budget ceiling',
        );
      }
      return estimatedMicroUsd;
    },
  };
}

/** Map a `delegate` `ConversationTurnOutput` into the authoritative `B2TaskDelegationCommand`. */
export function toV2DelegationCommand(
  output: ConversationTurnOutput,
): B2TaskDelegationCommand | undefined {
  if (output.kind !== 'delegate') return undefined;
  if (output.delegation.toolName === 'delegate_python_agent') {
    const args = output.delegation.arguments;
    return {
      toolName: 'delegate_python_agent',
      ...(args.title === undefined ? {} : { title: args.title }),
      input: {
        prompt: args.prompt,
        ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
        ...(args.attachmentIds === undefined || args.attachmentIds.length === 0
          ? {}
          : { attachmentIds: args.attachmentIds }),
      },
    };
  }
  const args = output.delegation.arguments;
  return {
    toolName: output.delegation.toolName,
    ...(args.title === undefined ? {} : { title: args.title }),
    input: {
      notes: args.notes,
      ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
    },
  };
}
