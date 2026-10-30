import { describe, expect, it } from 'vitest';
import type { RunGrant } from '@ember/contracts';
import { InvalidArgumentError } from '@ember/domain';
import type { BudgetPolicy } from '@ember/execution';
import { PostgresBudgetLedger } from '@ember/postgres';

/**
 * B08b-D1 — input validation of the durable budget ledger.
 *
 * Everything asserted here happens *before* a transaction is opened, which is why these cases
 * can run as unit tests: the stub pool records every call and the suite asserts it was never
 * touched. A malformed amount must fail closed rather than be rounded, coerced or ignored,
 * because a silently reinterpreted budget number is a budget number that can be exceeded.
 */

const POLICY: BudgetPolicy = Object.freeze({
  policyId: 'unit-budget',
  policyVersion: 4,
  maxRunSteps: 10,
  maxRunUnits: 1_000,
  maxRunElapsedMs: 60_000,
  maxTenantDailyUnits: 10_000,
  maxConcurrentSlots: 4,
});

const GRANT: RunGrant = Object.freeze({
  tenantId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  agentId: '44444444-4444-4444-8444-444444444444',
  attempt: 1,
  leaseEpoch: 2,
  workerId: 'unit-worker',
});

const COST = Object.freeze({ steps: 1, units: 5, elapsedMs: 50, concurrencySlots: 1 });

interface Probe {
  readonly ledger: PostgresBudgetLedger;
  readonly calls: string[];
}

/** The pool type the adapter accepts, derived so this test needs no driver import. */
type LedgerPool = ConstructorParameters<typeof PostgresBudgetLedger>[0];

/** A pool that records (and refuses) any attempt to reach the database. */
function probe(): Probe {
  const calls: string[] = [];
  const record = (name: string) => (): never => {
    calls.push(name);
    throw new Error(`the ledger touched the pool (${name})`);
  };
  const pool = { query: record('query'), connect: record('connect') } as unknown as LedgerPool;

  return { ledger: new PostgresBudgetLedger(pool, { policy: POLICY }), calls };
}

async function refused(
  call: () => Promise<unknown>,
): Promise<readonly { path: string; code: string }[]> {
  const error = await call().then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(InvalidArgumentError);

  return (error as InvalidArgumentError).issues;
}

describe('budget ledger input validation', () => {
  const invalidCosts: readonly [string, unknown, { path: string; code: string }][] = [
    ['a missing cost', undefined, { path: 'cost', code: 'not_an_object' }],
    ['a null cost', null, { path: 'cost', code: 'not_an_object' }],
    ['an array cost', [], { path: 'cost', code: 'not_an_object' }],
    [
      'an unknown dimension',
      { ...COST, carryOver: 100 },
      { path: 'cost.carryOver', code: 'unknown_field' },
    ],
    [
      'a fractional unit',
      { ...COST, units: 1.5 },
      { path: 'cost.units', code: 'not_a_non_negative_safe_integer' },
    ],
    [
      'a negative elapsed time',
      { ...COST, elapsedMs: -1 },
      { path: 'cost.elapsedMs', code: 'not_a_non_negative_safe_integer' },
    ],
    [
      'NaN',
      { ...COST, steps: Number.NaN },
      { path: 'cost.steps', code: 'not_a_non_negative_safe_integer' },
    ],
    [
      'Infinity',
      { ...COST, units: Number.POSITIVE_INFINITY },
      { path: 'cost.units', code: 'not_a_non_negative_safe_integer' },
    ],
    [
      'an unsafe integer',
      { ...COST, units: Number.MAX_SAFE_INTEGER + 2 },
      { path: 'cost.units', code: 'not_a_non_negative_safe_integer' },
    ],
    [
      'a string amount',
      { ...COST, units: '5' },
      { path: 'cost.units', code: 'not_a_non_negative_safe_integer' },
    ],
    [
      'a fan-out reservation',
      { ...COST, concurrencySlots: 2 },
      { path: 'cost.concurrencySlots', code: 'concurrency_slots_above_one' },
    ],
  ];

  for (const [label, cost, issue] of invalidCosts) {
    it(`refuses ${label} without opening a transaction`, async () => {
      const { ledger, calls } = probe();

      const issues = await refused(() =>
        ledger.reserve(GRANT, { operationId: 'step:produce:abc:1', cost: cost as never }),
      );

      expect(issues).toEqual([issue]);
      expect(calls).toEqual([]);
    });
  }

  it('refuses a negative settlement amount', async () => {
    const { ledger, calls } = probe();

    const issues = await refused(() =>
      ledger.settle(GRANT, {
        operationId: 'step:produce:abc:1',
        consumed: { ...COST, steps: -1 },
      }),
    );

    expect(issues).toEqual([{ path: 'consumed.steps', code: 'not_a_non_negative_safe_integer' }]);
    expect(calls).toEqual([]);
  });

  it('lets a zero amount through, because a zero cost is a real decision', async () => {
    // Zero is legal and fail-closed rather than an omission, so validation must not reject it.
    // Reaching the stub pool is the proof that it was accepted (the stub's own failure is then
    // reported as the usual fail-closed `DB_UNAVAILABLE`).
    const { ledger, calls } = probe();

    const error = await ledger
      .reserve(GRANT, {
        operationId: 'step:produce:abc:1',
        cost: { steps: 0, units: 0, elapsedMs: 0, concurrencySlots: 0 },
      })
      .then(
        () => {
          throw new Error('expected the stub pool to fail the call');
        },
        (caught: unknown) => caught,
      );

    expect(error).not.toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(calls.length).toBeGreaterThan(0);
  });

  describe('budget ledger operation id validation', () => {
    const invalidIds: readonly [string, unknown][] = [
      ['an empty id', ''],
      ['a missing id', undefined],
      ['a leading separator', ':produce'],
      ['an id with a space', 'step produce'],
      ['an id with a newline', 'step:produce\n1'],
      ['a 129 character id', `a${'b'.repeat(128)}`],
      ['a non-string id', 42],
    ];

    for (const [label, operationId] of invalidIds) {
      it(`refuses ${label}`, async () => {
        const { ledger, calls } = probe();

        const issues = await refused(() =>
          ledger.reserve(GRANT, { operationId: operationId as never, cost: COST }),
        );

        expect(issues).toEqual([{ path: 'operationId', code: 'invalid_operation_id' }]);
        expect(calls).toEqual([]);
      });
    }

    it('refuses to release an unnamed operation', async () => {
      const { ledger, calls } = probe();

      const issues = await refused(() => ledger.release(GRANT, { operationId: '' }));

      expect(issues).toEqual([{ path: 'operationId', code: 'invalid_operation_id' }]);
      expect(calls).toEqual([]);
    });
  });

  describe('budget ledger grant validation', () => {
    // The scope comes from the server-derived grant, never from the request: a grant that cannot
    // name its Tenant or Run must fail before the ledger reads any usage.
    const invalidGrants: readonly [string, Partial<RunGrant>][] = [
      ['a tenant that is not an id', { tenantId: 'not-a-uuid' }],
      ['an empty run id', { runId: '' }],
      ['an empty task id', { taskId: '' }],
    ];

    for (const [label, patch] of invalidGrants) {
      it(`refuses ${label}`, async () => {
        const { ledger, calls } = probe();

        await expect(ledger.snapshot({ ...GRANT, ...patch })).rejects.toBeInstanceOf(
          InvalidArgumentError,
        );
        expect(calls).toEqual([]);
      });
    }
  });
});
