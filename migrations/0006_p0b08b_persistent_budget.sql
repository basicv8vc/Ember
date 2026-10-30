-- P0B-08b: persistent, transactional budget enforcement.
--
-- Forward-only. Migrations 0001-0005 are already merged and immutable.
--
-- Invariants encoded here rather than only in TypeScript:
--   * a budget operation is tenant-owned and keyed by the stable
--     (tenant_id, run_id, operation_id) triple, so one operation is charged at most once
--     even across UTC-day boundaries, worker attempts and lost acknowledgements;
--   * one row describes both the reservation and its terminal settlement, so a settlement
--     can never be applied to an operation that was never reserved, and a reservation can
--     never be settled twice with different numbers;
--   * every amount is a non-negative safe integer and a settlement can only shrink a
--     reservation (consumed <= reserved per dimension);
--   * a reservation is either live ('reserved') or terminal ('settled' | 'released' |
--     'expired'); 'expired' is charged in full, so crashing a worker can never refund
--     quota;
--   * run-scoped and tenant-day usage are DERIVED from these rows. There is no second
--     mutable counter to drift, so the durable record is always the authority;
--   * a reservation carries the lease epoch and the lease boundary it dies with, so a
--     re-claimed Run can never settle a dead attempt's reservation, and a dead attempt
--     cannot outlive its lease.
--
-- Lock order:
--     reserve: pg_advisory_xact_lock('ember.budget', tenant) -> tasks row -> runs row -> budget rows
--     heartbeat: tasks row -> runs row -> budget rows
--     result commit: tasks row -> runs row -> artifact/workspace reference rows
--     settle/release: one budget row only
-- Reserve adds a Tenant serialization point before the existing Task -> Run row order. No path
-- takes that advisory lock after a row lock, and no budget-row holder then waits for Task/Run,
-- so these paths do not introduce a lock cycle.

-- ---------------------------------------------------------------------------
-- Budget operations: one row per (Run, stable operation id)
-- ---------------------------------------------------------------------------

CREATE TABLE budget_operations (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  task_id             uuid        NOT NULL,
  run_id              uuid        NOT NULL,
  lease_epoch         bigint      NOT NULL CHECK (lease_epoch >= 0),
  policy_version      integer     NOT NULL CHECK (policy_version >= 0),
  -- Stable, caller-chosen operation identity (for example `publish:<lease epoch>`). The
  -- same id may be reserved only once per Run, which is what makes the charge idempotent.
  operation_id        text        NOT NULL CHECK (
                        operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
                      ),
  reserved_steps      integer     NOT NULL CHECK (reserved_steps >= 0),
  reserved_units      bigint      NOT NULL CHECK (
                        reserved_units >= 0 AND reserved_units <= 9007199254740991
                      ),
  reserved_elapsed_ms bigint      NOT NULL CHECK (
                        reserved_elapsed_ms >= 0 AND reserved_elapsed_ms <= 9007199254740991
                      ),
  -- At most one concurrency slot per operation: a step is a single unit of work, never a
  -- fan-out, so a reservation can never inflate the gauge by asking for more.
  reserved_slots      integer     NOT NULL CHECK (reserved_slots BETWEEN 0 AND 1),
  consumed_steps      integer     NOT NULL DEFAULT 0 CHECK (consumed_steps >= 0),
  consumed_units      bigint      NOT NULL DEFAULT 0 CHECK (
                        consumed_units >= 0 AND consumed_units <= 9007199254740991
                      ),
  consumed_elapsed_ms bigint      NOT NULL DEFAULT 0 CHECK (
                        consumed_elapsed_ms >= 0 AND consumed_elapsed_ms <= 9007199254740991
                      ),
  consumed_slots      integer     NOT NULL DEFAULT 0 CHECK (consumed_slots BETWEEN 0 AND 1),
  state               text        NOT NULL DEFAULT 'reserved' CHECK (
                        state IN ('reserved', 'settled', 'released', 'expired')
                      ),
  -- UTC day the quota was taken from (YYYY-MM-DD). A later settlement never re-dates the
  -- charge: the day the Run asked for the quota owns it.
  utc_day             date        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Lease boundary the reservation dies with; the tenant serialization point sweeps it.
  expires_at          timestamptz NOT NULL,
  settled_at          timestamptz,
  CONSTRAINT budget_operations_settlement_within_reservation CHECK (
    consumed_steps <= reserved_steps
    AND consumed_units <= reserved_units
    AND consumed_elapsed_ms <= reserved_elapsed_ms
    AND consumed_slots <= reserved_slots
  ),
  -- Only a settlement (or an expiry, which is a settlement at the full reserved amount)
  -- may report consumed work; a live or released reservation consumed nothing.
  CONSTRAINT budget_operations_consumption_only_when_terminal CHECK (
    state IN ('settled', 'expired')
    OR (
      consumed_steps = 0
      AND consumed_units = 0
      AND consumed_elapsed_ms = 0
      AND consumed_slots = 0
    )
  ),
  -- An expired reservation is charged in full: there is no path that refunds quota by
  -- killing the worker that took it.
  CONSTRAINT budget_operations_expired_is_charged_in_full CHECK (
    state <> 'expired'
    OR (
      consumed_steps = reserved_steps
      AND consumed_units = reserved_units
      AND consumed_elapsed_ms = reserved_elapsed_ms
      AND consumed_slots = reserved_slots
    )
  ),
  CONSTRAINT budget_operations_terminal_has_settled_at CHECK (
    (state = 'reserved' AND settled_at IS NULL)
    OR (state <> 'reserved' AND settled_at IS NOT NULL)
  ),
  -- The idempotency key required by P0B-08a section 6.1: Run-scoped and day-independent,
  -- so replaying yesterday's operation today is rejected instead of charged again.
  UNIQUE (tenant_id, run_id, operation_id),
  FOREIGN KEY (tenant_id, task_id, run_id)
    REFERENCES runs (tenant_id, task_id, id) ON DELETE RESTRICT
);

-- Run-scoped cumulative usage (all days of the Run, including live reservations).
CREATE INDEX budget_operations_run_idx
  ON budget_operations (tenant_id, run_id, state);

-- Tenant-day usage for the tenant_daily_units dimension.
CREATE INDEX budget_operations_tenant_day_idx
  ON budget_operations (tenant_id, utc_day, state);

-- Sweep of reservations whose lease died, executed inside the tenant serialization point.
CREATE INDEX budget_operations_live_expiry_idx
  ON budget_operations (tenant_id, expires_at)
  WHERE state = 'reserved';
