import { ModelCredential, type CredentialRefusal } from './credentials.js';
import { MODEL_BUDGET_ABSOLUTE_CEILINGS, MODEL_LIMITS } from './limits.js';
import {
  APPROVED_MODEL_PROVIDERS,
  APPROVED_REAL_MODELS,
  MODEL_ID_PLACEHOLDER,
  MODEL_RATE_ROWS,
  evaluateApproval,
  findRateRow,
  isPastShutdown,
  type ApprovedModel,
  type ModelApprovalBudgetCeilings,
  type ModelApprovalRecord,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
} from './rates.js';
import type { ModelExecutionMode, ModelProviderId } from './types.js';

export interface ModelBudgetCeilings {
  /** Largest reservation one attempt may hold, in micro-USD. */
  readonly perAttemptMicroUsd: number;
  readonly principalDailyMicroUsd: number;
  readonly tenantDailyMicroUsd: number;
  readonly globalDailyMicroUsd: number;
  readonly principalDailyTurns: number;
}

export interface ModelExecutionSettings {
  readonly mode: ModelExecutionMode;
  readonly providerId: ModelProviderId;
  readonly modelId: string | null;
  readonly ceilings: ModelBudgetCeilings;
  readonly maxAttempts: number;
  readonly attemptTimeoutMs: number;
  readonly turnDeadlineMs: number;
  readonly leaseMs: number;
}

export const DEFAULT_MODEL_CEILINGS: ModelBudgetCeilings = Object.freeze({
  perAttemptMicroUsd: MODEL_LIMITS.maxReservedMicroUsdPerAttempt,
  principalDailyMicroUsd: MODEL_LIMITS.defaultPrincipalDailyMicroUsd,
  tenantDailyMicroUsd: MODEL_LIMITS.defaultTenantDailyMicroUsd,
  globalDailyMicroUsd: MODEL_LIMITS.defaultGlobalDailyMicroUsd,
  principalDailyTurns: MODEL_LIMITS.defaultPrincipalDailyTurns,
});

export type ModelBootRefusalReason =
  | 'mode_invalid'
  | 'provider_not_approved'
  | 'model_not_approved'
  | 'approval_not_effective'
  | 'model_shutdown'
  | 'rate_not_verified'
  | 'provider_routing_not_approved'
  | 'execution_scope_refused'
  | 'attempt_limit_approval_exceeded'
  | 'budget_approval_exceeded'
  | CredentialRefusal
  | 'budget_config_invalid';

export type ModelExecutionPurpose = 'resident_worker' | 'paid_smoke' | 'staging_alpha';

/** Code-owned allowlists. Tests may supply their own registry; the process root never does. */
export interface ModelApprovalRegistry {
  readonly models: readonly ApprovedModel[];
  readonly rates: readonly ModelRateRow[];
}

export const DEFAULT_MODEL_APPROVAL_REGISTRY: ModelApprovalRegistry = Object.freeze({
  models: APPROVED_REAL_MODELS,
  rates: MODEL_RATE_ROWS,
});

export interface ModelExecutionInput {
  readonly mode?: string | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly apiKey?: string | undefined;
  /** Supplied by trusted code call sites only; never read from process environment or CLI args. */
  readonly executionPurpose?: ModelExecutionPurpose | undefined;
  readonly ceilings?: Partial<ModelBudgetCeilings> | undefined;
  readonly maxAttempts?: number | undefined;
  readonly attemptTimeoutMs?: number | undefined;
  readonly leaseMs?: number | undefined;
}

export type ModelExecutionResolution =
  | {
      readonly ok: true;
      readonly mode: 'disabled';
      readonly settings: ModelExecutionSettings;
    }
  | {
      readonly ok: true;
      readonly mode: 'fake';
      readonly settings: ModelExecutionSettings;
    }
  | {
      readonly ok: true;
      readonly mode: 'real';
      readonly settings: ModelExecutionSettings;
      readonly rate: ModelRateRow;
      /**
       * The record that authorised this process to spend.
       *
       * Carried so an operator tool can restate *which* decision it is acting under (the paid smoke
       * test compares it to what it was told on the command line). It is a decision id, not a secret.
       */
      readonly approval: ModelApprovalRecord;
      readonly executionScope: ApprovedModel['executionScope'] | 'staging_alpha';
      readonly maxPaidSmokeTurns: number;
      readonly openRouterRouting: OpenRouterRoutingPolicy | null;
      readonly credential: ModelCredential;
    }
  | {
      readonly ok: false;
      readonly mode: ModelExecutionMode;
      readonly settings: ModelExecutionSettings;
      readonly reason: ModelBootRefusalReason;
    };

function resolveMode(raw: string | undefined): ModelExecutionMode | null {
  if (raw === undefined || raw.trim().length === 0) {
    return 'disabled';
  }

  const value = raw.trim();

  return value === 'disabled' || value === 'fake' || value === 'real' ? value : null;
}

function resolveCeilings(
  overrides: Partial<ModelBudgetCeilings> | undefined,
  defaults: ModelBudgetCeilings = DEFAULT_MODEL_CEILINGS,
): ModelBudgetCeilings | null {
  const merged: ModelBudgetCeilings = { ...defaults, ...overrides };

  const entries: readonly (readonly [keyof ModelBudgetCeilings, number])[] = [
    ['perAttemptMicroUsd', merged.perAttemptMicroUsd],
    ['principalDailyMicroUsd', merged.principalDailyMicroUsd],
    ['tenantDailyMicroUsd', merged.tenantDailyMicroUsd],
    ['globalDailyMicroUsd', merged.globalDailyMicroUsd],
    ['principalDailyTurns', merged.principalDailyTurns],
  ];

  for (const [name, value] of entries) {
    // A limit of 0 is legal and means "deny every paid call"; negative or fractional is a bug.
    if (!Number.isInteger(value) || value < 0) {
      return null;
    }

    if (value > MODEL_BUDGET_ABSOLUTE_CEILINGS[name]) {
      return null;
    }
  }

  if (merged.perAttemptMicroUsd < 1) {
    return null;
  }

  // An allowance never overrides a ceiling: principal ≤ tenant ≤ global.
  if (merged.principalDailyMicroUsd > merged.tenantDailyMicroUsd) {
    return null;
  }

  if (merged.tenantDailyMicroUsd > merged.globalDailyMicroUsd) {
    return null;
  }

  return Object.freeze(merged);
}

function exceedsApprovedCeilings(
  runtime: ModelBudgetCeilings,
  approved: ModelApprovalBudgetCeilings,
): boolean {
  return (
    runtime.perAttemptMicroUsd > approved.perAttemptMicroUsd ||
    runtime.principalDailyMicroUsd > approved.principalDailyMicroUsd ||
    runtime.tenantDailyMicroUsd > approved.tenantDailyMicroUsd ||
    runtime.globalDailyMicroUsd > approved.globalDailyMicroUsd ||
    runtime.principalDailyTurns > approved.principalDailyTurns
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }

  return value;
}

/**
 * Resolve the configured execution mode into either a runnable setting or an explicit refusal.
 *
 * `real` requires five independent gates, and no configuration can substitute one for another:
 * 1. the provider is in the code-owned allowlist;
 * 2. the model id is in the code-owned allowlist as one exact approved entry;
 * 3. that entry carries an effective approval record — dated and named, with an optional expiry;
 * 4. a price row exists for that exact model id with official published pricing explicitly
 *    reviewed (or an invoice has been verified), and the snapshot's shutdown day has not arrived;
 * 5. a usable credential is bound.
 *
 * Provider/model/routing pins, tenant allowlists, and ledger ceilings bound standing internal grants.
 *
 * There is deliberately no branch that turns `real` into `fake`: a process configured for real
 * inference that cannot deliver it must be dead and visible, never silently canned.
 */
export function resolveModelExecution(
  input: ModelExecutionInput,
  registry: ModelApprovalRegistry = DEFAULT_MODEL_APPROVAL_REGISTRY,
  now: Date = new Date(),
): ModelExecutionResolution {
  const mode = resolveMode(input.mode);
  const configuredProvider = input.providerId?.trim() ?? 'openai';
  const configuredModelId = input.modelId?.trim() ?? '';
  const executionPurpose = input.executionPurpose ?? 'resident_worker';
  const modelApproval = registry.models.find(
    (entry) => entry.providerId === configuredProvider && entry.modelId === configuredModelId,
  );
  const stagingAlphaApproval =
    executionPurpose === 'staging_alpha' ? modelApproval?.stagingAlpha : undefined;
  const modelAuthorization =
    modelApproval === undefined
      ? undefined
      : stagingAlphaApproval === undefined
        ? {
            ...modelApproval,
            maxProviderAttemptsPerTurn: MODEL_LIMITS.maxAttemptsPerTurn,
          }
        : {
            ...modelApproval,
            approval: stagingAlphaApproval.approval,
            executionScope: 'staging_alpha' as const,
            budgetCeilings: stagingAlphaApproval.budgetCeilings,
            maxProviderAttemptsPerTurn: stagingAlphaApproval.maxProviderAttemptsPerTurn,
          };
  const budgetDefaults =
    stagingAlphaApproval?.budgetCeilings ??
    (executionPurpose === 'paid_smoke' && modelApproval?.executionScope === 'smoke_only'
      ? modelApproval.budgetCeilings
      : DEFAULT_MODEL_CEILINGS);
  const ceilings = resolveCeilings(input.ceilings, budgetDefaults);
  const providerId: ModelProviderId = configuredProvider === 'openrouter' ? 'openrouter' : 'openai';

  const settings: ModelExecutionSettings = Object.freeze({
    mode: mode ?? 'disabled',
    providerId,
    modelId: input.modelId?.trim() ?? null,
    ceilings: ceilings ?? DEFAULT_MODEL_CEILINGS,
    maxAttempts: boundedInteger(
      input.maxAttempts,
      modelAuthorization?.maxProviderAttemptsPerTurn ?? MODEL_LIMITS.maxAttemptsPerTurn,
      1,
      MODEL_LIMITS.maxAttemptsPerTurn,
    ),
    attemptTimeoutMs: boundedInteger(
      input.attemptTimeoutMs,
      MODEL_LIMITS.attemptTimeoutMs,
      1_000,
      MODEL_LIMITS.turnDeadlineMs,
    ),
    turnDeadlineMs: MODEL_LIMITS.turnDeadlineMs,
    leaseMs: boundedInteger(input.leaseMs, 30_000, 1_000, MODEL_LIMITS.turnDeadlineMs),
  });

  if (mode === null) {
    return { ok: false, mode: 'disabled', settings, reason: 'mode_invalid' };
  }

  // A budget that exceeds the database ceiling or inverts principal ≤ tenant ≤ global is a
  // configuration defect in every mode, not only when a paid call is about to be made.
  if (ceilings === null) {
    return { ok: false, mode, settings, reason: 'budget_config_invalid' };
  }

  if (mode === 'disabled') {
    return { ok: true, mode, settings };
  }

  if (mode === 'fake') {
    return { ok: true, mode, settings };
  }

  // ---- mode === 'real': every gate below is required ----
  const provider = configuredProvider;

  if (!APPROVED_MODEL_PROVIDERS.includes(provider)) {
    return { ok: false, mode, settings, reason: 'provider_not_approved' };
  }

  const modelId = input.modelId?.trim() ?? '';

  if (modelId.length === 0 || modelId.includes(MODEL_ID_PLACEHOLDER)) {
    return { ok: false, mode, settings, reason: 'model_not_approved' };
  }

  const modelApproved = modelAuthorization;

  if (modelApproved === undefined) {
    return { ok: false, mode, settings, reason: 'model_not_approved' };
  }

  if (executionPurpose === 'staging_alpha' && stagingAlphaApproval === undefined) {
    return { ok: false, mode, settings, reason: 'execution_scope_refused' };
  }

  if (modelApproved.executionScope === 'smoke_only' && executionPurpose !== 'paid_smoke') {
    return { ok: false, mode, settings, reason: 'execution_scope_refused' };
  }

  if (settings.maxAttempts > modelApproved.maxProviderAttemptsPerTurn) {
    return { ok: false, mode, settings, reason: 'attempt_limit_approval_exceeded' };
  }

  if (
    provider === 'openrouter' &&
    (!modelApproved.openRouterRouting ||
      modelApproved.openRouterRouting.allowFallbacks !== false ||
      modelApproved.openRouterRouting.dataCollection !== 'deny' ||
      modelApproved.openRouterRouting.zdr !== true ||
      modelApproved.openRouterRouting.requireParameters !== true ||
      !Array.isArray(modelApproved.openRouterRouting.only) ||
      modelApproved.openRouterRouting.only.length === 0 ||
      modelApproved.openRouterRouting.only.some(
        (route) => typeof route !== 'string' || route.trim().length === 0,
      ))
  ) {
    return { ok: false, mode, settings, reason: 'provider_routing_not_approved' };
  }

  // The allowlist entry is a *record*, not a flag: it must name who decided, when, and until when.
  if (evaluateApproval(modelApproved.approval, now) !== 'effective') {
    return { ok: false, mode, settings, reason: 'approval_not_effective' };
  }

  const rate = findRateRow(registry.rates, provider, modelId);

  if (
    rate === null ||
    (rate.provenance !== 'official_price_verified' && rate.provenance !== 'invoice_verified')
  ) {
    return { ok: false, mode, settings, reason: 'rate_not_verified' };
  }

  // A snapshot the provider has already retired cannot serve a request, so paying for the attempt is
  // pointless: refuse before egress rather than discover it as a 404 after a reservation.
  if (isPastShutdown(rate, now)) {
    return { ok: false, mode, settings, reason: 'model_shutdown' };
  }

  if (ceilings === null || exceedsApprovedCeilings(ceilings, modelApproved.budgetCeilings)) {
    return { ok: false, mode, settings, reason: 'budget_approval_exceeded' };
  }

  const credential = ModelCredential.parse(input.apiKey);

  if (!credential.ok) {
    return { ok: false, mode, settings, reason: credential.reason };
  }

  return {
    ok: true,
    mode,
    settings: Object.freeze({
      ...settings,
      mode,
      providerId: provider as ModelProviderId,
      modelId,
    }),
    rate,
    approval: modelApproved.approval,
    executionScope: modelApproved.executionScope,
    maxPaidSmokeTurns: modelApproved.maxPaidSmokeTurns,
    openRouterRouting: modelApproved.openRouterRouting ?? null,
    credential: credential.credential,
  };
}

/** Dynamic spend permission used at each provider boundary, including retries in a long-lived Worker. */
export function isModelExecutionAuthorized(
  resolution: Extract<ModelExecutionResolution, { readonly ok: true; readonly mode: 'real' }>,
  now: Date = new Date(),
): boolean {
  return (
    evaluateApproval(resolution.approval, now) === 'effective' &&
    (resolution.rate.provenance === 'official_price_verified' ||
      resolution.rate.provenance === 'invoice_verified') &&
    !isPastShutdown(resolution.rate, now)
  );
}

/** True when a resolution may issue paid provider calls. */
export function isRealExecution(
  resolution: ModelExecutionResolution,
): resolution is Extract<ModelExecutionResolution, { ok: true; mode: 'real' }> {
  return resolution.ok && resolution.mode === 'real';
}
