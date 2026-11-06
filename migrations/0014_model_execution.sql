-- 0014_model_execution.sql
-- B2: real Assistant Turn execution. Additive only. 0001-0013 are immutable.
--
-- Design notes:
--   * B1 owns `assistant_turns` identity, its status vocabulary and its terminal transitions.
--     B2 adds *claim* fields only: a turn can be leased, fenced and reclaimed, but there is still
--     exactly one Turn state machine and B2 may not introduce a second one.
--   * `lease_epoch` is monotonic per turn. Every publication is guarded by the epoch and the owner
--     it claimed, so a worker that lost its lease can compute a reply but can never publish it.
--   * Money lives in its own ledger. It never reuses `budget_ledger.ts`, whose unit is a simulated
--     work unit aggregated per (tenant, UTC day): a token-priced call must settle actual cost and
--     must be separable per principal, per tenant and globally.
--   * `model_turn_attempts` is the canonical paid operation. One row = at most one outbound start,
--     enforced by the `send_started_at` compare-and-set in the repository. `attempt_no` is bounded
--     to 1..2 so a crash loop cannot become an unbounded invoice.
--   * `reserved_micro_usd` is a pessimistic commitment for calls that may already have been sent.
--     `consumed_micro_usd` is the amount recognized against that reservation. `observed_cost_micro_usd`
--     keeps the provider-reported value unclamped: a CHECK can protect our accounting, not an invoice.
--   * No credential, prompt, completion or provider payload is stored here.

-- ---------------------------------------------------------------------------
-- 1. Claim / fencing fields on the B1-owned assistant_turns table.
-- ---------------------------------------------------------------------------

ALTER TABLE assistant_turns
  ADD COLUMN IF NOT EXISTS lease_epoch      bigint      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_owner      text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_count      integer     NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'assistant_turns_lease_state_check'
       AND conrelid = 'assistant_turns'::regclass
  ) THEN
    -- Owner and expiry are present together or absent together: a half-cleared lease would let a
    -- worker claim without an expiry, which is the one state the fencing protocol cannot reason about.
    ALTER TABLE assistant_turns
      ADD CONSTRAINT assistant_turns_lease_state_check CHECK (
        (lease_owner IS NULL) = (lease_expires_at IS NULL)
        AND lease_epoch >= 0
        AND claim_count >= 0
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assistant_turns_lease_idx
  ON assistant_turns (lease_expires_at)
  WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- 2. The single, shared, cross-tenant platform-day money bucket.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_global_spend_days (
  utc_day            date        PRIMARY KEY,
  reserved_micro_usd bigint      NOT NULL DEFAULT 0,
  consumed_micro_usd bigint      NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- The budget is `consumed + reserved`, not `reserved` alone: money already spent must keep
  -- counting against the day, otherwise settling a call would silently free its own allowance.
  CONSTRAINT model_global_spend_days_budget_check CHECK (
    reserved_micro_usd >= 0
    AND consumed_micro_usd >= 0
    AND reserved_micro_usd + consumed_micro_usd <= 5000000
  )
);

-- ---------------------------------------------------------------------------
-- 3. Two independent per-tenant scopes. Neither is derived from the other.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_spend_days (
  tenant_id          uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  scope_kind         text        NOT NULL,
  scope_id           uuid        NOT NULL,
  utc_day            date        NOT NULL,
  reserved_micro_usd bigint      NOT NULL DEFAULT 0,
  consumed_micro_usd bigint      NOT NULL DEFAULT 0,
  turns_started      integer     NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_spend_days_pkey PRIMARY KEY (tenant_id, scope_kind, scope_id, utc_day),
  CONSTRAINT model_spend_days_scope_kind_check
    CHECK (scope_kind IN ('tenant', 'principal')),
  CONSTRAINT model_spend_days_amounts_check CHECK (
    reserved_micro_usd >= 0
    AND consumed_micro_usd >= 0
    AND turns_started >= 0
  ),
  -- Absolute ceilings live in the database, not only in configuration: a misconfigured process
  -- must not be able to widen its own allowance. Configuration may only lower these, and the
  -- ceiling is applied to `consumed + reserved` so a settled call still occupies the day budget.
  CONSTRAINT model_spend_days_absolute_ceiling_check CHECK (
    (scope_kind = 'tenant' AND reserved_micro_usd + consumed_micro_usd <= 1000000)
    OR (scope_kind = 'principal' AND reserved_micro_usd + consumed_micro_usd <= 250000)
  ),
  -- B2's 60 paid Turns per UTC day is a principal limit, distinct from B1's 200 submitted messages
  -- per rolling 24 h. They are not interchangeable and do not share a boundary.
  CONSTRAINT model_spend_days_principal_turn_cap_check
    CHECK (scope_kind <> 'principal' OR turns_started <= 60)
);

-- ---------------------------------------------------------------------------
-- 4. The canonical paid attempt: one row per potential outbound request start.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_turn_attempts (
  tenant_id              uuid        NOT NULL,
  turn_id                uuid        NOT NULL,
  attempt_no             integer     NOT NULL,
  operation_id           uuid        NOT NULL,
  principal_id           uuid        NOT NULL,
  utc_day                date        NOT NULL,
  provider_id            text        NOT NULL,
  model_label            text        NOT NULL,
  rate_version           text        NOT NULL,
  state                  text        NOT NULL,
  outcome_code           text,
  reserved_micro_usd     bigint      NOT NULL,
  applied_cost_micro_usd bigint,
  observed_cost_micro_usd bigint,
  input_tokens           integer,
  output_tokens          integer,
  send_started_at        timestamptz,
  started_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at             timestamptz,
  CONSTRAINT model_turn_attempts_pkey
    PRIMARY KEY (tenant_id, turn_id, attempt_no),
  -- One attempt is one operation: a replayed reservation returns this row instead of starting a
  -- second request.
  CONSTRAINT model_turn_attempts_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT model_turn_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 2),
  CONSTRAINT model_turn_attempts_provider_check CHECK (provider_id IN ('openai')),
  CONSTRAINT model_turn_attempts_state_check
    CHECK (state IN ('reserved', 'settled', 'unknown_billed', 'released')),
  CONSTRAINT model_turn_attempts_outcome_check CHECK (
    outcome_code IS NULL
    OR outcome_code IN (
      'ok', 'model_timeout', 'model_unavailable', 'model_rate_limited',
      'model_auth_failed', 'model_invalid_output', 'client_cancelled', 'not_sent'
    )
  ),
  CONSTRAINT model_turn_attempts_reserved_check
    CHECK (reserved_micro_usd BETWEEN 1 AND 5000),
  CONSTRAINT model_turn_attempts_applied_check CHECK (
    applied_cost_micro_usd IS NULL
    OR applied_cost_micro_usd BETWEEN 0 AND reserved_micro_usd
  ),
  -- Deliberately unclamped: the invoice is authoritative, our reservation is an estimate.
  CONSTRAINT model_turn_attempts_observed_check
    CHECK (observed_cost_micro_usd IS NULL OR observed_cost_micro_usd >= 0),
  CONSTRAINT model_turn_attempts_tokens_check CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
  ),
  CONSTRAINT model_turn_attempts_state_shape_check CHECK (
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
  ),
  -- Turn deletion cascades: clearing the transcript removes its turns (B1 C-6 / §10.4). An attempt
  -- row cannot outlive the turn it belonged to; the money stays in the day buckets, which are the
  -- spend record, and the overage evidence is preserved there.
  CONSTRAINT model_turn_attempts_turn_fk FOREIGN KEY (tenant_id, turn_id)
    REFERENCES assistant_turns (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT model_turn_attempts_principal_fk FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS model_turn_attempts_day_idx
  ON model_turn_attempts (utc_day, tenant_id);

-- Operator view of the paid attempts that have not reached a financial conclusion. It exists so a
-- reconciliation job can be added later without a schema change; B2 itself writes no more rows.
CREATE INDEX IF NOT EXISTS model_turn_attempts_open_idx
  ON model_turn_attempts (utc_day, tenant_id)
  WHERE state = 'unknown_billed';
