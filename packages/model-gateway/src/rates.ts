import type { ModelProviderId } from './types.js';

/**
 * A pin, not a preference.
 *
 * `real` mode may only use a model id that appears in `APPROVED_REAL_MODELS`, and that list is
 * **empty in the merged tree**. Enabling real inference is therefore a reviewed code change
 * accompanied by a CTO decision, never an environment variable: no deploy, no `.env` file and no
 * per-tenant policy can turn on provider egress on its own.
 */
export interface ApprovedModel {
  readonly providerId: Extract<ModelProviderId, 'openai'>;
  readonly modelId: string;
}

export const APPROVED_REAL_MODELS: readonly ApprovedModel[] = Object.freeze([]);

/**
 * Providers this build can construct an adapter for. Checked against **code**, not against tenant
 * policy: a misconfigured policy must not be able to point the gateway at a host nobody reviewed.
 * Kept separate from the model allowlist so that "no model approved yet" reports
 * `model_not_approved` rather than masking the real reason as a provider problem.
 */
export const APPROVED_MODEL_PROVIDERS: readonly string[] = Object.freeze(['openai']);

/** Documented placeholder: boot refuses any model id containing it. */
export const MODEL_ID_PLACEHOLDER = 'REPLACE-WITH-CTO-APPROVED-DATED-MODEL-ID';

export interface ModelRateRow {
  readonly providerId: Extract<ModelProviderId, 'openai'>;
  readonly modelId: string;
  /** Micro-USD per one million input tokens (i.e. $0.25/1M → 250000). */
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
  /** Stable string stored per attempt, so historical spend keeps the price it was booked at. */
  readonly rateVersion: string;
  /**
   * `unverified` rows are recorded for arithmetic and provenance only. A `real` call requires an
   * `invoice_verified` row for the exact pinned model id.
   */
  readonly provenance: 'unverified' | 'invoice_verified';
  readonly source: string;
}

const UNVERIFIED_SOURCE =
  'secondary aggregator pages observed 2026-10/11 — not invoice-grade, see B2 proposal §8.1';

/**
 * Rate rows known to this tree. Every row here is **unverified**, which is why no combination of
 * them can enable `real` mode on its own. Approval item A2 requires replacing the relevant row with
 * an `invoice_verified` one for the exact dated model id before enablement.
 */
export const MODEL_RATE_ROWS: readonly ModelRateRow[] = Object.freeze([
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-5-mini',
    inputMicroUsdPerMillion: 250_000,
    outputMicroUsdPerMillion: 2_000_000,
    rateVersion: 'openai-gpt-5-mini-unverified-2026-11-03',
    provenance: 'unverified' as const,
    source: UNVERIFIED_SOURCE,
  }),
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-4.1-mini',
    inputMicroUsdPerMillion: 400_000,
    outputMicroUsdPerMillion: 1_600_000,
    rateVersion: 'openai-gpt-4.1-mini-unverified-2026-11-03',
    provenance: 'unverified' as const,
    source: UNVERIFIED_SOURCE,
  }),
  Object.freeze({
    providerId: 'openai' as const,
    modelId: 'gpt-4o-mini',
    inputMicroUsdPerMillion: 150_000,
    outputMicroUsdPerMillion: 600_000,
    rateVersion: 'openai-gpt-4o-mini-unverified-2026-11-03',
    provenance: 'unverified' as const,
    source: UNVERIFIED_SOURCE,
  }),
]);

/** Exact-match lookup: a pinned dated id never silently borrows a family-name price. */
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
