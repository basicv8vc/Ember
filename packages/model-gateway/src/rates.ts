import type { RealModelProviderId } from './types.js';

/**
 * A pin, not a preference.
 *
 * `real` mode may only use a model id that appears in `APPROVED_REAL_MODELS`. The OpenRouter
 * approval below pins one exact model and one reviewed upstream route. Smoke grants may expire;
 * the internal Ember Cloud grant is ongoing and remains bounded by its tenant allowlist and spend
 * ceilings.
 * The smoke grant remains time-limited and one-turn. Internal Ember Cloud execution has its own
 * tenant allowlist, daily ledger ceilings, and one provider attempt per Turn.
 */

/**
 * The recorded decision that allows one pinned model to be used.
 *
 * `expiresAt` is optional for a standing internal grant. A grant still names who approved it and
 * when; provider, model, route, tenant scope, and spend ceilings remain pinned in code/config.
 */
export interface ModelApprovalRecord {
  /** Enablement review id, e.g. `L4B-A1`. Matches the approval table in the review document. */
  readonly approvalId: string;
  /** The human accountable for the decision, by name or role. Never a team alias. */
  readonly approvedBy: string;
  /** `YYYY-MM-DD`, UTC. The day the decision was recorded. */
  readonly approvedAt: string;
  /** `YYYY-MM-DD`, UTC, inclusive. Omit only for a standing internal grant. */
  readonly expiresAt?: string;
}

/** Runtime spend ceilings reviewed together with a model approval. */
export interface ModelApprovalBudgetCeilings {
  readonly perAttemptMicroUsd: number;
  readonly principalDailyMicroUsd: number;
  readonly tenantDailyMicroUsd: number;
  readonly globalDailyMicroUsd: number;
  readonly principalDailyTurns: number;
}

/** Separate internal Ember Cloud grant for a model whose primary grant is Smoke-only. */
export interface StagingAlphaModelAuthorization {
  readonly approval: ModelApprovalRecord;
  readonly budgetCeilings: ModelApprovalBudgetCeilings;
  /** Required provider-side lifetime key limit; it is an operator gate, not an app-side ledger. */
  readonly externalApiKeySpendLimitUsd: 1;
  /** Hard limit per Turn; Queue retries never open another provider attempt. */
  readonly maxProviderAttemptsPerTurn: 1;
}

export interface ApprovedModel {
  readonly providerId: RealModelProviderId;
  readonly modelId: string;
  readonly approval: ModelApprovalRecord;
  /** A smoke-only approval cannot authorize a resident Worker. */
  readonly executionScope: 'resident' | 'smoke_only';
  readonly budgetCeilings: ModelApprovalBudgetCeilings;
  /** Turn count for `model:smoke`; independent of the principal's daily Turn budget. */
  readonly maxPaidSmokeTurns: number;
  /** Explicit internal Ember Cloud scope; never inherited by the resident Worker or Smoke CLI. */
  readonly stagingAlpha?: StagingAlphaModelAuthorization;
  /** Required for OpenRouter models; this policy is part of the reviewed model decision. */
  readonly openRouterRouting?: OpenRouterRoutingPolicy;
}

export interface OpenRouterRoutingPolicy {
  readonly only: readonly string[];
  readonly allowFallbacks: false;
  readonly dataCollection: 'deny';
  readonly zdr: true;
  readonly requireParameters: true;
}

/** One pinned OpenRouter model route. Runtime execution still requires an internal tenant allowlist. */
export const APPROVED_REAL_MODELS: readonly ApprovedModel[] = Object.freeze([
  Object.freeze({
    providerId: 'openrouter' as const,
    modelId: 'nvidia/nemotron-3.5-lightning',
    approval: Object.freeze({
      approvalId: 'L4C3-B2-OPENROUTER-DEEPINFRA-2026-11-11',
      approvedBy: 'CTO',
      approvedAt: '2026-11-11',
      expiresAt: '2026-11-12',
    }),
    executionScope: 'smoke_only' as const,
    budgetCeilings: Object.freeze({
      perAttemptMicroUsd: 5_000,
      principalDailyMicroUsd: 5_000,
      tenantDailyMicroUsd: 5_000,
      globalDailyMicroUsd: 5_000,
      principalDailyTurns: 1,
    }),
    maxPaidSmokeTurns: 1,
    stagingAlpha: Object.freeze({
      approval: Object.freeze({
        approvalId: 'EMBER-CLOUD-INTERNAL-MULTI-TURN',
        approvedBy: 'CTO',
        approvedAt: '2026-11-13',
      }),
      budgetCeilings: Object.freeze({
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 250_000,
        tenantDailyMicroUsd: 1_000_000,
        globalDailyMicroUsd: 1_000_000,
        principalDailyTurns: 60,
      }),
      externalApiKeySpendLimitUsd: 1 as const,
      maxProviderAttemptsPerTurn: 1 as const,
    }),
    openRouterRouting: Object.freeze({
      only: Object.freeze(['deepinfra']),
      allowFallbacks: false,
      dataCollection: 'deny' as const,
      zdr: true,
      requireParameters: true,
    }),
  }),
  Object.freeze({
    providerId: 'openrouter' as const,
    modelId: 'deepseek/deepseek-v4.1-flash-1017',
    approval: Object.freeze({
      approvalId: 'L4C4-B2-OPENROUTER-DEEPINFRA-VISION-2026-11-17',
      approvedBy: 'CTO',
      approvedAt: '2026-11-17',
      expiresAt: '2026-11-18',
    }),
    executionScope: 'smoke_only' as const,
    budgetCeilings: Object.freeze({
      perAttemptMicroUsd: 5_000,
      principalDailyMicroUsd: 5_000,
      tenantDailyMicroUsd: 5_000,
      globalDailyMicroUsd: 5_000,
      principalDailyTurns: 1,
    }),
    maxPaidSmokeTurns: 1,
    stagingAlpha: Object.freeze({
      approval: Object.freeze({
        approvalId: 'EMBER-CLOUD-INTERNAL-VISION-MULTI-TURN',
        approvedBy: 'CTO',
        approvedAt: '2026-11-17',
      }),
      budgetCeilings: Object.freeze({
        perAttemptMicroUsd: 5_000,
        principalDailyMicroUsd: 250_000,
        tenantDailyMicroUsd: 1_000_000,
        globalDailyMicroUsd: 1_000_000,
        principalDailyTurns: 60,
      }),
      externalApiKeySpendLimitUsd: 1 as const,
      maxProviderAttemptsPerTurn: 1 as const,
    }),
    openRouterRouting: Object.freeze({
      only: Object.freeze(['deepinfra']),
      allowFallbacks: false,
      dataCollection: 'deny' as const,
      zdr: true,
      requireParameters: true,
    }),
  }),
]);

/**
 * A nominated model that is **not** approved.
 *
 * It exists so the enablement review has a code-side anchor (a reviewer can diff the id, and a test
 * can prove the candidate is not usable), without turning "we wrote it down" into "we may spend".
 * Nothing in this package reads this list on a code path that can issue a request;
 * `resolveModelExecution` consults `APPROVED_REAL_MODELS` only, and a test asserts the two lists
 * never intersect.
 */
export interface ModelCandidate {
  readonly providerId: RealModelProviderId;
  readonly modelId: string;
  /** One sentence the review document expands; kept short so it cannot drift into a claim. */
  readonly rationale: string;
}

export const PENDING_MODEL_CANDIDATES: readonly ModelCandidate[] = Object.freeze([
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-5.6-luna',
    rationale:
      'direct OpenAI routing has not been approved; the current approval is OpenRouter-only',
  }),
]);

/**
 * Providers this build can construct an adapter for. Checked against **code**, not against tenant
 * policy: a misconfigured policy must not be able to point the gateway at a host nobody reviewed.
 * Kept separate from the model allowlist so an unapproved model reports `model_not_approved`
 * rather than masking the real reason as a provider problem.
 */
export const APPROVED_MODEL_PROVIDERS: readonly string[] = Object.freeze(['openai', 'openrouter']);

/** Documented placeholder: boot refuses any model id containing it. */
export const MODEL_ID_PLACEHOLDER = 'REPLACE-WITH-CTO-APPROVED-MODEL-ID';

/**
 * How much hidden reasoning a pinned model is allowed to spend inside `max_completion_tokens`.
 *
 * This is **not** a caller-facing parameter. It is a property of the pinned model, fixed in code
 * next to its price, because the two interact: on a reasoning model the reasoning tokens are billed
 * as output *and* are charged against the same completion allowance, so the gateway's 512-token cap
 * silently becomes "512 tokens of thinking and an empty reply" unless the effort is pinned too.
 */
export type ModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface ModelRateRow {
  readonly providerId: RealModelProviderId;
  readonly modelId: string;
  /** Optional canonical slug echoed by OpenRouter responses when `modelId` is a dated alias. */
  readonly canonicalModelId?: string;
  /** Micro-USD per one million input tokens (i.e. $0.25/1M → 250000). */
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
  /** Stable string stored per attempt, so historical spend keeps the price it was booked at. */
  readonly rateVersion: string;
  /**
   * `unverified` rows are recorded for arithmetic and provenance only. A `real` call requires a
   * `official_price_verified` or `invoice_verified` row for the exact pinned model id. Official
   * published pricing may be reviewed before the first call; an invoice is reconciled afterward.
   */
  readonly provenance: 'unverified' | 'official_price_verified' | 'invoice_verified';
  readonly source: string;
  /**
   * Provider-announced retirement day for this exact snapshot (`YYYY-MM-DD`), or `null`/absent when
   * none has been announced.
   *
   * It is a *refusal* input, not a note: a snapshot that is scheduled to stop serving is not a
   * candidate for a pinned Alpha, so `resolveModelExecution` refuses any row whose day has arrived.
   */
  readonly shutdownDate?: string | null;
  /** Pinned reasoning budget, or absent for a non-reasoning model (the field is then not sent). */
  readonly reasoningEffort?: ModelReasoningEffort;
  /** OpenRouter request-level cache policy for models whose published pricing has cache tiers. */
  readonly promptCacheMode?: 'explicit';
}

const UNVERIFIED_SOURCE =
  'secondary aggregator pages observed 2026-10/11 — not invoice-grade, see B2 proposal §8.1';

/**
 * Provider documentation read on **2026-11-07**: the `gpt-5-mini` model page states $0.25 input /
 * $2.00 output per 1M tokens, a 400 000-token context and Chat Completions support, and lists
 * `gpt-5-mini-2025-08-07` as a servable snapshot with no shutdown date. OpenAI later listed that
 * snapshot with a 2026-12-11 shutdown. The original page answered 403 to a direct fetch when first
 * read and was recorded as a search-result excerpt; this entry is now historical price provenance.
 */
const GPT_5_MINI_DOCS_SOURCE =
  'platform.openai.com/docs/models/gpt-5-mini, read 2026-11-07 via search excerpt — historical price';

/**
 * The provider deprecations page read on **2026-11-07**: on 2026-10-14 OpenAI announced that the
 * listed gpt-4o-mini and gpt-4.1-mini snapshots stop serving on **2027-01-14**. The older price rows
 * remain for historical accounting but are not Alpha candidates.
 */
const GPT_4_DEPRECATION_SOURCE =
  'developers.openai.com/api/docs/deprecations, read 2026-11-07 — shutdown 2027-01-14';

const GPT_5_6_LUNA_DOCS_SOURCE =
  'https://developers.openai.com/api/docs/models/gpt-5.6-luna, read 2026-11-10 — official published pricing; CTO review remains required';

const OPENROUTER_NEMOTRON_DEEPINFRA_SOURCE =
  'https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-lightning/endpoints and https://openrouter.ai/api/v1/endpoints/zdr, read 2026-11-11 — exact DeepInfra endpoint is listed for this model in the ZDR endpoint catalog; $0.06/M input and $0.16/M output';

const OPENROUTER_DEEPSEEK_V41_FLASH_DEEPINFRA_SOURCE =
  'https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints and https://openrouter.ai/api/v1/endpoints/zdr, read 2026-11-17 — exact DeepInfra fp8 ZDR endpoint supports image input + tools + tool_choice; $0.098/M input and $0.294/M output';

/**
 * Rate rows known to this tree.
 *
 * **No row here authorises a paid call.** `provenance` is the only field the resolver trusts, and
 * The approved OpenRouter route has a verified catalog price, but no combination of rate rows can
 * enable `real` mode without its separate, dated approval record in `APPROVED_REAL_MODELS`.
 * Approval item A2 requires explicitly reviewing official published pricing for the exact model id
 * before enablement; an invoice may be used instead. Provider usage is reconciled after the first call.
 *
 * The legacy rows are kept rather than deleted: they are the price history of models that may
 * already have been billed, and historical spend is not rewritten. They carry the retirement date
 * announced after they were added, so the resolver refuses them on its own once that day arrives.
 */
export const MODEL_RATE_ROWS: readonly ModelRateRow[] = Object.freeze([
  Object.freeze({
    providerId: 'openrouter' as const,
    modelId: 'nvidia/nemotron-3.5-lightning',
    inputMicroUsdPerMillion: 60_000,
    outputMicroUsdPerMillion: 160_000,
    rateVersion: 'openrouter-nvidia-nemotron-3.5-lightning-deepinfra-bf16-2026-11-11',
    provenance: 'official_price_verified' as const,
    source: OPENROUTER_NEMOTRON_DEEPINFRA_SOURCE,
    shutdownDate: null,
    reasoningEffort: 'none' as const,
  }),
  Object.freeze({
    providerId: 'openrouter' as const,
    modelId: 'deepseek/deepseek-v4.1-flash-1017',
    canonicalModelId: 'deepseek/deepseek-v4.1-flash-20261017',
    inputMicroUsdPerMillion: 98_000,
    outputMicroUsdPerMillion: 294_000,
    rateVersion: 'openrouter-deepseek-v4.1-flash-1017-deepinfra-fp8-2026-11-17',
    provenance: 'official_price_verified' as const,
    source: OPENROUTER_DEEPSEEK_V41_FLASH_DEEPINFRA_SOURCE,
    shutdownDate: null,
    reasoningEffort: 'none' as const,
  }),
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-5.6-luna',
    inputMicroUsdPerMillion: 200_000,
    outputMicroUsdPerMillion: 1_200_000,
    rateVersion: 'openai-gpt-5.6-luna-published-2026-11-10',
    provenance: 'unverified' as const,
    source: GPT_5_6_LUNA_DOCS_SOURCE,
    shutdownDate: null,
    reasoningEffort: 'none' as const,
  }),
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-5-mini-2025-08-07',
    inputMicroUsdPerMillion: 250_000,
    outputMicroUsdPerMillion: 2_000_000,
    rateVersion: 'openai-gpt-5-mini-2025-08-07-unverified-2026-11-07',
    provenance: 'unverified' as const,
    source: GPT_5_MINI_DOCS_SOURCE,
    // This snapshot was recorded without a shutdown date on 2026-11-07. OpenAI later announced
    // shutdown on 2026-12-11; keep its original price row for history but refuse new calls.
    shutdownDate: '2026-12-11',
    reasoningEffort: 'minimal' as const,
  }),
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-5-mini',
    inputMicroUsdPerMillion: 250_000,
    outputMicroUsdPerMillion: 2_000_000,
    rateVersion: 'openai-gpt-5-mini-unverified-2026-11-03',
    provenance: 'unverified' as const,
    source: UNVERIFIED_SOURCE,
    shutdownDate: '2026-12-11',
    reasoningEffort: 'minimal' as const,
  }),
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-4.1-mini',
    inputMicroUsdPerMillion: 400_000,
    outputMicroUsdPerMillion: 1_600_000,
    rateVersion: 'openai-gpt-4.1-mini-unverified-2026-11-03',
    provenance: 'unverified' as const,
    source: GPT_4_DEPRECATION_SOURCE,
    shutdownDate: '2027-01-14',
  }),
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-4o-mini',
    inputMicroUsdPerMillion: 150_000,
    outputMicroUsdPerMillion: 600_000,
    rateVersion: 'openai-gpt-4o-mini-unverified-2026-11-03',
    provenance: 'unverified' as const,
    source: GPT_4_DEPRECATION_SOURCE,
    shutdownDate: '2027-01-14',
  }),
]);

/** Exact-match lookup: a pinned model id never silently borrows a family-name price. */
export function findRateRow(
  rows: readonly ModelRateRow[],
  providerId: string,
  modelId: string,
): ModelRateRow | null {
  return rows.find((row) => row.providerId === providerId && row.modelId === modelId) ?? null;
}

/** Integer micro-USD. Rounded up so a fractional cost is never under-reserved. */
export function estimateCostMicroUsd(
  rate: ModelRateRow,
  inputTokens: number,
  outputTokens: number,
): number {
  const numerator =
    inputTokens * rate.inputMicroUsdPerMillion + outputTokens * rate.outputMicroUsdPerMillion;

  return Math.ceil(numerator / 1_000_000);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Approval ids are opaque but must not be a template that was never filled in. */
const APPROVAL_PLACEHOLDER = /pending|todo|tbd|replace|example|placeholder/i;

/** `YYYY-MM-DD` in UTC. The ledger's day boundary is UTC, so approvals use the same clock. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type ApprovalValidity = 'effective' | 'not_yet_valid' | 'expired' | 'malformed';

/**
 * Whether an approval record authorises a call today.
 *
 * Calendar-day comparison is sound because ISO-8601 days sort lexicographically. When `expiresAt`
 * is present it is inclusive; a standing internal approval omits the expiry.
 */
export function evaluateApproval(
  approval: ModelApprovalRecord,
  now: Date = new Date(),
): ApprovalValidity {
  const { approvalId, approvedBy, approvedAt, expiresAt } = approval;

  if (
    typeof approvalId !== 'string' ||
    typeof approvedBy !== 'string' ||
    !ISO_DAY.test(approvedAt) ||
    (expiresAt !== undefined && !ISO_DAY.test(expiresAt)) ||
    approvalId.trim().length === 0 ||
    approvedBy.trim().length === 0 ||
    APPROVAL_PLACEHOLDER.test(approvalId)
  ) {
    return 'malformed';
  }

  if (expiresAt !== undefined && expiresAt < approvedAt) {
    return 'malformed';
  }

  const today = utcDay(now);

  if (today < approvedAt) {
    return 'not_yet_valid';
  }

  if (expiresAt !== undefined && today > expiresAt) {
    return 'expired';
  }

  return 'effective';
}

/**
 * Whether the provider has already reached the announced retirement day of this snapshot.
 *
 * A shutdown *date* in the future is not a refusal: pinning a model that retires in a year is a
 * normal, reviewable decision. A date that has arrived is a hard stop, because the request would
 * fail at the provider after a reservation.
 */
export function isPastShutdown(rate: ModelRateRow, now: Date = new Date()): boolean {
  const day = rate.shutdownDate;

  if (day === null || day === undefined) {
    return false;
  }

  return utcDay(now) >= day;
}
