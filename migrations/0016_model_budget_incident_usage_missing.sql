-- 0016_model_budget_incident_usage_missing.sql
-- P0-1 from the second CTO review of PR #124: a 2xx reply whose usage the provider did not report
-- is conservatively billed at the full reservation, but it must ALSO open a durable incident so
-- that subsequent paid calls are halted until a human reconciles. Additive only; 0001-0015 immutable.
--
-- The `usage_missing` reason has no overage (the conservative booking is exactly the reservation)
-- and no gap between observed and applied: the incident exists because the *true* charge is
-- unknown, not because the ledger lost money.

ALTER TABLE model_budget_incidents
  DROP CONSTRAINT IF EXISTS model_budget_incidents_reason_check;
ALTER TABLE model_budget_incidents
  ADD CONSTRAINT model_budget_incidents_reason_check
  CHECK (reason IN ('day_ceiling_exceeded', 'reservation_exceeded', 'usage_missing'));

ALTER TABLE model_budget_incidents
  DROP CONSTRAINT IF EXISTS model_budget_incidents_reason_shape_check;
ALTER TABLE model_budget_incidents
  ADD CONSTRAINT model_budget_incidents_reason_shape_check CHECK (
    (reason = 'day_ceiling_exceeded' AND overage_micro_usd > 0)
    OR (
      reason = 'reservation_exceeded'
      AND overage_micro_usd = 0
      AND observed_micro_usd > reservation_micro_usd
    )
    OR (
      reason = 'usage_missing'
      AND overage_micro_usd = 0
      AND observed_micro_usd = reservation_micro_usd
      AND applied_micro_usd = reservation_micro_usd
    )
  );
