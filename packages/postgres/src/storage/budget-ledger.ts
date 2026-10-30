import { randomUUID } from 'node:crypto';
import { IdSchema, toInvalidArgumentError } from '@ember/contracts';
import type {
  BudgetLedger,
  BudgetLedgerSnapshot,
  BudgetOperation,
  BudgetOperationState,
  BudgetReleaseRequest,
  BudgetReservationAmount,
  BudgetReserveRequest,
  BudgetSettleRequest,
  RunGrant,
} from '@ember/contracts';
import { DomainError, InvalidArgumentError } from '@ember/domain';
import {
  evaluateBudget,
  toBudgetDeniedError,
  toUtcDayKey,
  type BudgetPolicy,
} from '@ember/execution';
import type pg from 'pg';
import { parseLeaseEpoch } from '../lease-queue/validation.js';
import { toIsoTimestamp, withTransaction } from '../repositories/support.js';
import { lockAndAssertLive, postLockInstant } from './result-committer.js';

/**
 * Persistent, transactional budget enforcement (B08b-D1).
 *
 * P0B-08a answers "may this operation run?" against an immutable in-process ledger. This
 * adapter is the durable authority that question is asked of, and it closes exactly the two
 * gaps P0B-08a declared out of scope:
 *
 * - **Atomicity across processes.** `reserve` holds one Tenant-scoped advisory lock for the
 *   whole `aggregate usage → evaluate policy → insert reservation` sequence, so two Workers
 *   can no longer both observe the same spare quota and both proceed.
 * - **Trusted history.** Run counters are aggregated from the committed operation rows of
 *   *every* UTC day of the Run, so a caller cannot declare `runCarryOver` and reset a Run's
 *   budget, and an `operationId` is unique per Run regardless of the day (P0B-08a §6.1).
 *
 * ```text
 * reserve: Tenant advisory lock → tasks row → runs row → clock_timestamp()
 *            → lease/cancel/deadline re-check → budget rows → sweep → resolve replay
 *            → aggregate usage → evaluateBudget → INSERT reservation
 * settle:  row lock on one operation → database-time terminal decision
 *            → settled(actual) if live, expired(full) if past the lease boundary
 * release: row lock on one operation → database-time terminal decision
 *            → released(0) if live, expired(full) if past the lease boundary
 * ```
 *
 * The shared row order after the budget lock is Task → Run, which matches the result committer.
 * Heartbeat follows Task → Run → budget rows. No path acquires the Tenant advisory lock after
 * row locks or waits for Task/Run while holding a budget row, so these paths do not form a cycle.
 *
 * Nothing is charged before the policy allows it, and a denial rolls the transaction back, so
 * a denied step leaves zero rows and no side effect. `settle` and `release` take no advisory
 * lock: an operation that already ran must never queue behind another Run's decision.
 *
 * A reservation is bound to the lease that created it (`lease_epoch`, `expires_at`) and is
 * charged in full when that lease dies. Killing a Worker therefore cannot refund quota, and a
 * re-claimed Run cannot settle an earlier attempt's reservation.
 */

/** Cross-process coordination namespace for budget decisions. */
export const BUDGET_LOCK_NAMESPACE = 'ember.budget';

const ADVISORY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The four budget dimensions of one amount, in reporting order. */
const AMOUNT_KEYS = ['steps', 'units', 'elapsedMs', 'concurrencySlots'] as const;

const OPERATION_COLUMNS = `
  id, tenant_id, task_id, run_id, lease_epoch::text AS lease_epoch, policy_version, operation_id,
  reserved_steps, reserved_units::text AS reserved_units,
  reserved_elapsed_ms::text AS reserved_elapsed_ms, reserved_slots,
  consumed_steps, consumed_units::text AS consumed_units,
  consumed_elapsed_ms::text AS consumed_elapsed_ms, consumed_slots,
  state, to_char(utc_day, 'YYYY-MM-DD') AS utc_day, expires_at, settled_at
`;

/** `reserved` counts at the reserved amount; every terminal state counts what it consumed. */
const EFFECTIVE = {
  steps: `CASE WHEN state = 'reserved' THEN reserved_steps ELSE consumed_steps END`,
  units: `CASE WHEN state = 'reserved' THEN reserved_units ELSE consumed_units END`,
  elapsedMs: `CASE WHEN state = 'reserved' THEN reserved_elapsed_ms ELSE consumed_elapsed_ms END`,
  slots: `CASE WHEN state = 'reserved' THEN reserved_slots ELSE consumed_slots END`,
} as const;

const RUN_USAGE_SQL = `
SELECT COALESCE(SUM(${EFFECTIVE.steps}), 0)::text AS steps,
       COALESCE(SUM(${EFFECTIVE.units}), 0)::text AS units,
       COALESCE(SUM(${EFFECTIVE.elapsedMs}), 0)::text AS elapsed_ms,
       COALESCE(SUM(${EFFECTIVE.slots}), 0)::text AS slots
  FROM budget_operations
 WHERE tenant_id = $1 AND run_id = $2
`;

/** Tenant-day units. A reservation is charged to the UTC day it was taken from. */
const TENANT_DAY_SQL = `
SELECT COALESCE(SUM(${EFFECTIVE.units}), 0)::text AS units
  FROM budget_operations
 WHERE tenant_id = $1 AND utc_day = $2::date
`;

/** Concurrency is a gauge, not a counter: every live reservation holds its slots. */
const TENANT_SLOT_SQL = `
SELECT COALESCE(SUM(reserved_slots), 0)::text AS slots
  FROM budget_operations
 WHERE tenant_id = $1 AND state = 'reserved'
`;

/**
 * Charge the quota of attempts whose lease died. A reservation can only outlive its lease if
 * the Worker that held it stopped, and that Worker may already have produced the side effect,
 * so the full reserved amount is charged instead of being handed back.
 */
const SWEEP_EXPIRED_SQL = `
UPDATE budget_operations
   SET state = 'expired',
       consumed_steps = reserved_steps,
       consumed_units = reserved_units,
       consumed_elapsed_ms = reserved_elapsed_ms,
       consumed_slots = reserved_slots,
       settled_at = $2
 WHERE tenant_id = $1
   AND state = 'reserved'
   AND expires_at <= $2
`;

const INSERT_OPERATION_SQL = `
INSERT INTO budget_operations (
  id, tenant_id, task_id, run_id, lease_epoch, policy_version, operation_id,
  reserved_steps, reserved_units, reserved_elapsed_ms, reserved_slots,
  state, utc_day, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'reserved', $12::date, $13)
ON CONFLICT (tenant_id, run_id, operation_id) DO NOTHING
RETURNING ${OPERATION_COLUMNS}
`;

const SELECT_OPERATION_SQL = `
SELECT ${OPERATION_COLUMNS}
  FROM budget_operations
 WHERE tenant_id = $1 AND run_id = $2 AND operation_id = $3
 FOR UPDATE
`;

const SETTLE_OPERATION_SQL = `
WITH decision_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS decision_at
)
UPDATE budget_operations AS operation
   SET state = CASE
         WHEN operation.expires_at <= decision.decision_at THEN 'expired'
         ELSE 'settled'
       END,
       consumed_steps = CASE
         WHEN operation.expires_at <= decision.decision_at THEN operation.reserved_steps
         ELSE $4
       END,
       consumed_units = CASE
         WHEN operation.expires_at <= decision.decision_at THEN operation.reserved_units
         ELSE $5
       END,
       consumed_elapsed_ms = CASE
         WHEN operation.expires_at <= decision.decision_at THEN operation.reserved_elapsed_ms
         ELSE $6
       END,
       consumed_slots = CASE
         WHEN operation.expires_at <= decision.decision_at THEN operation.reserved_slots
         ELSE $7
       END,
       settled_at = decision.decision_at
  FROM decision_clock AS decision
 WHERE operation.tenant_id = $1
   AND operation.run_id = $2
   AND operation.operation_id = $3
   AND operation.state = 'reserved'
RETURNING ${OPERATION_COLUMNS}
`;

const RELEASE_OPERATION_SQL = `
WITH decision_clock AS MATERIALIZED (
  SELECT clock_timestamp() AS decision_at
)
UPDATE budget_operations AS operation
   SET state = CASE
         WHEN operation.expires_at <= decision.decision_at THEN 'expired'
         ELSE 'released'
       END,
       consumed_steps = CASE
         WHEN operation.expires_at <= decision.decision_at THEN operation.reserved_steps
         ELSE 0
       END,
       consumed_units = CASE
         WHEN operation.expires_at <= decision.decision_at THEN operation.reserved_units
         ELSE 0
       END,
       consumed_elapsed_ms = CASE
         WHEN operation.expires_at <= decision.decision_at THEN operation.reserved_elapsed_ms
         ELSE 0
       END,
       consumed_slots = CASE
         WHEN operation.expires_at <= decision.decision_at THEN operation.reserved_slots
         ELSE 0
       END,
       settled_at = decision.decision_at
  FROM decision_clock AS decision
 WHERE operation.tenant_id = $1
   AND operation.run_id = $2
   AND operation.operation_id = $3
   AND operation.state = 'reserved'
RETURNING ${OPERATION_COLUMNS}
`;

export interface PostgresBudgetLedgerOptions {
  /**
   * Trusted policy revision. It is Worker configuration, never a Task payload field and never
   * a client request field, exactly like the lease/retry policy of the result committer.
   */
  readonly policy: BudgetPolicy;
}

interface OperationRow {
  id: string;
  tenant_id: string;
  task_id: string;
  run_id: string;
  lease_epoch: string;
  policy_version: number;
  operation_id: string;
  reserved_steps: number;
  reserved_units: string;
  reserved_elapsed_ms: string;
  reserved_slots: number;
  consumed_steps: number;
  consumed_units: string;
  consumed_elapsed_ms: string;
  consumed_slots: number;
  state: string;
  utc_day: string;
  expires_at: Date | string;
  settled_at: Date | string | null;
}

interface UsageRow {
  steps: string;
  units: string;
  elapsed_ms: string;
  slots: string;
}

function invalid(path: string, code: string): never {
  throw new InvalidArgumentError([{ path, code }]);
}

function parseOperationId(value: unknown): string {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    invalid('operationId', 'invalid_operation_id');
  }

  return value;
}

/**
 * Strict amount validation. Fractions, negatives, `NaN`, `Infinity`, unsafe integers and
 * unknown fields are refused instead of being rounded, coerced or ignored: a budget number
 * that is silently reinterpreted is a budget number that can be exceeded.
 */
function parseAmount(value: unknown, field: string): BudgetReservationAmount {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(field, 'not_an_object');
  }

  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(AMOUNT_KEYS as readonly string[]).includes(key)) {
      invalid(`${field}.${key}`, 'unknown_field');
    }
  }

  const read = (key: (typeof AMOUNT_KEYS)[number]): number => {
    const raw = record[key];

    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
      invalid(`${field}.${key}`, 'not_a_non_negative_safe_integer');
    }

    return raw;
  };

  const concurrencySlots = read('concurrencySlots');

  // One operation is one unit of work; two slots would let a single step exceed the gauge it
  // claims to observe, and the column enforces the same bound.
  if (concurrencySlots > 1) {
    invalid(`${field}.concurrencySlots`, 'concurrency_slots_above_one');
  }

  return Object.freeze({
    steps: read('steps'),
    units: read('units'),
    elapsedMs: read('elapsedMs'),
    concurrencySlots,
  });
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DomainError(
      'DB_UNAVAILABLE',
      `persisted budget aggregate ${field} is not a non-negative safe integer`,
    );
  }

  return parsed;
}

function sameAmount(left: BudgetReservationAmount, right: BudgetReservationAmount): boolean {
  return (
    left.steps === right.steps &&
    left.units === right.units &&
    left.elapsedMs === right.elapsedMs &&
    left.concurrencySlots === right.concurrencySlots
  );
}

const RESERVATION_STATES: readonly BudgetOperationState[] = [
  'reserved',
  'settled',
  'released',
  'expired',
];

function parseState(value: string): BudgetOperationState {
  const state = RESERVATION_STATES.find((candidate) => candidate === value);

  if (state === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted budget operation has an unknown state');
  }

  return state;
}

interface BudgetScope {
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
}

/**
 * Tenant/Task/Run scope taken from the server-derived `RunGrant`.
 *
 * The grant is validated, never the request: a budget write can never name another Tenant,
 * Task or Run, and a malformed id fails before a transaction is opened.
 */
function budgetScope(grant: RunGrant): BudgetScope {
  const tenantId = IdSchema.safeParse(grant.tenantId);
  const taskId = IdSchema.safeParse(grant.taskId);
  const runId = IdSchema.safeParse(grant.runId);

  if (!tenantId.success) {
    throw toInvalidArgumentError(tenantId.error);
  }

  if (!taskId.success) {
    throw toInvalidArgumentError(taskId.error);
  }

  if (!runId.success) {
    throw toInvalidArgumentError(runId.error);
  }

  return Object.freeze({ tenantId: tenantId.data, taskId: taskId.data, runId: runId.data });
}

function budgetLockKey(tenantId: string): string {
  return `${BUDGET_LOCK_NAMESPACE}:${tenantId}`;
}

function toOperation(row: OperationRow, replayed: boolean): BudgetOperation {
  return Object.freeze({
    tenantId: row.tenant_id,
    taskId: row.task_id,
    runId: row.run_id,
    operationId: row.operation_id,
    leaseEpoch: parseLeaseEpoch(row.lease_epoch),
    state: parseState(row.state),
    reserved: Object.freeze({
      steps: toSafeInteger(row.reserved_steps, 'reserved.steps'),
      units: toSafeInteger(row.reserved_units, 'reserved.units'),
      elapsedMs: toSafeInteger(row.reserved_elapsed_ms, 'reserved.elapsedMs'),
      concurrencySlots: toSafeInteger(row.reserved_slots, 'reserved.concurrencySlots'),
    }),
    consumed: Object.freeze({
      steps: toSafeInteger(row.consumed_steps, 'consumed.steps'),
      units: toSafeInteger(row.consumed_units, 'consumed.units'),
      elapsedMs: toSafeInteger(row.consumed_elapsed_ms, 'consumed.elapsedMs'),
      concurrencySlots: toSafeInteger(row.consumed_slots, 'consumed.concurrencySlots'),
    }),
    utcDay: row.utc_day,
    expiresAt: toIsoTimestamp(row.expires_at),
    settledAt: row.settled_at === null ? null : toIsoTimestamp(row.settled_at),
    replayed,
  });
}

interface UsageTotals {
  readonly runSteps: number;
  readonly runUnits: number;
  readonly runElapsedMs: number;
  readonly tenantDailyUnits: number;
  readonly concurrentSlots: number;
}

/**
 * Aggregate the three durable counters the policy is evaluated against.
 *
 * Every counter includes this Run's own live reservations exactly once, because a `reserved`
 * row is counted at the reserved amount and a terminal row at the consumed amount. Nothing is
 * cached: the rows written by this transaction's predecessors are the only authority.
 */
async function readTotals(
  client: pg.PoolClient,
  scope: BudgetScope,
  utcDay: string,
): Promise<UsageTotals> {
  const run = await client.query<UsageRow>(RUN_USAGE_SQL, [scope.tenantId, scope.runId]);
  const day = await client.query<{ units: string }>(TENANT_DAY_SQL, [scope.tenantId, utcDay]);
  const gauge = await client.query<{ slots: string }>(TENANT_SLOT_SQL, [scope.tenantId]);

  return Object.freeze({
    runSteps: toSafeInteger(run.rows[0]?.steps ?? '0', 'runSteps'),
    runUnits: toSafeInteger(run.rows[0]?.units ?? '0', 'runUnits'),
    runElapsedMs: toSafeInteger(run.rows[0]?.elapsed_ms ?? '0', 'runElapsedMs'),
    tenantDailyUnits: toSafeInteger(day.rows[0]?.units ?? '0', 'tenantDailyUnits'),
    concurrentSlots: toSafeInteger(gauge.rows[0]?.slots ?? '0', 'concurrentSlots'),
  });
}

async function lockOperation(
  client: pg.PoolClient,
  scope: BudgetScope,
  operationId: string,
): Promise<BudgetOperation> {
  const operation = await findOperation(client, scope, operationId);

  if (operation === null) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `budget_unknown_reservation: operation=${operationId}`,
    );
  }

  return operation;
}

/** Look up and lock an existing operation without making a second affordability decision. */
async function findOperation(
  client: pg.PoolClient,
  scope: BudgetScope,
  operationId: string,
): Promise<BudgetOperation | null> {
  const result = await client.query<OperationRow>(SELECT_OPERATION_SQL, [
    scope.tenantId,
    scope.runId,
    operationId,
  ]);
  const row = result.rows[0];

  return row === undefined ? null : toOperation(row, true);
}

export class PostgresBudgetLedger implements BudgetLedger {
  private readonly policy: BudgetPolicy;

  constructor(
    private readonly pool: pg.Pool,
    options: PostgresBudgetLedgerOptions,
  ) {
    this.policy = options.policy;
  }

  /**
   * Read-only usage of one Run and one Tenant day, including live reservations.
   *
   * It takes no locks and writes nothing: a snapshot is diagnostics, not authority. Only
   * `reserve` decides, and it never trusts a value read outside its own transaction.
   */
  async snapshot(grant: RunGrant): Promise<BudgetLedgerSnapshot> {
    const scope = budgetScope(grant);

    return withTransaction(this.pool, async (client) => {
      const now = await postLockInstant(client);
      const utcDay = toUtcDayKey(now);
      const totals = await readTotals(client, scope, utcDay);

      return Object.freeze({
        tenantId: scope.tenantId,
        runId: scope.runId,
        utcDay,
        policyVersion: this.policy.policyVersion,
        ...totals,
      });
    });
  }

  /**
   * Reserve budget for one operation, or replay the reservation that already exists.
   *
   * The whole sequence runs in one transaction holding the Tenant advisory lock, so the
   * decision and the row it authorizes cannot be interleaved with another Worker's decision.
   * A denial throws before anything is written.
   */
  async reserve(grant: RunGrant, request: BudgetReserveRequest): Promise<BudgetOperation> {
    const scope = budgetScope(grant);
    const operationId = parseOperationId(request.operationId);
    const cost = parseAmount(request.cost, 'cost');

    return withTransaction(this.pool, async (client) => {
      // 1. One budget decision at a time per Tenant. Taken before any row lock, so a budget
      //    transaction is never the second holder of a lock cycle.
      await client.query(ADVISORY_LOCK_SQL, [budgetLockKey(scope.tenantId)]);

      // 2. Fence with the shared order: tasks row → runs row → clock_timestamp() → re-check.
      const fence = await lockAndAssertLive(client, grant);

      // 3. Charge reservations whose lease died before sizing the remaining quota.
      await client.query(SWEEP_EXPIRED_SQL, [scope.tenantId, fence.now]);

      // 4. Resolve idempotency before checking affordability. The existing reservation is
      //    already included in usage; adding its cost again would reject a valid lost-ACK
      //    replay exactly when the first operation consumed the remaining allowance.
      const existing = await findOperation(client, scope, operationId);

      if (existing !== null) {
        if (!sameAmount(existing.reserved, cost)) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            `budget_reservation_conflict: operation=${operationId}`,
          );
        }

        if (existing.leaseEpoch !== grant.leaseEpoch) {
          throw new DomainError(
            'STALE_LEASE',
            'budget reservation belongs to another attempt of this run',
          );
        }

        if (existing.state !== 'reserved') {
          throw new DomainError(
            'INVALID_ARGUMENT',
            `budget_operation_already_terminal: operation=${operationId} state=${existing.state}`,
          );
        }

        return existing;
      }

      // 5. Aggregate the durable usage of this Run and this Tenant day.
      const utcDay = toUtcDayKey(fence.now);
      const totals = await readTotals(client, scope, utcDay);

      // 6. Decide against the trusted policy, inside the transaction that will charge it.
      const decision = evaluateBudget(
        this.policy,
        { tenantId: scope.tenantId, runId: scope.runId, utcDay, ...totals },
        cost,
      );

      if (!decision.allowed) {
        // Rolls back: no reservation, no side effect, nothing to compensate.
        throw toBudgetDeniedError(decision);
      }

      // 7. Record the reservation. The lease boundary is the instant it becomes sweepable.
      const inserted = await client.query<OperationRow>(INSERT_OPERATION_SQL, [
        randomUUID(),
        scope.tenantId,
        scope.taskId,
        scope.runId,
        grant.leaseEpoch,
        this.policy.policyVersion,
        operationId,
        cost.steps,
        cost.units,
        cost.elapsedMs,
        cost.concurrencySlots,
        utcDay,
        fence.expiresAt,
      ]);
      const created = inserted.rows[0];

      if (created !== undefined) {
        return toOperation(created, false);
      }

      // The tenant advisory lock prevents a concurrent reserve from racing this insert. A
      // conflict here therefore means an unexpected writer bypassed the serialization point.
      throw new DomainError('DB_UNAVAILABLE', 'budget operation appeared during reservation');
    });
  }

  /**
   * Record what an operation actually consumed while its reservation is live.
   *
   * There is deliberately no Task/Run lock or Tenant advisory lock here: the row's lease epoch
   * fences the caller, and the operation-row lock serializes settlement against the expiry
   * sweep. The terminal SQL captures one authoritative database instant after acquiring that
   * row lock. At/after `expires_at`, it charges the full reservation as `expired`; before it,
   * it records the reported amount. Either ordering with a pending sweep therefore yields the
   * same full expired charge.
   */
  async settle(grant: RunGrant, request: BudgetSettleRequest): Promise<BudgetOperation> {
    const scope = budgetScope(grant);
    const operationId = parseOperationId(request.operationId);
    const consumed = parseAmount(request.consumed, 'consumed');

    return withTransaction(this.pool, async (client) => {
      const current = await lockOperation(client, scope, operationId);

      if (current.state === 'settled') {
        if (sameAmount(current.consumed, consumed)) {
          return current;
        }

        throw new DomainError(
          'INVALID_ARGUMENT',
          `budget_settlement_conflict: operation=${operationId}`,
        );
      }

      if (current.state === 'expired') {
        // Already charged in full by a prior settle, release, or sweep. Re-reporting the
        // recorded amount is the only safe answer: do not double count or refund a dead lease.
        return current;
      }

      if (current.state === 'released') {
        throw new DomainError(
          'INVALID_ARGUMENT',
          `budget_operation_released: operation=${operationId}`,
        );
      }

      if (current.leaseEpoch !== grant.leaseEpoch) {
        throw new DomainError(
          'STALE_LEASE',
          'budget reservation belongs to another attempt of this run',
        );
      }

      if (!withinReservation(consumed, current.reserved)) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          `budget_consumption_exceeds_reservation: operation=${operationId}`,
        );
      }

      const settled = await client.query<OperationRow>(SETTLE_OPERATION_SQL, [
        scope.tenantId,
        scope.runId,
        operationId,
        consumed.steps,
        consumed.units,
        consumed.elapsedMs,
        consumed.concurrencySlots,
      ]);

      return operationFrom(settled.rows[0], scope, operationId);
    });
  }

  /**
   * Prove that a live reserved operation never ran and hand the quota back.
   *
   * Releasing a settled operation is refused rather than ignored: it would erase consumption
   * that happened. An unswept reservation whose expiry has passed is atomically marked
   * `expired` and charged in full instead of being released.
   */
  async release(grant: RunGrant, request: BudgetReleaseRequest): Promise<BudgetOperation> {
    const scope = budgetScope(grant);
    const operationId = parseOperationId(request.operationId);

    return withTransaction(this.pool, async (client) => {
      const current = await lockOperation(client, scope, operationId);

      if (current.state === 'released') {
        return current;
      }

      if (current.state === 'expired') {
        return current;
      }

      if (current.state === 'settled') {
        throw new DomainError(
          'INVALID_ARGUMENT',
          `budget_operation_already_charged: operation=${operationId} state=${current.state}`,
        );
      }

      if (current.leaseEpoch !== grant.leaseEpoch) {
        throw new DomainError(
          'STALE_LEASE',
          'budget reservation belongs to another attempt of this run',
        );
      }

      const released = await client.query<OperationRow>(RELEASE_OPERATION_SQL, [
        scope.tenantId,
        scope.runId,
        operationId,
      ]);

      return operationFrom(released.rows[0], scope, operationId);
    });
  }
}

function operationFrom(
  row: OperationRow | undefined,
  scope: BudgetScope,
  operationId: string,
): BudgetOperation {
  if (row === undefined) {
    // The row was locked a moment earlier in this transaction, so this is a broken invariant
    // rather than a race: fail loudly instead of reporting a state that was never written.
    throw new DomainError(
      'DB_UNAVAILABLE',
      `budget operation ${operationId} of run ${scope.runId} disappeared during a terminal transition`,
    );
  }

  return toOperation(row, false);
}

function withinReservation(
  consumed: BudgetReservationAmount,
  reserved: BudgetReservationAmount,
): boolean {
  return (
    consumed.steps <= reserved.steps &&
    consumed.units <= reserved.units &&
    consumed.elapsedMs <= reserved.elapsedMs &&
    consumed.concurrencySlots <= reserved.concurrencySlots
  );
}
