-- 0015_model_budget_safety.sql
-- B2 budget safety, found in CTO review of PR #124. Additive only. 0001-0014 are immutable.
--
-- Three defects are closed here, each at the persistence boundary rather than in the caller:
--
--   * **Missing usage was priced at zero.** A 2xx body without `usage` used to settle as `settled`
--     with `observed_cost_micro_usd = 0`, which is indistinguishable from a free call. A real reply
--     whose charge is unknown is now `conservative_billed`: the attempt books the full reservation
--     as consumed money and records `billing_basis = 'conservative_reservation'`, so the day budget
--     is actually charged for what may already be on an invoice.
--
--   * **The reservation could be truncated to its own cap.** `Math.min(estimate, cap)` reserved the
--     cap and then sent a request that could cost more. That is fixed in the Worker (it now refuses
--     before egress), and the ledger here keeps the evidence when reality still beats the estimate.
--
--   * **An observed cost above the reservation was silently clipped.** `applied = min(observed,
--     reserved)` dropped the excess from the day ledger, so real spend exceeded recorded spend. The
--     full amount is now kept: `consumed_micro_usd` (inside the allowance) plus a new
--     `overage_micro_usd` (outside it). `consumed + overage` is the actual spend, and nothing is lost.
--     An overage opens a durable incident that hard-refuses further paid calls until a human resolves
--     it through the audited path.
--
-- No credential, prompt, completion or provider payload is stored here.

-- ---------------------------------------------------------------------------
-- 1. Attempt-level audit columns.
-- ---------------------------------------------------------------------------

ALTER TABLE model_turn_attempts
  ADD COLUMN IF NOT EXISTS billing_basis     text,
  ADD COLUMN IF NOT EXISTS overage_micro_usd bigint NOT NULL DEFAULT 0;

-- Backfill before the new coherence constraint is added, so a database that already contains an
-- over-reserved attempt from 0014 does not fail its own migration. The arithmetic is the invariant
-- the constraint is about: applied + overage = observed.
UPDATE model_turn_attempts
   SET overage_micro_usd = observed_cost_micro_usd - applied_cost_micro_usd
 WHERE observed_cost_micro_usd IS NOT NULL
   AND applied_cost_micro_usd IS NOT NULL
   AND observed_cost_micro_usd > applied_cost_micro_usd
   AND overage_micro_usd = 0;

-- Widen the vocabulary. Widening a CHECK only admits more rows, so it is safe on existing data.
DO $$
BEGIN
  ALTER TABLE model_turn_attempts
    DROP CONSTRAINT IF EXISTS model_turn_attempts_state_check;
  ALTER TABLE model_turn_attempts
    ADD CONSTRAINT model_turn_attempts_state_check
    CHECK (state IN ('reserved', 'settled', 'unknown_billed', 'released', 'conservative_billed'));

  ALTER TABLE model_turn_attempts
    DROP CONSTRAINT IF EXISTS model_turn_attempts_outcome_check;
  ALTER TABLE model_turn_attempts
    ADD CONSTRAINT model_turn_attempts_outcome_check CHECK (
      outcome_code IS NULL
      OR outcome_code IN (
        'ok', 'model_timeout', 'model_unavailable', 'model_rate_limited',
        'model_auth_failed', 'model_invalid_output', 'client_cancelled', 'not_sent',
        -- A 2xx reply whose charge the provider did not report.
        'usage_missing'
      )
    );

  -- `conservative_billed` is the only state allowed to book without an observed cost, and it must
  -- book *everything it held*: a "conservative" charge that books less than the reservation would
  -- reintroduce the under-reporting this state exists to prevent.
  ALTER TABLE model_turn_attempts
    DROP CONSTRAINT IF EXISTS model_turn_attempts_state_shape_check;
  ALTER TABLE model_turn_attempts
    ADD CONSTRAINT model_turn_attempts_state_shape_check CHECK (
      (state = 'reserved'
        AND outcome_code IS NULL AND applied_cost_micro_usd IS NULL AND settled_at IS NULL)
      OR (state = 'settled'
        AND outcome_code IS NOT NULL AND applied_cost_micro_usd IS NOT NULL
        AND settled_at IS NOT NULL)
      OR (state = 'unknown_billed'
        AND outcome_code IS NOT NULL AND applied_cost_micro_usd IS NULL
        AND settled_at IS NOT NULL)
      OR (state = 'released'
        AND outcome_code IS NOT NULL AND applied_cost_micro_usd = 0
        AND settled_at IS NOT NULL)
      OR (state = 'conservative_billed'
        AND outcome_code IS NOT NULL
        AND applied_cost_micro_usd = reserved_micro_usd
        AND billing_basis = 'conservative_reservation'
        AND settled_at IS NOT NULL)
    );

  ALTER TABLE model_turn_attempts
    DROP CONSTRAINT IF EXISTS model_turn_attempts_billing_basis_check;
  ALTER TABLE model_turn_attempts
    ADD CONSTRAINT model_turn_attempts_billing_basis_check CHECK (
      billing_basis IS NULL
      OR billing_basis IN ('provider_usage', 'conservative_reservation', 'not_billed')
    );

  -- applied + overage = observed, exactly. The observed value stays unclamped (the invoice is
  -- authoritative); the split only decides how much of it the day allowance could absorb.
  ALTER TABLE model_turn_attempts
    DROP CONSTRAINT IF EXISTS model_turn_attempts_overage_check;
  ALTER TABLE model_turn_attempts
    ADD CONSTRAINT model_turn_attempts_overage_check CHECK (
      overage_micro_usd >= 0
      AND (
        observed_cost_micro_usd IS NULL
        OR applied_cost_micro_usd IS NULL
        OR overage_micro_usd = observed_cost_micro_usd - applied_cost_micro_usd
      )
    );
END $$;

-- ---------------------------------------------------------------------------
-- 2. Day buckets keep the part of an actual cost that the allowance could not absorb.
-- ---------------------------------------------------------------------------

ALTER TABLE model_global_spend_days
  ADD COLUMN IF NOT EXISTS overage_micro_usd bigint NOT NULL DEFAULT 0;
ALTER TABLE model_spend_days
  ADD COLUMN IF NOT EXISTS overage_micro_usd bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  -- Overage is deliberately *outside* the ceiling arithmetic: `reserved + consumed <= ceiling`
  -- still holds, which is what stops a process from widening its own allowance, while the excess is
  -- preserved here instead of being clipped away. Actual spend for the day is
  -- `consumed_micro_usd + overage_micro_usd`.
  ALTER TABLE model_global_spend_days
    DROP CONSTRAINT IF EXISTS model_global_spend_days_overage_check;
  ALTER TABLE model_global_spend_days
    ADD CONSTRAINT model_global_spend_days_overage_check
    CHECK (overage_micro_usd >= 0);

  ALTER TABLE model_spend_days
    DROP CONSTRAINT IF EXISTS model_spend_days_overage_check;
  ALTER TABLE model_spend_days
    ADD CONSTRAINT model_spend_days_overage_check
    CHECK (overage_micro_usd >= 0);
END $$;

-- ---------------------------------------------------------------------------
-- 3. Durable budget incidents: the audit record and the stop switch in one row.
--
-- A paid call may only proceed while no unresolved incident applies to it. Resolution is an
-- explicit, attributed act, so "the budget alarm was silenced" is itself auditable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_budget_incidents (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  scope_kind            text        NOT NULL,
  -- Tenant / principal id, or the literal 'platform' for the shared global bucket.
  scope_id              text        NOT NULL,
  utc_day               date        NOT NULL,
  reason                text        NOT NULL,
  -- Deliberately not a foreign key: this is evidence about money and must outlive the transcript
  -- that produced it (deleting a conversation cascades its attempts away, not its invoice trail).
  turn_id               uuid,
  attempt_no            integer,
  observed_micro_usd    bigint      NOT NULL,
  applied_micro_usd     bigint      NOT NULL,
  overage_micro_usd     bigint      NOT NULL,
  reservation_micro_usd bigint      NOT NULL,
  detected_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at           timestamptz,
  resolved_by           text,
  resolution_note       text,
  CONSTRAINT model_budget_incidents_scope_check
    CHECK (scope_kind IN ('global', 'tenant', 'principal')),
  CONSTRAINT model_budget_incidents_reason_check
    CHECK (reason IN ('day_ceiling_exceeded', 'reservation_exceeded')),
  CONSTRAINT model_budget_incidents_amounts_check CHECK (
    observed_micro_usd >= 0
    AND applied_micro_usd >= 0
    AND reservation_micro_usd >= 0
    AND overage_micro_usd = observed_micro_usd - applied_micro_usd
  ),
  -- The reason is derived from the arithmetic, not from a label a caller chose.
  CONSTRAINT model_budget_incidents_reason_shape_check CHECK (
    (reason = 'day_ceiling_exceeded' AND overage_micro_usd > 0)
    OR (
      reason = 'reservation_exceeded'
      AND overage_micro_usd = 0
      AND observed_micro_usd > reservation_micro_usd
    )
  ),
  -- Resolution is all-or-nothing and always attributed.
  CONSTRAINT model_budget_incidents_resolution_check CHECK (
    (resolved_at IS NULL) = (resolved_by IS NULL)
    AND (resolution_note IS NULL OR resolved_at IS NOT NULL)
  )
);

-- Blocking lookup: "is any incident open that applies to this tenant/principal/global bucket?"
CREATE INDEX IF NOT EXISTS model_budget_incidents_open_idx
  ON model_budget_incidents (tenant_id, scope_kind, scope_id)
  WHERE resolved_at IS NULL;
