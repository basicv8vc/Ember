-- Canonical D1 schema for V2 Recovery Registry (V2-M0-B §2.2 & J3)
CREATE TABLE IF NOT EXISTS v2_recovery_registry (
  agent_key                 TEXT    PRIMARY KEY,
  tenant_id                 TEXT    NOT NULL,
  agent_id                  TEXT    NOT NULL,
  generation                INTEGER NOT NULL CHECK (generation >= 0 AND generation <= 9007199254740991),
  next_recovery_at_ms       INTEGER NOT NULL,
  retry_not_before_ms       INTEGER,
  status                    TEXT    NOT NULL CHECK (status IN ('armed', 'backoff', 'quarantined')),
  sweep_lease_owner         TEXT,
  sweep_lease_expires_at_ms INTEGER,
  recovery_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  last_error_code           TEXT,
  updated_at_ms             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_recovery_due
  ON v2_recovery_registry (next_recovery_at_ms, agent_key)
  WHERE status IN ('armed', 'backoff', 'quarantined');
