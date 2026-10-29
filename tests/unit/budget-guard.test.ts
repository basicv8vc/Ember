import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, isDomainError } from '@ember/domain';
import {
  BUDGET_DIMENSIONS,
  BUDGET_GUARD_LIMITS,
  consumeBudgetReservation,
  createBudgetLedger,
  evaluateBudget,
  releaseBudgetReservation,
  reserveBudget,
  snapshotFromLedger,
  toBudgetDeniedError,
  toUtcDayKey,
  type BudgetAmount,
  type BudgetDimension,
  type BudgetLedgerState,
  type BudgetPolicy,
  type BudgetSnapshot,
  type BudgetUsage,
} from '@ember/execution';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const RUN_A = '33333333-3333-4333-8333-333333333333';
const RUN_B = '44444444-4444-4444-8444-444444444444';
const DAY = '2026-03-01';

const POLICY: BudgetPolicy = {
  policyId: 'mock-default',
  policyVersion: 3,
  maxRunSteps: 10,
  maxRunUnits: 1_000,
  maxRunElapsedMs: 60_000,
  maxTenantDailyUnits: 10_000,
  maxConcurrentSlots: 2,
};

const SNAPSHOT: BudgetSnapshot = {
  tenantId: TENANT_A,
  runId: RUN_A,
  utcDay: DAY,
  runSteps: 1,
  runUnits: 100,
  runElapsedMs: 1_000,
  tenantDailyUnits: 500,
  concurrentSlots: 1,
};

const COST: BudgetAmount = { steps: 1, units: 10, elapsedMs: 100, concurrencySlots: 1 };

/** Deliberately larger than `COST`, so a partial settlement leaves nothing outstanding. */
const STEP_AMOUNT: BudgetAmount = { steps: 2, units: 20, elapsedMs: 200, concurrencySlots: 1 };

/**
 * Every limit is exactly `SNAPSHOT + COST` per dimension, so one override is enough to target
 * a single dimension at the limit or at limit + 1.
 */
const EXACT_POLICY: BudgetPolicy = {
  ...POLICY,
  maxRunSteps: 2,
  maxRunUnits: 110,
  maxRunElapsedMs: 1_100,
  maxTenantDailyUnits: 510,
  maxConcurrentSlots: 2,
};

interface EvaluateOverrides {
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly snapshot?: Readonly<Record<string, unknown>>;
  readonly cost?: Readonly<Record<string, unknown>>;
}

/** Drives the public entry point with deliberately invalid values, hence the loose records. */
function evaluate(overrides: EvaluateOverrides = {}): ReturnType<typeof evaluateBudget> {
  return evaluateBudget(
    { ...EXACT_POLICY, ...overrides.policy },
    { ...SNAPSHOT, ...overrides.snapshot },
    { ...COST, ...overrides.cost },
  );
}

function expectInvalidArgument(run: () => unknown, expectedCode: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(InvalidArgumentError);
  expect(isDomainError(thrown) ? thrown.code : 'NOT_A_DOMAIN_ERROR').toBe('INVALID_ARGUMENT');
  expect(thrown instanceof InvalidArgumentError ? thrown.issues[0]?.code : undefined).toBe(
    expectedCode,
  );
}

describe('evaluateBudget allowance', () => {
  it('allows a cost whose projection stays inside every dimension', () => {
    expect(evaluate()).toEqual({
      allowed: true,
      policyId: POLICY.policyId,
      policyVersion: POLICY.policyVersion,
      tenantId: TENANT_A,
      runId: RUN_A,
      utcDay: DAY,
      projected: {
        runSteps: 2,
        runUnits: 110,
        runElapsedMs: 1_100,
        tenantDailyUnits: 510,
        concurrentSlots: 2,
      },
    });
  });

  it('treats every limit as inclusive: exactly at the limit is allowed', () => {
    const decision = evaluateBudget(EXACT_POLICY, SNAPSHOT, COST);

    expect(decision.allowed).toBe(true);
    expect(decision.allowed ? decision.projected : undefined).toEqual({
      runSteps: 2,
      runUnits: 110,
      runElapsedMs: 1_100,
      tenantDailyUnits: 510,
      concurrentSlots: 2,
    });
  });

  it('allows a zero cost against a snapshot that is still within every limit', () => {
    const decision = evaluate({ cost: { steps: 0, units: 0, elapsedMs: 0, concurrencySlots: 0 } });

    expect(decision.allowed).toBe(true);
    expect(decision.allowed ? decision.projected : undefined).toEqual({
      runSteps: SNAPSHOT.runSteps,
      runUnits: SNAPSHOT.runUnits,
      runElapsedMs: SNAPSHOT.runElapsedMs,
      tenantDailyUnits: SNAPSHOT.tenantDailyUnits,
      concurrentSlots: SNAPSHOT.concurrentSlots,
    });
  });

  it('keeps a zero cost fail-closed when the snapshot is already over a limit', () => {
    const decision = evaluate({
      snapshot: { runSteps: EXACT_POLICY.maxRunSteps + 1 },
      cost: { steps: 0, units: 0, elapsedMs: 0, concurrencySlots: 0 },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? undefined : decision).toMatchObject({
      dimension: 'run_steps',
      limit: EXACT_POLICY.maxRunSteps,
      used: EXACT_POLICY.maxRunSteps + 1,
      proposed: 0,
    });
  });

  it('treats maxConcurrentSlots: 0 as an explicit fail-closed configuration', () => {
    const decision = evaluate({ policy: { maxConcurrentSlots: 0 } });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? undefined : decision.dimension).toBe('concurrency_slots');
  });
});

const DENY_CASES: ReadonlyArray<readonly [BudgetDimension, BudgetPolicy, number]> = [
  ['run_steps', { ...EXACT_POLICY, maxRunSteps: 1 }, 2],
  ['run_units', { ...EXACT_POLICY, maxRunUnits: 109 }, 110],
  ['run_elapsed_ms', { ...EXACT_POLICY, maxRunElapsedMs: 1_099 }, 1_100],
  ['tenant_daily_units', { ...EXACT_POLICY, maxTenantDailyUnits: 509 }, 510],
  ['concurrency_slots', { ...EXACT_POLICY, maxConcurrentSlots: 1 }, 2],
];

describe('evaluateBudget denial', () => {
  for (const [dimension, policy, projected] of DENY_CASES) {
    it(`denies one unit past the ${dimension} limit`, () => {
      const decision = evaluateBudget(policy, SNAPSHOT, COST);

      if (decision.allowed) {
        throw new Error('expected a denial');
      }

      expect(decision.dimension).toBe(dimension);
      expect(decision.violations).toHaveLength(1);
      expect(decision.violations[0]).toEqual({
        dimension,
        limit: decision.limit,
        used: decision.used,
        proposed: decision.proposed,
        projected,
      });
      // A denial debits nothing, so it carries no projection at all.
      expect(Object.keys(decision).includes('projected')).toBe(false);
    });
  }

  it('reports every exceeded dimension in the stable BUDGET_DIMENSIONS order', () => {
    const decision = evaluateBudget(
      { ...EXACT_POLICY, maxRunSteps: 1, maxTenantDailyUnits: 0, maxConcurrentSlots: 0 },
      SNAPSHOT,
      COST,
    );

    if (decision.allowed) {
      throw new Error('expected a denial');
    }

    const exceeded = ['run_steps', 'tenant_daily_units', 'concurrency_slots'];

    expect(decision.dimension).toBe('run_steps');
    expect(decision.violations.map((violation) => violation.dimension)).toEqual(exceeded);
    expect(decision.violations.map((violation) => violation.dimension)).toEqual(
      BUDGET_DIMENSIONS.filter((dimension) => exceeded.includes(dimension)),
    );
  });

  it('counts the same units against both the Run cap and the Tenant-day cap', () => {
    const decision = evaluate({ policy: { maxRunUnits: 200, maxTenantDailyUnits: 509 } });

    if (decision.allowed) {
      throw new Error('expected a denial');
    }

    expect(decision.dimension).toBe('tenant_daily_units');
    expect(decision.limit).toBe(509);
    expect(decision.used).toBe(SNAPSHOT.tenantDailyUnits);
    expect(decision.proposed).toBe(COST.units);
  });

  it('scopes the Tenant-day dimension to one Tenant and one explicit UTC day', () => {
    const otherTenant = evaluate({
      snapshot: { tenantId: TENANT_B, runId: RUN_B, tenantDailyUnits: 0 },
    });
    const nextDay = evaluate({
      snapshot: { tenantId: TENANT_B, runId: RUN_B, utcDay: '2026-03-02', tenantDailyUnits: 0 },
    });
    const exhausted = evaluate({ snapshot: { tenantDailyUnits: 10_000 } });

    expect(otherTenant.allowed).toBe(true);
    expect(nextDay.allowed).toBe(true);
    expect(exhausted.allowed).toBe(false);
    expect(otherTenant.tenantId).toBe(TENANT_B);
    expect(nextDay.utcDay).toBe('2026-03-02');
  });

  it('denies as soon as one dimension is over while the others still fit', () => {
    const decision = evaluate({ policy: { maxRunElapsedMs: 1_099 } });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? undefined : decision.violations).toHaveLength(1);
  });
});

describe('evaluateBudget determinism and purity', () => {
  it('returns deep-equal, deeply frozen decisions for repeated calls', () => {
    const first = evaluateBudget(EXACT_POLICY, SNAPSHOT, COST);
    const second = evaluateBudget(EXACT_POLICY, SNAPSHOT, COST);

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);

    const denial = evaluateBudget({ ...EXACT_POLICY, maxRunSteps: 0 }, SNAPSHOT, COST);

    if (denial.allowed) {
      throw new Error('expected a denial');
    }

    expect(Object.isFrozen(denial.violations)).toBe(true);
    expect(Object.isFrozen(denial.violations[0])).toBe(true);
    expect(evaluateBudget({ ...EXACT_POLICY, maxRunSteps: 0 }, SNAPSHOT, COST)).toEqual(denial);
  });

  it('never mutates its arguments', () => {
    const policy = { ...EXACT_POLICY };
    const snapshot = { ...SNAPSHOT };
    const cost = { ...COST };

    evaluateBudget(policy, snapshot, cost);

    expect(policy).toEqual(EXACT_POLICY);
    expect(snapshot).toEqual(SNAPSHOT);
    expect(cost).toEqual(COST);
  });
});

describe('evaluateBudget validation', () => {
  it('rejects negative, fractional, non-finite and unsafe cost values', () => {
    expectInvalidArgument(() => evaluate({ cost: { steps: -1 } }), 'invalid_budget_amount');
    expectInvalidArgument(() => evaluate({ cost: { units: 1.5 } }), 'invalid_budget_amount');
    expectInvalidArgument(
      () => evaluate({ cost: { elapsedMs: Number.NaN } }),
      'invalid_budget_amount',
    );
    expectInvalidArgument(
      () => evaluate({ cost: { concurrencySlots: Number.POSITIVE_INFINITY } }),
      'invalid_budget_amount',
    );
    expectInvalidArgument(
      () => evaluate({ cost: { steps: Number.MAX_SAFE_INTEGER + 2 } }),
      'invalid_budget_amount',
    );
    expectInvalidArgument(() => evaluate({ cost: { steps: '1' } }), 'invalid_budget_amount');
    expectInvalidArgument(() => evaluate({ cost: { steps: undefined } }), 'invalid_budget_amount');
  });

  it('rejects unknown, non-object and partially specified inputs', () => {
    expectInvalidArgument(() => evaluate({ cost: { currency: 'usd' } }), 'unknown_field');
    expectInvalidArgument(() => evaluate({ policy: { maxMonthlySpend: 1 } }), 'unknown_field');
    expectInvalidArgument(() => evaluate({ snapshot: { day: DAY } }), 'unknown_field');
    expectInvalidArgument(
      () => evaluateBudget(null as unknown as BudgetPolicy, SNAPSHOT, COST),
      'invalid_object',
    );
    expectInvalidArgument(
      () => evaluateBudget(EXACT_POLICY, [] as unknown as BudgetSnapshot, COST),
      'invalid_object',
    );
  });

  it('rejects invalid identities and day keys instead of coercing them', () => {
    expectInvalidArgument(() => evaluate({ snapshot: { tenantId: 'tenant-a' } }), 'invalid_id');
    expectInvalidArgument(() => evaluate({ snapshot: { runId: RUN_A.slice(1) } }), 'invalid_id');
    expectInvalidArgument(
      () => evaluate({ snapshot: { utcDay: '2026-02-30' } }),
      'invalid_utc_day',
    );
    expectInvalidArgument(() => evaluate({ snapshot: { utcDay: '2026-3-1' } }), 'invalid_utc_day');
    expectInvalidArgument(
      () => evaluate({ snapshot: { utcDay: '2026-03-01T00:00:00Z' } }),
      'invalid_utc_day',
    );
  });

  it('rejects invalid policy identifiers and limits', () => {
    expectInvalidArgument(() => evaluate({ policy: { policyId: '' } }), 'invalid_policy_id');
    expectInvalidArgument(
      () =>
        evaluate({ policy: { policyId: 'a'.repeat(BUDGET_GUARD_LIMITS.maxPolicyIdChars + 1) } }),
      'invalid_policy_id',
    );
    expectInvalidArgument(
      () => evaluate({ policy: { policyVersion: -1 } }),
      'invalid_policy_version',
    );
    expectInvalidArgument(
      () => evaluate({ policy: { policyVersion: 1.5 } }),
      'invalid_policy_version',
    );
    expectInvalidArgument(() => evaluate({ policy: { maxRunSteps: -1 } }), 'invalid_budget_amount');
    expectInvalidArgument(
      () => evaluate({ policy: { maxTenantDailyUnits: Number.POSITIVE_INFINITY } }),
      'invalid_budget_amount',
    );
  });

  it('rejects arithmetic overflow instead of wrapping', () => {
    expectInvalidArgument(
      () =>
        evaluate({
          policy: {
            maxRunSteps: Number.MAX_SAFE_INTEGER,
            maxRunUnits: Number.MAX_SAFE_INTEGER,
            maxRunElapsedMs: Number.MAX_SAFE_INTEGER,
            maxTenantDailyUnits: Number.MAX_SAFE_INTEGER,
            maxConcurrentSlots: Number.MAX_SAFE_INTEGER,
          },
          snapshot: { runSteps: Number.MAX_SAFE_INTEGER },
          cost: { steps: 1 },
        }),
      'budget_amount_overflow',
    );
  });
});

describe('toBudgetDeniedError', () => {
  it('reuses BUDGET_EXCEEDED and keeps the numbers internal', () => {
    const decision = evaluateBudget({ ...EXACT_POLICY, maxRunSteps: 1 }, SNAPSHOT, COST);

    if (decision.allowed) {
      throw new Error('expected a denial');
    }

    const error = toBudgetDeniedError(decision);

    expect(isDomainError(error)).toBe(true);
    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(error.publicMessage).toBe('Budget exceeded');
    expect(error.toJSON()).toEqual({
      code: 'BUDGET_EXCEEDED',
      message: 'Budget exceeded',
      retryable: 'not_retryable',
    });
    expect(error.diagnostic).toContain('run_steps');
    expect(error.diagnostic).not.toContain(TENANT_A);
    expect(error.diagnostic).not.toContain(RUN_A);
  });
});

describe('toUtcDayKey', () => {
  it('formats an explicit instant as an explicit UTC day key', () => {
    expect(toUtcDayKey(new Date('2026-03-01T23:59:59.999Z'))).toBe('2026-03-01');
    expect(toUtcDayKey(new Date('2026-03-02T00:00:00.000Z'))).toBe('2026-03-02');
  });

  it('rejects invalid and out-of-range instants', () => {
    expectInvalidArgument(() => toUtcDayKey(new Date(Number.NaN)), 'invalid_date');
    expectInvalidArgument(
      () => toUtcDayKey(new Date('0000-01-01T00:00:00.000Z')),
      'date_out_of_range',
    );
    expectInvalidArgument(() => toUtcDayKey('2026-03-01' as unknown as Date), 'invalid_date');
  });
});

const LEDGER = createBudgetLedger({ tenantId: TENANT_A, runId: RUN_A, utcDay: DAY });

function reservedLedger(operationId = 'step-1'): BudgetLedgerState {
  return reserveBudget(LEDGER, { operationId, amount: STEP_AMOUNT });
}

describe('budget ledger reservation', () => {
  it('starts empty and frozen', () => {
    expect(LEDGER).toEqual({
      tenantId: TENANT_A,
      runId: RUN_A,
      utcDay: DAY,
      reserved: { steps: 0, units: 0, elapsedMs: 0, concurrencySlots: 0 },
      consumed: { steps: 0, units: 0, elapsedMs: 0 },
      reservations: [],
      settlements: [],
    });
    expect(Object.isFrozen(LEDGER)).toBe(true);
    expect(Object.isFrozen(LEDGER.reservations)).toBe(true);
  });

  it('adds an outstanding reservation without touching consumed usage', () => {
    const state = reservedLedger();

    expect(state.reserved).toEqual({ steps: 2, units: 20, elapsedMs: 200, concurrencySlots: 1 });
    expect(state.consumed).toEqual({ steps: 0, units: 0, elapsedMs: 0 });
    expect(state.reservations).toHaveLength(1);
    expect(state.settlements).toHaveLength(0);
  });

  it('exposes outstanding reservations through the next-step snapshot', () => {
    expect(snapshotFromLedger(reservedLedger(), 500)).toEqual({
      tenantId: TENANT_A,
      runId: RUN_A,
      utcDay: DAY,
      runSteps: 2,
      runUnits: 20,
      runElapsedMs: 200,
      tenantDailyUnits: 500,
      concurrentSlots: 1,
    });

    // Two outstanding slots plus one more proposed exceeds the cap of 2, even though each
    // reservation alone would fit: outstanding reservations are visible to the next decision.
    const decision = evaluateBudget(
      POLICY,
      snapshotFromLedger(
        reserveBudget(reservedLedger('step-2'), {
          operationId: 'step-3',
          amount: { steps: 0, units: 0, elapsedMs: 0, concurrencySlots: 1 },
        }),
        500,
      ),
      COST,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? undefined : decision.dimension).toBe('concurrency_slots');
  });

  it('is idempotent for the same operation id and rejects a conflicting amount', () => {
    const state = reservedLedger();

    expect(reserveBudget(state, { operationId: 'step-1', amount: STEP_AMOUNT })).toEqual(state);
    expect(state.reserved).toEqual({ steps: 2, units: 20, elapsedMs: 200, concurrencySlots: 1 });
    expectInvalidArgument(
      () => reserveBudget(state, { operationId: 'step-1', amount: COST }),
      'budget_reservation_conflict',
    );
  });

  it('rejects an operation id that was already settled', () => {
    const settled = releaseBudgetReservation(reservedLedger(), 'step-1');

    expectInvalidArgument(
      () => reserveBudget(settled, { operationId: 'step-1', amount: STEP_AMOUNT }),
      'budget_reservation_already_settled',
    );
  });

  it('rejects an invalid reservation payload', () => {
    expectInvalidArgument(
      () => reserveBudget(LEDGER, { operationId: '', amount: COST }),
      'invalid_operation_id',
    );
    expectInvalidArgument(
      () => reserveBudget(LEDGER, { operationId: 'step-1', amount: { ...COST, steps: -1 } }),
      'invalid_budget_amount',
    );
    expectInvalidArgument(
      () =>
        reserveBudget(LEDGER, {
          operationId: 'step-1',
          amount: { ...COST, currency: 'usd' },
        } as unknown as Parameters<typeof reserveBudget>[1]),
      'unknown_field',
    );
  });

  it('bounds the local operation log', () => {
    let state = LEDGER;

    for (let index = 0; index < BUDGET_GUARD_LIMITS.maxLedgerOperations; index += 1) {
      state = reserveBudget(state, { operationId: `step-${index}`, amount: COST });
    }

    expect(state.reservations).toHaveLength(BUDGET_GUARD_LIMITS.maxLedgerOperations);
    expectInvalidArgument(
      () => reserveBudget(state, { operationId: 'one-too-many', amount: COST }),
      'budget_ledger_capacity',
    );
  });
});

describe('budget ledger settlement', () => {
  const CONSUMED: BudgetUsage = { steps: 1, units: 5, elapsedMs: 100 };

  it('consumes the used part and releases the unused remainder', () => {
    const settled = consumeBudgetReservation(reservedLedger(), {
      operationId: 'step-1',
      consumed: CONSUMED,
    });

    expect(settled.consumed).toEqual(CONSUMED);
    // Nothing stays outstanding: the reservation left `reserved` entirely, only the consumed
    // part is recorded, and 1 step / 15 units / 100 ms / 1 slot are released.
    expect(settled.reserved).toEqual({ steps: 0, units: 0, elapsedMs: 0, concurrencySlots: 0 });
    expect(settled.settlements).toEqual([{ operationId: 'step-1', consumed: CONSUMED }]);
    expect(snapshotFromLedger(settled, 500)).toEqual({
      tenantId: TENANT_A,
      runId: RUN_A,
      utcDay: DAY,
      runSteps: CONSUMED.steps,
      runUnits: CONSUMED.units,
      runElapsedMs: CONSUMED.elapsedMs,
      tenantDailyUnits: 500,
      concurrentSlots: 0,
    });
  });

  it('releases a fully unspent reservation without consuming anything', () => {
    const released = releaseBudgetReservation(reservedLedger(), 'step-1');

    expect(released.reserved).toEqual({ steps: 0, units: 0, elapsedMs: 0, concurrencySlots: 0 });
    expect(released.consumed).toEqual({ steps: 0, units: 0, elapsedMs: 0 });
    expect(snapshotFromLedger(released, 500)).toEqual({
      tenantId: TENANT_A,
      runId: RUN_A,
      utcDay: DAY,
      runSteps: 0,
      runUnits: 0,
      runElapsedMs: 0,
      tenantDailyUnits: 500,
      concurrentSlots: 0,
    });
  });

  it('never refunds consumed usage on a later release', () => {
    const settled = consumeBudgetReservation(reservedLedger(), {
      operationId: 'step-1',
      consumed: CONSUMED,
    });

    expect(releaseBudgetReservation(settled, 'step-1')).toEqual(settled);
    expect(releaseBudgetReservation(settled, 'step-1').consumed).toEqual(CONSUMED);
  });

  it('settles the same operation idempotently and rejects a conflicting repeat', () => {
    const settled = consumeBudgetReservation(reservedLedger(), {
      operationId: 'step-1',
      consumed: CONSUMED,
    });

    expect(
      consumeBudgetReservation(settled, { operationId: 'step-1', consumed: CONSUMED }),
    ).toEqual(settled);
    expectInvalidArgument(
      () =>
        consumeBudgetReservation(settled, {
          operationId: 'step-1',
          consumed: { ...CONSUMED, units: 6 },
        }),
      'budget_settlement_conflict',
    );
  });

  it('rejects settlement of an unknown operation or more than was reserved', () => {
    expectInvalidArgument(
      () =>
        consumeBudgetReservation(LEDGER, {
          operationId: 'ghost',
          consumed: { steps: 0, units: 0, elapsedMs: 0 },
        }),
      'budget_unknown_reservation',
    );
    expectInvalidArgument(
      () =>
        consumeBudgetReservation(reservedLedger(), {
          operationId: 'step-1',
          consumed: { ...CONSUMED, steps: 3 },
        }),
      'budget_consumption_exceeds_reservation',
    );
  });

  it('keeps consumed usage monotonic across operations', () => {
    const first = consumeBudgetReservation(reservedLedger('step-1'), {
      operationId: 'step-1',
      consumed: CONSUMED,
    });
    const second = consumeBudgetReservation(
      reserveBudget(first, { operationId: 'step-2', amount: COST }),
      {
        operationId: 'step-2',
        consumed: { steps: 1, units: 1, elapsedMs: 10 },
      },
    );

    expect(second.consumed).toEqual({ steps: 2, units: 6, elapsedMs: 110 });
    expect(second.reserved.concurrencySlots).toBe(0);
  });
});

describe('budget ledger invariants', () => {
  it('rejects a ledger whose totals disagree with its own operation log', () => {
    const state = reservedLedger();

    expectInvalidArgument(
      () =>
        consumeBudgetReservation(
          { ...state, reserved: { steps: 0, units: 0, elapsedMs: 0, concurrencySlots: 0 } },
          { operationId: 'step-1', consumed: { steps: 0, units: 0, elapsedMs: 0 } },
        ),
      'budget_ledger_invariant',
    );
  });

  it('rejects a settlement list that references an unknown reservation', () => {
    const state = reservedLedger();

    expectInvalidArgument(
      () =>
        releaseBudgetReservation(
          {
            ...state,
            settlements: [{ operationId: 'ghost', consumed: { steps: 0, units: 0, elapsedMs: 0 } }],
          },
          'step-1',
        ),
      'budget_ledger_invariant',
    );
  });

  it('rejects invalid ledger shapes and scopes', () => {
    expectInvalidArgument(() => releaseBudgetReservation(LEDGER, ' '), 'invalid_operation_id');
    expectInvalidArgument(
      () => snapshotFromLedger({ ...LEDGER, utcDay: '2026-13-01' }, 0),
      'invalid_utc_day',
    );
    expectInvalidArgument(() => snapshotFromLedger(LEDGER, -1), 'invalid_budget_amount');
    expectInvalidArgument(
      () => createBudgetLedger({ tenantId: 'tenant-a', runId: RUN_A, utcDay: DAY }),
      'invalid_id',
    );
    expectInvalidArgument(
      () =>
        reserveBudget({ ...LEDGER, extra: true } as unknown as BudgetLedgerState, {
          operationId: 'step-1',
          amount: COST,
        }),
      'unknown_field',
    );
  });
});
