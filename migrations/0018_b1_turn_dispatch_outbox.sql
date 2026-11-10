-- PostgreSQL is the durable scheduling authority. A queue message is only a wake-up signal.
-- `turn_id` is also the stable event/idempotency key, so a submission replay cannot create a
-- second dispatch record for the same Assistant Turn.
CREATE TABLE b1_turn_dispatch_outbox (
  turn_id                    uuid        PRIMARY KEY,
  tenant_id                  uuid        NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_dispatch_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_enqueued_at           timestamptz,
  dispatch_attempts          integer     NOT NULL DEFAULT 0,
  dispatch_lease_owner       text,
  dispatch_lease_expires_at  timestamptz,
  completed_at               timestamptz,
  last_error_code            text,
  CONSTRAINT b1_turn_dispatch_outbox_turn_fk
    FOREIGN KEY (tenant_id, turn_id)
    REFERENCES assistant_turns (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT b1_turn_dispatch_outbox_attempts_check
    CHECK (dispatch_attempts >= 0),
  CONSTRAINT b1_turn_dispatch_outbox_lease_check
    CHECK ((dispatch_lease_owner IS NULL) = (dispatch_lease_expires_at IS NULL)),
  CONSTRAINT b1_turn_dispatch_outbox_error_code_check
    CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64)
);

CREATE INDEX b1_turn_dispatch_outbox_due_idx
  ON b1_turn_dispatch_outbox (next_dispatch_at, turn_id)
  WHERE completed_at IS NULL;

CREATE INDEX b1_turn_dispatch_outbox_tenant_idx
  ON b1_turn_dispatch_outbox (tenant_id, turn_id);
