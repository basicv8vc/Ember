import { IdSchema } from '@ember/contracts';
import { DomainError, InvalidArgumentError, type Id } from '@ember/domain';
import { parseExecutionNow } from './clock.js';

/**
 * Deterministic **mock** budget guard: the pure rules layer of P0B-08a.
 *
 * ## What this module is
 *
 * A total, side-effect-free decision function plus an immutable local reference ledger:
 *
 * - `evaluateBudget(policy, snapshot, proposedCost)` compares a trusted policy against a
 *   trusted usage snapshot and a simulated cost, and returns a frozen Allow/Deny decision;
 * - `createBudgetLedger` / `reserveBudget` / `consumeBudgetReservation` /
 *   `releaseBudgetReservation` express Reservation → Consumption → Release as pure state
 *   transitions on a value, so the semantics are testable without a database.
 *
 * Everything is denominated in **simulated units**. No currency, invoice, provider quota or
 * real billing exists here, and the wording of every export avoids implying otherwise.
 *
 * ## Trust rules (non-negotiable)
 *
 * - A policy is trusted server-side configuration. It is never derived from a Task payload,
 *   a Prompt, an HTTP body or any other client-controlled field.
 * - A snapshot is a trusted usage projection supplied by the future adapter. Tenant/run
 *   identity and the UTC day key are explicit inputs, never inferred.
 * - The proposed cost is a *simulation* of the next operation, not a measurement.
 * - Invalid, missing, negative, fractional, non-finite, out-of-range or overflowing numbers
 *   are rejected with `INVALID_ARGUMENT`. No such value is ever coerced into "unlimited".
 *
 * ## Determinism and purity
 *
 * Same input → same output. The module reads no clock (`Date.now()` is never called), opens
 * no socket, touches no filesystem and imports nothing from `@ember/postgres`, the LLM
 * fixture, the sandbox fixture or the Task/Run state machines. Inputs are only read; every
 * value this module returns is deep-frozen.
 *
 * ## Deliberate boundaries (P0B-08a scope)
 *
 * - **No execution interception.** Nothing here is wired into Worker Claim/Lease,
 *   `RunResultCommitter`, Task finishing, Checkpoint/Resume, Approval, PostgreSQL
 *   transactions or the HTTP API. That integration is P0B-08b.
 * - **No persistence.** No budget ledger table, no migration, no in-process cross-request
 *   ledger. The local `BudgetLedgerState` is a value you pass around, not a store.
 * - **No cross-process atomicity.** A pure function cannot make concurrent Workers agree on
 *   one reservation, and it cannot guarantee Exactly-Once consumption. Two processes holding
 *   the same snapshot can both be allowed. An authoritative adapter must serialise the
 *   check-and-reserve step (for example in one database transaction) and persist operation
 *   receipts; `BudgetLedgerState` is a reference model for those rules, not a replacement.
 * - **No state machine or contract change.** This module adds no Task/Run status, no
 *   `TaskEventPayload` field and no new `DomainErrorCode`; a denial reuses the existing
 *   `BUDGET_EXCEEDED` code through {@link toBudgetDeniedError}.
 */

/**
 * Budget dimensions, in reporting order.
 *
 * **The array order is the stable deny priority.** When several dimensions are exceeded at
 * once, `BudgetDenyDecision.dimension` is the first entry of this list that is exceeded, and
 * `BudgetDenyDecision.violations` is ordered the same way. Priority runs from the narrowest
 * scope to the widest: per-Run steps → per-Run units → per-Run elapsed time → Tenant-day
 * units → concurrency slots. Callers branch on this identifier, never on message text.
 */
export const BUDGET_DIMENSIONS = [
  'run_steps',
  'run_units',
  'run_elapsed_ms',
  'tenant_daily_units',
  'concurrency_slots',
] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

/**
 * Structural validation bounds.
 *
 * These are *not* budget amounts. They bound identifiers and local ledger history so a
 * malformed or hostile input cannot make validation unbounded. Exceeding them fails closed.
 */
export const BUDGET_GUARD_LIMITS = Object.freeze({
  maxPolicyIdChars: 128,
  maxOperationIdChars: 128,
  maxLedgerOperations: 1_024,
});

/**
 * Trusted, server-side simulated budget policy.
 *
 * Every limit is a non-negative safe integer in simulated units and is inclusive: a
 * projection that lands *exactly* on the limit is allowed, one unit above is denied.
 *
 * `maxConcurrentSlots: 0` therefore means "this Tenant/execution domain may not run any
 * simulated step at all" — a valid, explicit, fail-closed configuration, not a missing value.
 */
export interface BudgetPolicy {
  /** Stable identifier of the trusted policy revision used for this decision. */
  readonly policyId: string;
  /** Non-negative integer revision; reported back on the decision for audit. */
  readonly policyVersion: number;
  /** Maximum simulated execution steps for one Run. */
  readonly maxRunSteps: number;
  /** Maximum simulated CPU / execution units for one Run. */
  readonly maxRunUnits: number;
  /** Maximum accumulated simulated elapsed time (ms) for one Run. */
  readonly maxRunElapsedMs: number;
  /** Maximum simulated execution units for one Tenant in one explicit UTC day. */
  readonly maxTenantDailyUnits: number;
  /** Maximum simulated concurrent Worker slots for one Tenant / execution domain. */
  readonly maxConcurrentSlots: number;
}

/**
 * Immutable, trusted usage snapshot for one Run at one explicit UTC day key.
 *
 * Provided by the future adapter (P0B-08b) from authoritative state. This module never loads
 * it: there is no `Date.now()`, no `SELECT`, and no implicit "today". The caller decides the
 * day boundary and passes `utcDay` as an explicit `YYYY-MM-DD` key, so a day rollover is an
 * input change rather than hidden behaviour.
 *
 * `runSteps` / `runUnits` / `runElapsedMs` are already-committed per-Run consumption;
 * `tenantDailyUnits` is already-committed Tenant-day consumption (it may include the Run
 * usage above, and this module does not try to reconcile the two); `concurrentSlots` is the
 * number of simulated slots currently held, i.e. a gauge rather than a counter.
 */
export interface BudgetSnapshot {
  /** Trusted Tenant scope. Never taken from a Task payload. */
  readonly tenantId: Id;
  /** Trusted Run scope the per-Run counters belong to. */
  readonly runId: Id;
  /** Explicit UTC day key (`YYYY-MM-DD`) the Tenant-day counter belongs to. */
  readonly utcDay: string;
  readonly runSteps: number;
  readonly runUnits: number;
  readonly runElapsedMs: number;
  readonly tenantDailyUnits: number;
  readonly concurrentSlots: number;
}

/** Cumulative simulated usage counters of one Run. A concurrency gauge is not a counter. */
export interface BudgetUsage {
  readonly steps: number;
  readonly units: number;
  readonly elapsedMs: number;
}

/**
 * Simulated cost of a proposed operation, or the reserved amount of one operation.
 *
 * `units` counts against **both** the per-Run cap and the Tenant-day cap: the same simulated
 * execution unit is spent from both budgets. `concurrencySlots` is the number of simulated
 * Worker slots the operation would hold while it runs.
 */
export interface BudgetAmount extends BudgetUsage {
  readonly concurrencySlots: number;
}

/** Usage a decision expects to be committed if the operation runs (Allow only). */
export interface BudgetProjection {
  readonly runSteps: number;
  readonly runUnits: number;
  readonly runElapsedMs: number;
  readonly tenantDailyUnits: number;
  readonly concurrentSlots: number;
}

/** One exceeded dimension, with the exact numbers the rule compared. */
export interface BudgetViolation {
  readonly dimension: BudgetDimension;
  /** Inclusive limit from the trusted policy. */
  readonly limit: number;
  /** Trusted consumed amount from the snapshot. */
  readonly used: number;
  /** Simulated amount from the proposed cost. */
  readonly proposed: number;
  /** `used + proposed`; the value that is compared with `limit`. */
  readonly projected: number;
}

/** Identity carried by every decision so an audit log never has to guess which policy ran. */
interface BudgetDecisionScope {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly tenantId: Id;
  readonly runId: Id;
  readonly utcDay: string;
}

/**
 * The operation is allowed: executing it would keep every dimension at or below its limit.
 *
 * `projected` is what the caller may expect to be committed. The decision itself changes
 * nothing — committing the usage is the caller's (future, P0B-08b) responsibility.
 */
export interface BudgetAllowDecision extends BudgetDecisionScope {
  readonly allowed: true;
  readonly projected: BudgetProjection;
}

/**
 * The operation is denied, reusing the existing `BUDGET_EXCEEDED` semantics.
 *
 * Nothing is debited: a denial leaves every dimension untouched, and no partially applied
 * reservation exists anywhere. `dimension` / `limit` / `used` / `proposed` mirror the primary
 * violation so callers do not have to index into an array.
 */
export interface BudgetDenyDecision extends BudgetDecisionScope {
  readonly allowed: false;
  /** Highest-priority exceeded dimension (see `BUDGET_DIMENSIONS`). */
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly used: number;
  readonly proposed: number;
  /** Every exceeded dimension, ordered by `BUDGET_DIMENSIONS`; the first is the primary. */
  readonly violations: readonly BudgetViolation[];
}

export type BudgetDecision = BudgetAllowDecision | BudgetDenyDecision;

/**
 * Deterministic budget decision. Pure: it reads no clock, performs no I/O and mutates
 * nothing (including its arguments).
 *
 * Rules:
 *
 * 1. A dimension is allowed when `used + proposed <= limit`; landing exactly on the limit is
 *    allowed, being one unit above is not.
 * 2. Any exceeded dimension denies the whole operation. There is no partial debit, so a
 *    denial cannot consume budget on a dimension that happened to fit.
 * 3. When several dimensions are exceeded, `dimension` is the first one in
 *    `BUDGET_DIMENSIONS` order, and `violations` lists all of them in that same order.
 * 4. A zero cost is a legitimate no-op request. It is allowed only while the trusted
 *    snapshot is already within every limit; it never bypasses an overage that already
 *    exists, because the comparison is on `used + 0`, not on `proposed`.
 *
 * @throws {InvalidArgumentError} `INVALID_ARGUMENT` for an invalid policy, snapshot or cost
 * (including missing fields, unknown fields, negative / fractional / non-finite / unsafe
 * integers and arithmetic overflow). Such input never yields an Allow.
 */
export function evaluateBudget(
  policy: BudgetPolicy,
  snapshot: BudgetSnapshot,
  proposedCost: BudgetAmount,
): BudgetDecision {
  const trustedPolicy = parseBudgetPolicy(policy);
  const trustedSnapshot = parseBudgetSnapshot(snapshot);
  const cost = parseBudgetAmount(proposedCost, 'proposedCost');

  // Every addition is overflow-checked: an unsafe sum fails closed instead of wrapping.
  const projected: BudgetProjection = Object.freeze({
    runSteps: addAmounts(trustedSnapshot.runSteps, cost.steps, 'proposedCost.steps'),
    runUnits: addAmounts(trustedSnapshot.runUnits, cost.units, 'proposedCost.units'),
    runElapsedMs: addAmounts(
      trustedSnapshot.runElapsedMs,
      cost.elapsedMs,
      'proposedCost.elapsedMs',
    ),
    tenantDailyUnits: addAmounts(
      trustedSnapshot.tenantDailyUnits,
      cost.units,
      'proposedCost.units',
    ),
    concurrentSlots: addAmounts(
      trustedSnapshot.concurrentSlots,
      cost.concurrencySlots,
      'proposedCost.concurrencySlots',
    ),
  });

  // Keyed by dimension and then mapped through BUDGET_DIMENSIONS, so the reporting order of
  // `violations` is structurally tied to the exported priority list.
  const perDimension: Readonly<Record<BudgetDimension, Omit<BudgetViolation, 'dimension'>>> =
    Object.freeze({
      run_steps: {
        limit: trustedPolicy.maxRunSteps,
        used: trustedSnapshot.runSteps,
        proposed: cost.steps,
        projected: projected.runSteps,
      },
      run_units: {
        limit: trustedPolicy.maxRunUnits,
        used: trustedSnapshot.runUnits,
        proposed: cost.units,
        projected: projected.runUnits,
      },
      run_elapsed_ms: {
        limit: trustedPolicy.maxRunElapsedMs,
        used: trustedSnapshot.runElapsedMs,
        proposed: cost.elapsedMs,
        projected: projected.runElapsedMs,
      },
      tenant_daily_units: {
        limit: trustedPolicy.maxTenantDailyUnits,
        used: trustedSnapshot.tenantDailyUnits,
        proposed: cost.units,
        projected: projected.tenantDailyUnits,
      },
      concurrency_slots: {
        limit: trustedPolicy.maxConcurrentSlots,
        used: trustedSnapshot.concurrentSlots,
        proposed: cost.concurrencySlots,
        projected: projected.concurrentSlots,
      },
    });

  const violations = BUDGET_DIMENSIONS.map((dimension) => ({
    dimension,
    ...perDimension[dimension],
  }))
    .filter((violation) => violation.projected > violation.limit)
    .map((violation) => Object.freeze(violation));

  const scope = {
    policyId: trustedPolicy.policyId,
    policyVersion: trustedPolicy.policyVersion,
    tenantId: trustedSnapshot.tenantId,
    runId: trustedSnapshot.runId,
    utcDay: trustedSnapshot.utcDay,
  };

  const primary = violations[0];

  if (primary === undefined) {
    return Object.freeze({ ...scope, allowed: true, projected });
  }

  return Object.freeze({
    ...scope,
    allowed: false,
    dimension: primary.dimension,
    limit: primary.limit,
    used: primary.used,
    proposed: primary.proposed,
    violations: Object.freeze(violations),
  });
}

/**
 * Adapt a denial to the existing domain error vocabulary.
 *
 * Reuses `BUDGET_EXCEEDED` — no parallel enum is introduced. The diagnostic names the stable
 * dimension and numbers only; it never echoes a prompt, payload or identifier, and it stays
 * internal (`DomainError.diagnostic` is not serialised).
 */
export function toBudgetDeniedError(decision: BudgetDenyDecision): DomainError {
  return new DomainError(
    'BUDGET_EXCEEDED',
    `mock budget exceeded: dimension=${decision.dimension} policy=${decision.policyId} ` +
      `version=${decision.policyVersion} limit=${decision.limit} used=${decision.used} ` +
      `proposed=${decision.proposed}`,
  );
}

/**
 * Convert an explicit instant to the explicit UTC day key a snapshot uses.
 *
 * The caller injects the instant (for example from an existing `ExecutionClock`); this
 * helper only formats it, so the module still never reads an implicit "now".
 *
 * @throws {InvalidArgumentError} `INVALID_ARGUMENT` when the value is not a valid, bounded
 * `Date`.
 */
export function toUtcDayKey(value: Date): string {
  return parseExecutionNow(value, 'date').toISOString().slice(0, 10);
}

/**
 * One reservation: the simulated amount an operation plans to use, addressed by a stable
 * `operationId` (a step id, a settlement id — whatever the caller can repeat on a retry).
 */
export interface BudgetReservation {
  readonly operationId: string;
  readonly amount: BudgetAmount;
}

/**
 * The actually consumed part of one reservation.
 *
 * `consumed` must not exceed the reserved amount on any counter dimension; whatever is left
 * over is released, which is exactly the "release only what was not consumed" rule.
 */
export interface BudgetSettlement {
  readonly operationId: string;
  readonly consumed: BudgetUsage;
}

/**
 * Immutable local reference ledger for one `(tenantId, runId, utcDay)` scope.
 *
 * This is a **value**, not a store. It exists so Reservation / Consumption / Release can be
 * expressed and tested as pure transitions:
 *
 * - `reserved` is outstanding planned usage: the sum of the amounts of every reservation
 *   that has not been settled yet;
 * - `consumed` is irreversible actual usage: it only ever grows and is never reduced by a
 *   release or a cancellation;
 * - `reservations` / `settlements` are the operation log that makes settlement idempotent per
 *   `operationId` and lets validation re-derive both totals.
 *
 * It provides **no** cross-process guarantee: two Workers can each hold a copy and each
 * believe the same slots are free. Persisting equivalent rules atomically is P0B-08b.
 */
export interface BudgetLedgerState {
  readonly tenantId: Id;
  readonly runId: Id;
  readonly utcDay: string;
  readonly reserved: BudgetAmount;
  readonly consumed: BudgetUsage;
  readonly reservations: readonly BudgetReservation[];
  readonly settlements: readonly BudgetSettlement[];
}

/** Scope of a fresh ledger. Identity and day key are trusted inputs, like a snapshot's. */
export interface BudgetLedgerScope {
  readonly tenantId: Id;
  readonly runId: Id;
  readonly utcDay: string;
}

const ZERO_USAGE: BudgetUsage = Object.freeze({ steps: 0, units: 0, elapsedMs: 0 });

const ZERO_AMOUNT: BudgetAmount = Object.freeze({ ...ZERO_USAGE, concurrencySlots: 0 });

/** Empty ledger: nothing reserved, nothing consumed. */
export function createBudgetLedger(scope: BudgetLedgerScope): BudgetLedgerState {
  const source = asRecord(scope, 'ledger');
  rejectUnknownKeys(source, LEDGER_SCOPE_KEYS, 'ledger');

  return Object.freeze({
    tenantId: parseId(source['tenantId'], 'ledger.tenantId'),
    runId: parseId(source['runId'], 'ledger.runId'),
    utcDay: parseUtcDayKey(source['utcDay'], 'ledger.utcDay'),
    reserved: ZERO_AMOUNT,
    consumed: ZERO_USAGE,
    reservations: Object.freeze([]),
    settlements: Object.freeze([]),
  });
}

/**
 * Reserve simulated budget for a planned operation.
 *
 * This transition does **not** decide whether the plan is affordable — `evaluateBudget` does.
 * The intended order is: evaluate against a trusted snapshot, and only reserve when the
 * decision is Allow, so a denial can never leave a partial reservation behind.
 *
 * Idempotent per `operationId`: repeating the same reservation returns an equal state, and
 * repeating it with a different amount is rejected instead of silently over-reserving.
 *
 * @throws {InvalidArgumentError} `INVALID_ARGUMENT` for an invalid state/reservation, an
 * operation id that was already settled, an amount conflict, or exceeded history capacity.
 */
export function reserveBudget(
  state: BudgetLedgerState,
  reservation: BudgetReservation,
): BudgetLedgerState {
  const current = parseLedgerState(state);
  const parsed = parseReservation(reservation, 'reservation');

  if (current.settlements.some((entry) => entry.operationId === parsed.operationId)) {
    return fail('reservation.operationId', 'budget_reservation_already_settled');
  }

  const existing = current.reservations.find(
    (candidate) => candidate.operationId === parsed.operationId,
  );

  if (existing !== undefined) {
    if (sameAmount(existing.amount, parsed.amount)) {
      return current;
    }
    return fail('reservation.operationId', 'budget_reservation_conflict');
  }

  if (current.reservations.length >= BUDGET_GUARD_LIMITS.maxLedgerOperations) {
    return fail('reservation.operationId', 'budget_ledger_capacity');
  }

  return Object.freeze({
    tenantId: current.tenantId,
    runId: current.runId,
    utcDay: current.utcDay,
    reserved: Object.freeze({
      steps: addAmounts(current.reserved.steps, parsed.amount.steps, 'ledger.reserved.steps'),
      units: addAmounts(current.reserved.units, parsed.amount.units, 'ledger.reserved.units'),
      elapsedMs: addAmounts(
        current.reserved.elapsedMs,
        parsed.amount.elapsedMs,
        'ledger.reserved.elapsedMs',
      ),
      concurrencySlots: addAmounts(
        current.reserved.concurrencySlots,
        parsed.amount.concurrencySlots,
        'ledger.reserved.concurrencySlots',
      ),
    }),
    consumed: current.consumed,
    reservations: Object.freeze([...current.reservations, parsed]),
    settlements: current.settlements,
  });
}

/**
 * Settle a reservation: record the consumed part and release the rest.
 *
 * Rules enforced here:
 *
 * - only an outstanding reservation can be settled, and the consumed part may not exceed it;
 * - the unconsumed remainder is released (this is the only way reserved budget returns);
 * - `consumed` never decreases, so a settled amount cannot be refunded by a later release;
 * - repeating the same `operationId` with the same numbers returns an equal state and never
 *   adds consumption twice; repeating it with different numbers is rejected.
 *
 * @throws {InvalidArgumentError} `INVALID_ARGUMENT` for invalid input, an unknown operation,
 * a consumption larger than the reservation, or a conflicting repeat settlement.
 */
export function consumeBudgetReservation(
  state: BudgetLedgerState,
  settlement: BudgetSettlement,
): BudgetLedgerState {
  const current = parseLedgerState(state);
  const parsed = parseSettlement(settlement, 'settlement');

  const alreadySettled = current.settlements.find(
    (entry) => entry.operationId === parsed.operationId,
  );

  if (alreadySettled !== undefined) {
    if (sameUsage(alreadySettled.consumed, parsed.consumed)) {
      // Idempotent repeat: no second debit and no state change at all.
      return current;
    }
    return fail('settlement.operationId', 'budget_settlement_conflict');
  }

  const reservation = current.reservations.find(
    (candidate) => candidate.operationId === parsed.operationId,
  );

  if (reservation === undefined) {
    return fail('settlement.operationId', 'budget_unknown_reservation');
  }

  if (
    parsed.consumed.steps > reservation.amount.steps ||
    parsed.consumed.units > reservation.amount.units ||
    parsed.consumed.elapsedMs > reservation.amount.elapsedMs
  ) {
    return fail('settlement.consumed', 'budget_consumption_exceeds_reservation');
  }

  return Object.freeze({
    tenantId: current.tenantId,
    runId: current.runId,
    utcDay: current.utcDay,
    reserved: Object.freeze({
      steps: safeDifference(current.reserved.steps, reservation.amount.steps, 'ledger.reserved'),
      units: safeDifference(current.reserved.units, reservation.amount.units, 'ledger.reserved'),
      elapsedMs: safeDifference(
        current.reserved.elapsedMs,
        reservation.amount.elapsedMs,
        'ledger.reserved',
      ),
      concurrencySlots: safeDifference(
        current.reserved.concurrencySlots,
        reservation.amount.concurrencySlots,
        'ledger.reserved',
      ),
    }),
    consumed: Object.freeze({
      steps: addAmounts(current.consumed.steps, parsed.consumed.steps, 'ledger.consumed.steps'),
      units: addAmounts(current.consumed.units, parsed.consumed.units, 'ledger.consumed.units'),
      elapsedMs: addAmounts(
        current.consumed.elapsedMs,
        parsed.consumed.elapsedMs,
        'ledger.consumed.elapsedMs',
      ),
    }),
    reservations: current.reservations,
    settlements: Object.freeze([
      ...current.settlements,
      Object.freeze({
        operationId: parsed.operationId,
        consumed: Object.freeze({ ...parsed.consumed }),
      }),
    ]),
  });
}

/**
 * Release an outstanding reservation after a cancellation or failure.
 *
 * Equivalent to settling with zero consumption: the reserved amount returns to zero while
 * `consumed` is untouched. Once an operation was consumed, calling this for the same
 * `operationId` is an idempotent no-op — consumed budget is **never** refunded.
 *
 * @throws {InvalidArgumentError} `INVALID_ARGUMENT` for invalid input or an unknown operation.
 */
export function releaseBudgetReservation(
  state: BudgetLedgerState,
  operationId: string,
): BudgetLedgerState {
  const current = parseLedgerState(state);
  const id = parseOperationId(operationId, 'operationId');

  // An already settled operation is never refunded: releasing it is an idempotent no-op.
  if (current.settlements.some((entry) => entry.operationId === id)) {
    return current;
  }

  return consumeBudgetReservation(current, { operationId: id, consumed: ZERO_USAGE });
}

/**
 * Build the trusted snapshot for the *next* step from an outstanding ledger.
 *
 * Per-Run counters report `consumed + reserved`, so an outstanding reservation cannot be
 * spent twice by two evaluations. The concurrency gauge is the outstanding slot count.
 * `tenantDailyUnits` must come from the future authoritative Tenant-day store; this module
 * never aggregates across Runs.
 *
 * @throws {InvalidArgumentError} `INVALID_ARGUMENT` for an invalid state or a `tenantDailyUnits`
 * that is not a non-negative safe integer.
 */
export function snapshotFromLedger(
  state: BudgetLedgerState,
  tenantDailyUnits: number,
): BudgetSnapshot {
  const current = parseLedgerState(state);

  return Object.freeze({
    tenantId: current.tenantId,
    runId: current.runId,
    utcDay: current.utcDay,
    runSteps: addAmounts(current.consumed.steps, current.reserved.steps, 'runSteps'),
    runUnits: addAmounts(current.consumed.units, current.reserved.units, 'runUnits'),
    runElapsedMs: addAmounts(
      current.consumed.elapsedMs,
      current.reserved.elapsedMs,
      'runElapsedMs',
    ),
    tenantDailyUnits: requireAmount(tenantDailyUnits, 'tenantDailyUnits'),
    concurrentSlots: current.reserved.concurrencySlots,
  });
}

// ---------------------------------------------------------------------------------------
// Internal validation and arithmetic helpers.
//
// Hand-written instead of a schema library on purpose: the rules are numeric and invariant
// based, every failure has to map to one stable `code`, and this module must stay a leaf with
// no dependency on the request/response schemas in `@ember/contracts`.
// ---------------------------------------------------------------------------------------

const POLICY_KEYS = [
  'policyId',
  'policyVersion',
  'maxRunSteps',
  'maxRunUnits',
  'maxRunElapsedMs',
  'maxTenantDailyUnits',
  'maxConcurrentSlots',
] as const satisfies readonly (keyof BudgetPolicy)[];

const SNAPSHOT_KEYS = [
  'tenantId',
  'runId',
  'utcDay',
  'runSteps',
  'runUnits',
  'runElapsedMs',
  'tenantDailyUnits',
  'concurrentSlots',
] as const satisfies readonly (keyof BudgetSnapshot)[];

const USAGE_KEYS = [
  'steps',
  'units',
  'elapsedMs',
] as const satisfies readonly (keyof BudgetUsage)[];

const AMOUNT_KEYS = [
  'steps',
  'units',
  'elapsedMs',
  'concurrencySlots',
] as const satisfies readonly (keyof BudgetAmount)[];

const RESERVATION_KEYS = ['operationId', 'amount'] as const satisfies ReadonlyArray<
  keyof BudgetReservation
>;

const SETTLEMENT_KEYS = ['operationId', 'consumed'] as const satisfies ReadonlyArray<
  keyof BudgetSettlement
>;

const LEDGER_KEYS = [
  'tenantId',
  'runId',
  'utcDay',
  'reserved',
  'consumed',
  'reservations',
  'settlements',
] as const satisfies readonly (keyof BudgetLedgerState)[];

const LEDGER_SCOPE_KEYS = [
  'tenantId',
  'runId',
  'utcDay',
] as const satisfies readonly (keyof BudgetLedgerScope)[];

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Fail closed with the existing `INVALID_ARGUMENT` vocabulary (`path` + stable `code`). */
function fail(path: string, code: string): never {
  throw new InvalidArgumentError([{ path, code }]);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'invalid_object');
  }

  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return fail(path, 'invalid_array');
  }

  return value;
}

/** Trusted input must not be ambiguous: an unexpected key is a bug or a forged payload. */
function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      throw new InvalidArgumentError([{ path: `${path}.${key}`, code: 'unknown_field' }]);
    }
  }
}

/** Non-negative safe integer. Rejects negative, fractional, `NaN`, `Infinity` and unsafe. */
function requireAmount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(path, 'invalid_budget_amount');
  }

  return value;
}

/** Overflow-checked addition: an unsafe sum fails closed instead of losing precision. */
function addAmounts(left: number, right: number, path: string): number {
  const sum = left + right;

  if (!Number.isSafeInteger(sum)) {
    return fail(path, 'budget_amount_overflow');
  }

  return sum;
}

/** Overflow-checked, non-negative subtraction used when reserved budget is returned. */
function safeDifference(left: number, right: number, path: string): number {
  const difference = left - right;

  if (!Number.isSafeInteger(difference) || difference < 0) {
    return fail(path, 'budget_ledger_invariant');
  }

  return difference;
}

function parseId(value: unknown, path: string): Id {
  const parsed = IdSchema.safeParse(value);

  if (!parsed.success) {
    return fail(path, 'invalid_id');
  }

  return parsed.data;
}

/** Explicit `YYYY-MM-DD` UTC day key. Impossible calendar dates are rejected, not normalised. */
function parseUtcDayKey(value: unknown, path: string): string {
  if (typeof value !== 'string' || !UTC_DAY_PATTERN.test(value)) {
    return fail(path, 'invalid_utc_day');
  }

  const time = Date.parse(`${value}T00:00:00.000Z`);

  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    return fail(path, 'invalid_utc_day');
  }

  return value;
}

/** Stable, non-blank operation id; it is the idempotency key of a reservation. */
function parseOperationId(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > BUDGET_GUARD_LIMITS.maxOperationIdChars ||
    value.trim() !== value
  ) {
    return fail(path, 'invalid_operation_id');
  }

  return value;
}

function sameUsage(left: BudgetUsage, right: BudgetUsage): boolean {
  return (
    left.steps === right.steps && left.units === right.units && left.elapsedMs === right.elapsedMs
  );
}

function sameAmount(left: BudgetAmount, right: BudgetAmount): boolean {
  return sameUsage(left, right) && left.concurrencySlots === right.concurrencySlots;
}

function parsePolicyId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > BUDGET_GUARD_LIMITS.maxPolicyIdChars ||
    value.trim() !== value
  ) {
    return fail('policy.policyId', 'invalid_policy_id');
  }

  return value;
}

/** Version mirrors `parsePolicyVersion` in `validation.ts`: rejected, never coerced. */
function parsePolicyVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail('policy.policyVersion', 'invalid_policy_version');
  }

  return value;
}

function parseBudgetPolicy(value: unknown): BudgetPolicy {
  const source = asRecord(value, 'policy');
  rejectUnknownKeys(source, POLICY_KEYS, 'policy');

  return Object.freeze({
    policyId: parsePolicyId(source['policyId']),
    policyVersion: parsePolicyVersion(source['policyVersion']),
    maxRunSteps: requireAmount(source['maxRunSteps'], 'policy.maxRunSteps'),
    maxRunUnits: requireAmount(source['maxRunUnits'], 'policy.maxRunUnits'),
    maxRunElapsedMs: requireAmount(source['maxRunElapsedMs'], 'policy.maxRunElapsedMs'),
    maxTenantDailyUnits: requireAmount(source['maxTenantDailyUnits'], 'policy.maxTenantDailyUnits'),
    maxConcurrentSlots: requireAmount(source['maxConcurrentSlots'], 'policy.maxConcurrentSlots'),
  });
}

function parseBudgetSnapshot(value: unknown): BudgetSnapshot {
  const source = asRecord(value, 'snapshot');
  rejectUnknownKeys(source, SNAPSHOT_KEYS, 'snapshot');

  return Object.freeze({
    tenantId: parseId(source['tenantId'], 'snapshot.tenantId'),
    runId: parseId(source['runId'], 'snapshot.runId'),
    utcDay: parseUtcDayKey(source['utcDay'], 'snapshot.utcDay'),
    runSteps: requireAmount(source['runSteps'], 'snapshot.runSteps'),
    runUnits: requireAmount(source['runUnits'], 'snapshot.runUnits'),
    runElapsedMs: requireAmount(source['runElapsedMs'], 'snapshot.runElapsedMs'),
    tenantDailyUnits: requireAmount(source['tenantDailyUnits'], 'snapshot.tenantDailyUnits'),
    concurrentSlots: requireAmount(source['concurrentSlots'], 'snapshot.concurrentSlots'),
  });
}

function parseUsage(value: unknown, path: string): BudgetUsage {
  const source = asRecord(value, path);
  rejectUnknownKeys(source, USAGE_KEYS, path);

  return Object.freeze({
    steps: requireAmount(source['steps'], `${path}.steps`),
    units: requireAmount(source['units'], `${path}.units`),
    elapsedMs: requireAmount(source['elapsedMs'], `${path}.elapsedMs`),
  });
}

function parseBudgetAmount(value: unknown, path: string): BudgetAmount {
  const source = asRecord(value, path);
  rejectUnknownKeys(source, AMOUNT_KEYS, path);

  return Object.freeze({
    steps: requireAmount(source['steps'], `${path}.steps`),
    units: requireAmount(source['units'], `${path}.units`),
    elapsedMs: requireAmount(source['elapsedMs'], `${path}.elapsedMs`),
    concurrencySlots: requireAmount(source['concurrencySlots'], `${path}.concurrencySlots`),
  });
}

function parseReservation(value: unknown, path: string): BudgetReservation {
  const source = asRecord(value, path);
  rejectUnknownKeys(source, RESERVATION_KEYS, path);

  return Object.freeze({
    operationId: parseOperationId(source['operationId'], `${path}.operationId`),
    amount: parseBudgetAmount(source['amount'], `${path}.amount`),
  });
}

function parseSettlement(value: unknown, path: string): BudgetSettlement {
  const source = asRecord(value, path);
  rejectUnknownKeys(source, SETTLEMENT_KEYS, path);

  return Object.freeze({
    operationId: parseOperationId(source['operationId'], `${path}.operationId`),
    consumed: parseUsage(source['consumed'], `${path}.consumed`),
  });
}

function parseEntryList<T>(
  value: unknown,
  path: string,
  parseEntry: (entry: unknown, entryPath: string) => T,
): readonly T[] {
  const items = asArray(value, path);

  if (items.length > BUDGET_GUARD_LIMITS.maxLedgerOperations) {
    return fail(path, 'budget_ledger_capacity');
  }

  return Object.freeze(items.map((item, index) => parseEntry(item, `${path}[${index}]`)));
}

/**
 * Validate a ledger value and re-derive its totals from the operation log.
 *
 * The re-derivation is the point: `reserved` must equal the sum of outstanding reservation
 * amounts and `consumed` must equal the sum of settlement consumptions. A value whose totals
 * disagree with its own log — a hand-edited fixture, a partially applied write from the
 * future adapter — is rejected instead of being trusted for the next decision.
 *
 * @throws {InvalidArgumentError} `INVALID_ARGUMENT` for any structural or invariant failure.
 */
function parseLedgerState(value: unknown): BudgetLedgerState {
  const source = asRecord(value, 'ledger');
  rejectUnknownKeys(source, LEDGER_KEYS, 'ledger');

  const tenantId = parseId(source['tenantId'], 'ledger.tenantId');
  const runId = parseId(source['runId'], 'ledger.runId');
  const utcDay = parseUtcDayKey(source['utcDay'], 'ledger.utcDay');
  const reserved = parseBudgetAmount(source['reserved'], 'ledger.reserved');
  const consumed = parseUsage(source['consumed'], 'ledger.consumed');
  const reservations = parseEntryList(
    source['reservations'],
    'ledger.reservations',
    parseReservation,
  );
  const settlements = parseEntryList(source['settlements'], 'ledger.settlements', parseSettlement);

  const amounts = new Map<string, BudgetAmount>();

  for (const reservation of reservations) {
    if (amounts.has(reservation.operationId)) {
      return fail('ledger.reservations', 'budget_ledger_invariant');
    }
    amounts.set(reservation.operationId, reservation.amount);
  }

  const settled = new Set<string>();

  for (const settlement of settlements) {
    const amount = amounts.get(settlement.operationId);

    if (amount === undefined || settled.has(settlement.operationId)) {
      return fail('ledger.settlements', 'budget_ledger_invariant');
    }

    if (
      settlement.consumed.steps > amount.steps ||
      settlement.consumed.units > amount.units ||
      settlement.consumed.elapsedMs > amount.elapsedMs
    ) {
      return fail('ledger.settlements', 'budget_ledger_invariant');
    }

    settled.add(settlement.operationId);
  }

  let expectedReserved = ZERO_AMOUNT;
  let expectedConsumed = ZERO_USAGE;

  for (const reservation of reservations) {
    if (settled.has(reservation.operationId)) {
      continue;
    }

    expectedReserved = Object.freeze({
      steps: addAmounts(expectedReserved.steps, reservation.amount.steps, 'ledger.reserved.steps'),
      units: addAmounts(expectedReserved.units, reservation.amount.units, 'ledger.reserved.units'),
      elapsedMs: addAmounts(
        expectedReserved.elapsedMs,
        reservation.amount.elapsedMs,
        'ledger.reserved.elapsedMs',
      ),
      concurrencySlots: addAmounts(
        expectedReserved.concurrencySlots,
        reservation.amount.concurrencySlots,
        'ledger.reserved.concurrencySlots',
      ),
    });
  }

  for (const settlement of settlements) {
    expectedConsumed = Object.freeze({
      steps: addAmounts(expectedConsumed.steps, settlement.consumed.steps, 'ledger.consumed.steps'),
      units: addAmounts(expectedConsumed.units, settlement.consumed.units, 'ledger.consumed.units'),
      elapsedMs: addAmounts(
        expectedConsumed.elapsedMs,
        settlement.consumed.elapsedMs,
        'ledger.consumed.elapsedMs',
      ),
    });
  }

  if (!sameAmount(expectedReserved, reserved) || !sameUsage(expectedConsumed, consumed)) {
    return fail('ledger.reserved', 'budget_ledger_invariant');
  }

  return Object.freeze({
    tenantId,
    runId,
    utcDay,
    reserved,
    consumed,
    reservations,
    settlements,
  });
}
