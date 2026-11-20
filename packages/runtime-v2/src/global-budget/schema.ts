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
) STRICT, WITHOUT ROWID;

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
) STRICT, WITHOUT ROWID;

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

/**
 * In-place upgrade for pre-OPT-5 GlobalBudgetDO databases whose `global_budget_reservations`
 * and `global_budget_settlements` tables were created without `WITHOUT ROWID`.
 * Must run with `PRAGMA foreign_keys = OFF` outside the transaction and verify
 * `PRAGMA foreign_key_check` before commit.
 */
export const GLOBAL_BUDGET_WITHOUT_ROWID_UPGRADE_STATEMENTS = [
  `CREATE TABLE global_budget_reservations_v2 (
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
) STRICT, WITHOUT ROWID;`,
  `INSERT INTO global_budget_reservations_v2 (
  operation_id, global_grant_id, tenant_id, principal_id, agent_id, lease_epoch,
  utc_day, amount_micro_usd, request_ceiling_micro_usd, initial_expires_at_ms,
  expires_at_ms, authorized_at_ms, state, cumulative_charge_micro_usd, overage_micro_usd
) SELECT
  operation_id, global_grant_id, tenant_id, principal_id, agent_id, lease_epoch,
  utc_day, amount_micro_usd, request_ceiling_micro_usd, initial_expires_at_ms,
  expires_at_ms, authorized_at_ms, state, cumulative_charge_micro_usd, overage_micro_usd
FROM global_budget_reservations;`,
  `CREATE TABLE global_budget_settlements_v2 (
  operation_id TEXT NOT NULL REFERENCES global_budget_reservations_v2 (operation_id),
  settlement_revision INTEGER NOT NULL CHECK (settlement_revision >= 0),
  payload_json TEXT NOT NULL,
  cumulative_charge_micro_usd INTEGER NOT NULL,
  delta_micro_usd INTEGER NOT NULL,
  day_overage_delta_micro_usd INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (operation_id, settlement_revision)
) STRICT, WITHOUT ROWID;`,
  `INSERT INTO global_budget_settlements_v2 (
  operation_id, settlement_revision, payload_json, cumulative_charge_micro_usd,
  delta_micro_usd, day_overage_delta_micro_usd, received_at_ms
) SELECT
  operation_id, settlement_revision, payload_json, cumulative_charge_micro_usd,
  delta_micro_usd, day_overage_delta_micro_usd, received_at_ms
FROM global_budget_settlements;`,
  `CREATE TABLE global_budget_incidents_v2 (
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
    REFERENCES global_budget_settlements_v2 (operation_id, settlement_revision),
  CHECK (
    (resolved_at_ms IS NULL AND resolved_by IS NULL AND resolution_note IS NULL)
    OR (resolved_at_ms IS NOT NULL AND resolved_by IS NOT NULL AND resolution_note IS NOT NULL)
  )
) STRICT;`,
  `INSERT INTO global_budget_incidents_v2 (
  incident_id, operation_id, settlement_revision, reason, opened_at_ms,
  resolved_at_ms, resolved_by, resolution_note
) SELECT
  incident_id, operation_id, settlement_revision, reason, opened_at_ms,
  resolved_at_ms, resolved_by, resolution_note
FROM global_budget_incidents;`,
  `DROP TABLE global_budget_incidents;`,
  `DROP TABLE global_budget_settlements;`,
  `DROP TABLE global_budget_reservations;`,
  `ALTER TABLE global_budget_reservations_v2 RENAME TO global_budget_reservations;`,
  `ALTER TABLE global_budget_settlements_v2 RENAME TO global_budget_settlements;`,
  `ALTER TABLE global_budget_incidents_v2 RENAME TO global_budget_incidents;`,
  `CREATE INDEX IF NOT EXISTS idx_global_budget_expiry
  ON global_budget_reservations (expires_at_ms, operation_id) WHERE state = 'reserved';`,
  `CREATE INDEX IF NOT EXISTS idx_global_budget_halt
  ON global_budget_incidents (incident_id) WHERE resolved_at_ms IS NULL;`,
] as const;
