-- 0010_p0c3d_consent.sql
-- P0-C3D: authoritative, tenant-scoped consent persistence plus the versioned authorization
-- fence used by the commitment publication guard.
--
-- Additive migration only. Existing migrations 0001-0008 are immutable.
--
-- Numbering: `0009` is reserved for the in-flight P0-C3B runtime-closure migration
-- (`0009_p0c3b_runtime_closure.sql`). Using it here would collide with that branch at merge
-- time; the runner requires unique, strictly increasing ids and tolerates the resulting gap.
--
-- Design notes:
--   * `consent_grants` stores *authorization facts only*. No OAuth token, refresh token,
--     cookie, password, API key or other credential material has a column here, and none may
--     ever be added: a consent row is a permission, not a secret store.
--   * Tenant isolation is expressed in the schema (`tenant_id` on every row, composite
--     `(tenant_id, ...)` foreign keys) and enforced again by every repository query.
--   * Only two statuses are stored (`active`, `revoked`). `expired` is *derived* from
--     `expires_at` against `clock_timestamp()`, so an expiry can never go stale in a column.
--   * `version` is the authorization fence: every grant, re-grant or revocation increments
--     it. Work dispatched under version N is published only while the grant is still active,
--     unexpired and still at version N, so a revoke/re-grant between dispatch and publication
--     is observed inside the publishing transaction instead of being raced past.

CREATE TABLE IF NOT EXISTS consent_grants (
  id                      uuid        PRIMARY KEY,
  tenant_id               uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  source_profile_id       text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'active',
  allowed_operations      text[]      NOT NULL,
  scopes                  text[]      NOT NULL DEFAULT '{}'::text[],
  -- Who authorised or retracted the grant. Nullable only so a historical row written without
  -- a recorded principal stays readable; new writes always set it.
  granted_by_principal_id uuid,
  granted_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz,
  revoked_at              timestamptz,
  revoked_by_principal_id uuid,
  version                 integer     NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- One grant per (tenant, source profile); a re-grant updates it in place and bumps `version`.
  CONSTRAINT consent_grants_tenant_profile_unique UNIQUE (tenant_id, source_profile_id),
  CONSTRAINT consent_grants_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT consent_grants_granted_by_fk FOREIGN KEY (tenant_id, granted_by_principal_id)
    REFERENCES principals (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT consent_grants_revoked_by_fk FOREIGN KEY (tenant_id, revoked_by_principal_id)
    REFERENCES principals (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT consent_grants_source_profile_format_check CHECK (
    source_profile_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
  ),
  CONSTRAINT consent_grants_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT consent_grants_version_positive_check CHECK (version >= 1),
  CONSTRAINT consent_grants_allowed_operations_check CHECK (
    array_length(allowed_operations, 1) >= 1
    AND array_length(allowed_operations, 1) <= 2
    AND allowed_operations <@ ARRAY['read_snapshot', 'publish_outcome']::text[]
  ),
  CONSTRAINT consent_grants_scopes_bounds_check CHECK (
    coalesce(array_length(scopes, 1), 0) <= 16
  ),
  CONSTRAINT consent_grants_expiry_order_check CHECK (
    expires_at IS NULL OR expires_at > granted_at
  ),
  CONSTRAINT consent_grants_revocation_coherence_check CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_principal_id IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

-- Publication and dispatch read exactly one grant by (tenant, profile); the unique constraint
-- above already serves that lookup, so only the sweep/listing shapes need an extra index.
CREATE INDEX IF NOT EXISTS consent_grants_active_expiry_idx
  ON consent_grants (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS consent_grants_tenant_listing_idx
  ON consent_grants (tenant_id, created_at DESC, id DESC);

-- Versioned authorization fence on the occurrence.
--
-- `consent_version` records the consent version that authorised the dispatch. Publication
-- compares it with the locked grant, so authorization is re-checked against the exact version
-- that was current when the work started. Legacy occurrences dispatched before this fence
-- existed keep `NULL`, which means "the current grant must still authorise publication".
ALTER TABLE commitment_occurrences
  ADD COLUMN IF NOT EXISTS consent_version integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'occurrences_consent_version_positive_check'
       AND conrelid = 'commitment_occurrences'::regclass
  ) THEN
    ALTER TABLE commitment_occurrences
      ADD CONSTRAINT occurrences_consent_version_positive_check
      CHECK (consent_version IS NULL OR consent_version >= 1);
  END IF;
END
$$;
