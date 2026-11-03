-- 0011_identity_session.sql
-- B1: consumer identity + mobile session. Additive only. 0001-0010 immutable.
--
-- Design notes:
--   * A `consumer` is a human; a `tenant` is the isolation boundary. Alpha is 1:1.
--   * Identity keys are provider subjects. Display name/email are NOT identity and are not stored.
--   * Session tokens are opaque; only the SHA-256 digest is stored (dev-token precedent).

CREATE TABLE IF NOT EXISTS consumers (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  principal_id uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumers_tenant_id_id_unique UNIQUE (tenant_id, id),
  -- I-2: tenant ↔ consumer is 1:1, not just "a consumer belongs to a tenant". Without this
  -- the claimed invariant only held in the provisioning code, never in the database.
  CONSTRAINT consumers_one_per_tenant_unique UNIQUE (tenant_id),
  CONSTRAINT consumers_tenant_principal_unique UNIQUE (tenant_id, principal_id),
  CONSTRAINT consumers_principal_fk FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS consumer_identities (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  consumer_id        uuid        NOT NULL,
  provider           text        NOT NULL,
  provider_subject   text        NOT NULL,   -- Apple `sub`; the only identity key
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumer_identities_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT consumer_identities_provider_unique UNIQUE (provider, provider_subject),
  CONSTRAINT consumer_identities_consumer_fk FOREIGN KEY (tenant_id, consumer_id)
    REFERENCES consumers (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT consumer_identities_provider_check CHECK (provider IN ('apple', 'dev'))
);

CREATE TABLE IF NOT EXISTS consumer_sessions (
  id                      uuid        PRIMARY KEY,
  tenant_id               uuid        NOT NULL,
  consumer_id             uuid        NOT NULL,
  token_digest            bytea       NOT NULL,   -- sha256(token); never the token
  issued_at               timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  idle_expires_at         timestamptz NOT NULL,
  revoked_at              timestamptz,
  revocation_reason       text,
  rotated_from_session_id uuid,
  CONSTRAINT consumer_sessions_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT consumer_sessions_digest_unique UNIQUE (token_digest),
  CONSTRAINT consumer_sessions_consumer_fk FOREIGN KEY (tenant_id, consumer_id)
    REFERENCES consumers (tenant_id, id) ON DELETE CASCADE,
  -- A PostgreSQL CHECK accepts UNKNOWN, so explicitly require a reason for revoked sessions.
  CONSTRAINT consumer_sessions_revocation_check CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND revocation_reason IN ('logout', 'rotated', 'reuse_detected'))
  ),
  CONSTRAINT consumer_sessions_expiry_order_check CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS consumer_sessions_active_idx
  ON consumer_sessions (tenant_id, consumer_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS consumer_sessions_purge_idx
  ON consumer_sessions (expires_at)
  WHERE revoked_at IS NOT NULL;
