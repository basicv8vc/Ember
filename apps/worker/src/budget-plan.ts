import type { BudgetReservationAmount } from '@ember/contracts';

/**
 * P0B-08b simulated cost table for the durable execution steps (B08b-D2).
 *
 * The numbers are deliberately tiny, deterministic and configuration-free: P0B-08b proves
 * *enforcement*, not pricing. They are a constant of this build rather than Task input, so a
 * Task payload can never declare that its own work is free.
 *
 * `units` counts against both the per-Run cap and the Tenant-day cap (P0B-08a §2), and
 * `concurrencySlots` is what the step holds while it runs, so an outstanding reservation is
 * visible to every other Worker of the Tenant.
 */
export const SIMULATED_STEP_COSTS = Object.freeze({
  /** One simulated model/sandbox call plus its staging write. */
  produce: Object.freeze({ steps: 1, units: 5, elapsedMs: 50, concurrencySlots: 1 }),
  /** One Workspace CAS plus the terminal commit; much cheaper, still one slot. */
  publish: Object.freeze({ steps: 1, units: 1, elapsedMs: 10, concurrencySlots: 1 }),
});

export type BudgetedStep = keyof typeof SIMULATED_STEP_COSTS;

/** Cost of one durable step. Frozen, so a caller cannot scale its own charge down. */
export function stepCost(step: BudgetedStep): BudgetReservationAmount {
  return SIMULATED_STEP_COSTS[step];
}

/**
 * Stable budget operation id for one attempt of one step.
 *
 * `(tenantId, runId, operationId)` is the durable charge identity, so this id must be:
 *
 * - **stable within an attempt** — a reserve that lost its acknowledgement replays instead of
 *   charging twice;
 * - **free of the UTC day** — P0B-08a §6.1 rule 1: replaying yesterday's operation today must
 *   not become a second charge;
 * - **scoped to the lease epoch** — a re-claimed Run genuinely re-executes the step, so the
 *   retry is charged on its own account while the dead attempt's reservation stays charged
 *   (see `PostgresBudgetLedger`). Sharing one id across attempts would instead let a retry
 *   look free.
 */
export function stepOperationId(
  step: BudgetedStep,
  inputDigest: string,
  leaseEpoch: number,
): string {
  return `step:${step}:${inputDigest.slice(0, 16)}:${leaseEpoch}`;
}
