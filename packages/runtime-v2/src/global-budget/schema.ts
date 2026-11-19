export const GLOBAL_BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_spend_days (
  utc_day TEXT PRIMARY KEY,
  ceiling_micro_usd INTEGER NOT NULL CHECK (ceiling_micro_usd >= 0),
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  overage_micro_usd TEXT NOT NULL DEFAULT '0',
  CHECK (reserved_micro_usd + consumed_micro_usd <= ceiling_micro_usd)
) STRICT;

CREATE TABLE IF NOT EXISTS global_budget_reservations (
  operation_id TEXT PRIMARY KEY,
  global_grant_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  utc_day TEXT NOT NULL REFERENCES global_spend_days (utc_day),
  amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd > 0),
  request_ceiling_micro_usd INTEGER NOT NULL,
  initial_expires_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= initial_expires_at_ms),
  authorized_at_ms INTEGER,
  state TEXT NOT NULL CHECK (state IN (
    'reserved', 'expired_consumed', 'settled', 'conservative_billed', 'unknown_billed', 'released'
  )),
  cumulative_charge_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (cumulative_charge_micro_usd >= 0),
  overage_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (overage_micro_usd >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_global_budget_expiry
  ON global_budget_reservations (expires_at_ms, operation_id) WHERE state = 'reserved';

CREATE TABLE IF NOT EXISTS global_budget_settlements (
  operation_id TEXT NOT NULL REFERENCES global_budget_reservations (operation_id),
  settlement_revision INTEGER NOT NULL CHECK (settlement_revision >= 0),
  payload_json TEXT NOT NULL,
  cumulative_charge_micro_usd INTEGER NOT NULL,
  delta_micro_usd INTEGER NOT NULL,
  day_overage_delta_micro_usd INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (operation_id, settlement_revision)
) STRICT;

CREATE TABLE IF NOT EXISTS global_budget_incidents (
  incident_id INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL,
  settlement_revision INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'day_ceiling_exceeded', 'reservation_exceeded', 'usage_missing'
  )),
  opened_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  resolved_by TEXT,
  resolution_note TEXT,
  UNIQUE (operation_id, reason, settlement_revision),
  FOREIGN KEY (operation_id, settlement_revision)
    REFERENCES global_budget_settlements (operation_id, settlement_revision),
  CHECK (
    (resolved_at_ms IS NULL AND resolved_by IS NULL AND resolution_note IS NULL)
    OR (resolved_at_ms IS NOT NULL AND resolved_by IS NOT NULL AND resolution_note IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_global_budget_halt
  ON global_budget_incidents (incident_id) WHERE resolved_at_ms IS NULL;
`;
