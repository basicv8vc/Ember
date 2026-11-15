import type pg from 'pg';
import { B2_ABSOLUTE_DAY_CEILINGS } from './b2-ledger-limits.js';

const BUDGET_HALT_LOCK_CLASS = 782;
const BUDGET_HALT_LOCK_ID = 0;

export interface BucketChargeResult {
  readonly scope: 'global' | 'tenant' | 'principal';
  readonly scopeId: string;
  readonly appliedMicroUsd: number;
  readonly overageMicroUsd: number;
}

export interface OutstandingBudgetHalt {
  readonly scope: 'global' | 'tenant' | 'principal';
  readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
}

export interface InsertBudgetIncidentInput {
  readonly tenantId: string;
  readonly scope: 'global' | 'tenant' | 'principal';
  readonly scopeId: string;
  readonly utcDay: string;
  readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
  readonly turnId?: string;
  readonly taskId?: string;
  readonly attemptNo: number;
  readonly observedMicroUsd: number;
  readonly appliedMicroUsd: number;
  readonly overageMicroUsd: number;
  readonly reservationMicroUsd: number;
}

/**
 * Serialize budget halt checks against incident creation and resolution.
 *
 * Uses a transaction advisory lock across `reserveAttempt`, `settleAttempt`, and
 * `resolveBudgetIncident` in both B2 Assistant Turns and B3 Notes Tasks.
 */
export async function lockBudgetHalt(client: pg.PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
    BUDGET_HALT_LOCK_CLASS,
    BUDGET_HALT_LOCK_ID,
  ]);
}

/** Look up any unresolved budget incident affecting `(global, tenantId, principalId)`. */
export async function findOutstandingHalt(
  client: pg.PoolClient,
  tenantId: string,
  principalId: string,
): Promise<OutstandingBudgetHalt | null> {
  const result = await client.query<{
    readonly scope_kind: 'global' | 'tenant' | 'principal';
    readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
  }>(
    `SELECT scope_kind, reason
       FROM model_budget_incidents
      WHERE resolved_at IS NULL
        AND (
          scope_kind = 'global'
          OR (tenant_id = $1 AND scope_kind = 'tenant')
          OR (tenant_id = $1 AND scope_kind = 'principal' AND scope_id = $2)
        )
      ORDER BY CASE scope_kind WHEN 'global' THEN 0 WHEN 'tenant' THEN 1 ELSE 2 END
      LIMIT 1`,
    [tenantId, principalId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { scope: row.scope_kind, reason: row.reason };
}

/** Reserve against `model_global_spend_days`; returns `false` when the ceiling rejects it. */
export async function tryReserveGlobalSpend(
  client: pg.PoolClient,
  utcDay: string,
  amount: number,
  ceiling: number,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO model_global_spend_days (utc_day, reserved_micro_usd)
     SELECT $1::date, $2::bigint
      WHERE $2::bigint <= $3::bigint
     ON CONFLICT (utc_day) DO UPDATE
        SET reserved_micro_usd =
              model_global_spend_days.reserved_micro_usd + EXCLUDED.reserved_micro_usd,
            updated_at = clock_timestamp()
      WHERE model_global_spend_days.reserved_micro_usd
          + model_global_spend_days.consumed_micro_usd
          + EXCLUDED.reserved_micro_usd <= $3`,
    [utcDay, amount, ceiling],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Reserve against `model_spend_days` (`tenant` or `principal`); returns `false` on overflow. */
export async function tryReserveScopeSpend(
  client: pg.PoolClient,
  tenantId: string,
  scopeKind: 'tenant' | 'principal',
  scopeId: string,
  utcDay: string,
  amount: number,
  ceiling: number,
  turnsStartedDelta: number,
  turnCap: number,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO model_spend_days
       (tenant_id, scope_kind, scope_id, utc_day, reserved_micro_usd, turns_started)
     SELECT $1, $2, $3, $4::date, $5::bigint, $6::int
      WHERE $5::bigint <= $7::bigint AND $6::int <= $8::int
     ON CONFLICT (tenant_id, scope_kind, scope_id, utc_day) DO UPDATE
        SET reserved_micro_usd = model_spend_days.reserved_micro_usd + EXCLUDED.reserved_micro_usd,
            turns_started = model_spend_days.turns_started + EXCLUDED.turns_started,
            updated_at = clock_timestamp()
      WHERE model_spend_days.reserved_micro_usd
          + model_spend_days.consumed_micro_usd
          + EXCLUDED.reserved_micro_usd <= $7
        AND model_spend_days.turns_started + EXCLUDED.turns_started <= $8`,
    [tenantId, scopeKind, scopeId, utcDay, amount, turnsStartedDelta, ceiling, turnCap],
  );
  return (result.rowCount ?? 0) === 1;
}

function splitCharge(
  reserved: number,
  consumed: number,
  release: number,
  charge: number,
  ceiling: number,
): {
  readonly remainingReserved: number;
  readonly appliedMicroUsd: number;
  readonly overageMicroUsd: number;
} {
  const remainingReserved = reserved - release;
  const room = Math.max(0, ceiling - (remainingReserved + consumed));
  const appliedMicroUsd = Math.min(charge, room);
  return { remainingReserved, appliedMicroUsd, overageMicroUsd: charge - appliedMicroUsd };
}

async function chargeGlobalSpend(
  client: pg.PoolClient,
  utcDay: string,
  releaseMicroUsd: number,
  chargeMicroUsd: number,
): Promise<BucketChargeResult> {
  await client.query(
    `INSERT INTO model_global_spend_days (utc_day) VALUES ($1::date)
     ON CONFLICT (utc_day) DO NOTHING`,
    [utcDay],
  );

  const locked = await client.query<{
    readonly reserved_micro_usd: string | number;
    readonly consumed_micro_usd: string | number;
  }>(
    `SELECT reserved_micro_usd, consumed_micro_usd
       FROM model_global_spend_days
      WHERE utc_day = $1::date
      FOR UPDATE`,
    [utcDay],
  );
  const reserved = Number(locked.rows[0]!.reserved_micro_usd);
  const consumed = Number(locked.rows[0]!.consumed_micro_usd);
  const split = splitCharge(
    reserved,
    consumed,
    releaseMicroUsd,
    chargeMicroUsd,
    B2_ABSOLUTE_DAY_CEILINGS.globalMicroUsd,
  );

  await client.query(
    `UPDATE model_global_spend_days
        SET reserved_micro_usd = $2,
            consumed_micro_usd = $3,
            overage_micro_usd = overage_micro_usd + $4,
            updated_at = clock_timestamp()
      WHERE utc_day = $1::date`,
    [utcDay, split.remainingReserved, consumed + split.appliedMicroUsd, split.overageMicroUsd],
  );

  return {
    scope: 'global',
    scopeId: 'platform',
    appliedMicroUsd: split.appliedMicroUsd,
    overageMicroUsd: split.overageMicroUsd,
  };
}

async function chargeScopeSpend(
  client: pg.PoolClient,
  tenantId: string,
  scopeKind: 'tenant' | 'principal',
  scopeId: string,
  utcDay: string,
  releaseMicroUsd: number,
  chargeMicroUsd: number,
): Promise<BucketChargeResult> {
  await client.query(
    `INSERT INTO model_spend_days (tenant_id, scope_kind, scope_id, utc_day)
     VALUES ($1, $2, $3, $4::date)
     ON CONFLICT (tenant_id, scope_kind, scope_id, utc_day) DO NOTHING`,
    [tenantId, scopeKind, scopeId, utcDay],
  );

  const locked = await client.query<{
    readonly reserved_micro_usd: string | number;
    readonly consumed_micro_usd: string | number;
  }>(
    `SELECT reserved_micro_usd, consumed_micro_usd
       FROM model_spend_days
      WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND utc_day = $4::date
      FOR UPDATE`,
    [tenantId, scopeKind, scopeId, utcDay],
  );
  const reserved = Number(locked.rows[0]!.reserved_micro_usd);
  const consumed = Number(locked.rows[0]!.consumed_micro_usd);
  const ceiling =
    scopeKind === 'tenant'
      ? B2_ABSOLUTE_DAY_CEILINGS.tenantMicroUsd
      : B2_ABSOLUTE_DAY_CEILINGS.principalMicroUsd;
  const split = splitCharge(reserved, consumed, releaseMicroUsd, chargeMicroUsd, ceiling);

  await client.query(
    `UPDATE model_spend_days
        SET reserved_micro_usd = $5,
            consumed_micro_usd = $6,
            overage_micro_usd = overage_micro_usd + $7,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND utc_day = $4::date`,
    [
      tenantId,
      scopeKind,
      scopeId,
      utcDay,
      split.remainingReserved,
      consumed + split.appliedMicroUsd,
      split.overageMicroUsd,
    ],
  );

  return {
    scope: scopeKind,
    scopeId,
    appliedMicroUsd: split.appliedMicroUsd,
    overageMicroUsd: split.overageMicroUsd,
  };
}

/**
 * Release unused reservation and recognize cost in strict bucket lock order:
 * global day -> tenant day -> principal day.
 */
export async function applySpendCharge(
  client: pg.PoolClient,
  input: {
    readonly utcDay: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly releaseMicroUsd: number;
    readonly chargeMicroUsd: number;
  },
): Promise<readonly BucketChargeResult[]> {
  return [
    await chargeGlobalSpend(client, input.utcDay, input.releaseMicroUsd, input.chargeMicroUsd),
    await chargeScopeSpend(
      client,
      input.tenantId,
      'tenant',
      input.tenantId,
      input.utcDay,
      input.releaseMicroUsd,
      input.chargeMicroUsd,
    ),
    await chargeScopeSpend(
      client,
      input.tenantId,
      'principal',
      input.principalId,
      input.utcDay,
      input.releaseMicroUsd,
      input.chargeMicroUsd,
    ),
  ];
}

/** Record an unresolved budget incident for a turn or task attempt. */
export async function insertBudgetIncident(
  client: pg.PoolClient,
  input: InsertBudgetIncidentInput,
): Promise<void> {
  await client.query(
    `INSERT INTO model_budget_incidents
       (id, tenant_id, scope_kind, scope_id, utc_day, reason, turn_id, task_id, attempt_no,
        observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      globalThis.crypto.randomUUID(),
      input.tenantId,
      input.scope,
      input.scopeId,
      input.utcDay,
      input.reason,
      input.turnId ?? null,
      input.taskId ?? null,
      input.attemptNo,
      input.observedMicroUsd,
      input.appliedMicroUsd,
      input.overageMicroUsd,
      input.reservationMicroUsd,
    ],
  );
}
