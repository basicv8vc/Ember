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
  type ModelApprovalRecord,
  type ModelRateRow,
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
  | CredentialRefusal
  | 'budget_config_invalid';

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
): ModelBudgetCeilings | null {
  const merged: ModelBudgetCeilings = { ...DEFAULT_MODEL_CEILINGS, ...overrides };

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
 * 2. the model id is in the code-owned allowlist (empty in the merged tree);
 * 3. that entry carries an approval record that is effective **today** — dated, named, unexpired;
 * 4. an `invoice_verified` rate row exists for that exact model id, and the snapshot's announced
 *    shutdown day has not arrived;
 * 5. a usable credential is bound.
 *
 * Gate 3 is what keeps "approved" from decaying into "approved once, forever": the record expires,
 * so a running Alpha re-proves its permission instead of inheriting it.
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
  const ceilings = resolveCeilings(input.ceilings);

  const settings: ModelExecutionSettings = Object.freeze({
    mode: mode ?? 'disabled',
    providerId: 'openai',
    modelId: input.modelId?.trim() ?? null,
    ceilings: ceilings ?? DEFAULT_MODEL_CEILINGS,
    maxAttempts: boundedInteger(
      input.maxAttempts,
      MODEL_LIMITS.maxAttemptsPerTurn,
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
  const provider = input.providerId?.trim() ?? 'openai';

  if (!APPROVED_MODEL_PROVIDERS.includes(provider)) {
    return { ok: false, mode, settings, reason: 'provider_not_approved' };
  }

  const modelId = input.modelId?.trim() ?? '';

  if (modelId.length === 0 || modelId.includes(MODEL_ID_PLACEHOLDER)) {
    return { ok: false, mode, settings, reason: 'model_not_approved' };
  }

  const modelApproved = registry.models.find(
    (entry) => entry.providerId === provider && entry.modelId === modelId,
  );

  if (modelApproved === undefined) {
    return { ok: false, mode, settings, reason: 'model_not_approved' };
  }

  // The allowlist entry is a *record*, not a flag: it must name who decided, when, and until when.
  if (evaluateApproval(modelApproved.approval, now) !== 'effective') {
    return { ok: false, mode, settings, reason: 'approval_not_effective' };
  }

  const rate = findRateRow(registry.rates, provider, modelId);

  if (rate === null || rate.provenance !== 'invoice_verified') {
    return { ok: false, mode, settings, reason: 'rate_not_verified' };
  }

  // A snapshot the provider has already retired cannot serve a request, so paying for the attempt is
  // pointless: refuse before egress rather than discover it as a 404 after a reservation.
  if (isPastShutdown(rate, now)) {
    return { ok: false, mode, settings, reason: 'model_shutdown' };
  }

  const credential = ModelCredential.parse(input.apiKey);

  if (!credential.ok) {
    return { ok: false, mode, settings, reason: credential.reason };
  }

  return {
    ok: true,
    mode,
    settings: Object.freeze({ ...settings, mode, modelId }),
    rate,
    approval: modelApproved.approval,
    credential: credential.credential,
  };
}

/** True when a resolution may issue paid provider calls. */
export function isRealExecution(
  resolution: ModelExecutionResolution,
): resolution is Extract<ModelExecutionResolution, { ok: true; mode: 'real' }> {
  return resolution.ok && resolution.mode === 'real';
}
