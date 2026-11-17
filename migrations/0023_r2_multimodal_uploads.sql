-- 0023_r2_multimodal_uploads.sql
-- B3-M1: Cloudflare R2 blob backing, 15 MiB single-file limit, and broad safe MIME support.
-- Additive only; migrations 0001-0022 are immutable.

-- ---------------------------------------------------------------------------
-- 1. bytea_staged_blobs: widen limit to 15 MiB & allow R2 backend pointers
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'bytea_staged_blobs'::regclass
       AND contype = 'c'
       AND (
         pg_get_constraintdef(oid) LIKE '%262144%'
         OR pg_get_constraintdef(oid) LIKE '%octet_length(bytes)%'
       )
  LOOP
    EXECUTE format('ALTER TABLE bytea_staged_blobs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE bytea_staged_blobs
  ALTER COLUMN bytes DROP NOT NULL;

ALTER TABLE bytea_staged_blobs
  ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'postgres';

ALTER TABLE bytea_staged_blobs
  DROP CONSTRAINT IF EXISTS bytea_staged_blobs_backend_check,
  DROP CONSTRAINT IF EXISTS bytea_staged_blobs_size_limit_check,
  DROP CONSTRAINT IF EXISTS bytea_staged_blobs_payload_check;

ALTER TABLE bytea_staged_blobs
  ADD CONSTRAINT bytea_staged_blobs_backend_check
    CHECK (storage_backend IN ('postgres', 'r2')),
  ADD CONSTRAINT bytea_staged_blobs_size_limit_check
    CHECK (size BETWEEN 0 AND 15728640),
  ADD CONSTRAINT bytea_staged_blobs_payload_check
    CHECK (
      (storage_backend = 'postgres' AND bytes IS NOT NULL AND octet_length(bytes) = size)
      OR (storage_backend = 'r2' AND bytes IS NULL)
    );

-- ---------------------------------------------------------------------------
-- 2. bytea_blobs: widen limit to 15 MiB & allow R2 backend pointers
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'bytea_blobs'::regclass
       AND contype = 'c'
       AND (
         pg_get_constraintdef(oid) LIKE '%262144%'
         OR pg_get_constraintdef(oid) LIKE '%octet_length(bytes)%'
       )
  LOOP
    EXECUTE format('ALTER TABLE bytea_blobs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE bytea_blobs
  ALTER COLUMN bytes DROP NOT NULL;

ALTER TABLE bytea_blobs
  ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'postgres';

ALTER TABLE bytea_blobs
  DROP CONSTRAINT IF EXISTS bytea_blobs_backend_check,
  DROP CONSTRAINT IF EXISTS bytea_blobs_size_limit_check,
  DROP CONSTRAINT IF EXISTS bytea_blobs_payload_check;

ALTER TABLE bytea_blobs
  ADD CONSTRAINT bytea_blobs_backend_check
    CHECK (storage_backend IN ('postgres', 'r2')),
  ADD CONSTRAINT bytea_blobs_size_limit_check
    CHECK (size BETWEEN 0 AND 15728640),
  ADD CONSTRAINT bytea_blobs_payload_check
    CHECK (
      (storage_backend = 'postgres' AND bytes IS NOT NULL AND octet_length(bytes) = size)
      OR (storage_backend = 'r2' AND bytes IS NULL)
    );

-- ---------------------------------------------------------------------------
-- 3. user_staged_uploads: widen limit to 15 MiB, support R2 keys & safe MIMEs
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'user_staged_uploads'::regclass
       AND contype = 'c'
       AND (
         pg_get_constraintdef(oid) LIKE '%262144%'
         OR pg_get_constraintdef(oid) LIKE '%octet_length(bytes)%'
         OR pg_get_constraintdef(oid) LIKE '%text/markdown%'
       )
  LOOP
    EXECUTE format('ALTER TABLE user_staged_uploads DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE user_staged_uploads
  ALTER COLUMN bytes DROP NOT NULL;

ALTER TABLE user_staged_uploads
  ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS storage_key text;

ALTER TABLE user_staged_uploads
  DROP CONSTRAINT IF EXISTS user_staged_uploads_backend_check,
  DROP CONSTRAINT IF EXISTS user_staged_uploads_size_limit_check,
  DROP CONSTRAINT IF EXISTS user_staged_uploads_payload_check,
  DROP CONSTRAINT IF EXISTS user_staged_uploads_media_type_format_check;

ALTER TABLE user_staged_uploads
  ADD CONSTRAINT user_staged_uploads_backend_check
    CHECK (storage_backend IN ('postgres', 'r2')),
  ADD CONSTRAINT user_staged_uploads_size_limit_check
    CHECK (size BETWEEN 0 AND 15728640),
  ADD CONSTRAINT user_staged_uploads_payload_check
    CHECK (
      (
        storage_backend = 'postgres'
        AND bytes IS NOT NULL
        AND octet_length(bytes) = size
        AND storage_key IS NULL
      )
      OR (
        storage_backend = 'r2'
        AND bytes IS NULL
        AND storage_key IS NOT NULL
        AND storage_key ~ '^uploads/[0-9a-f-]{36}/[0-9a-f-]{36}$'
      )
    ),
  ADD CONSTRAINT user_staged_uploads_media_type_format_check
    CHECK (
      char_length(media_type) BETWEEN 3 AND 128
      AND media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$'
      AND media_type NOT IN (
        'text/html',
        'application/xhtml+xml',
        'image/svg+xml',
        'application/javascript',
        'text/javascript'
      )
    );
