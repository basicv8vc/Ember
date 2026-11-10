-- 0017_apple_nonce_replay.sql
-- Cloudflare API Worker: one-time Apple nonce use. The raw nonce and identity token are never stored.
-- Keep this in a private schema that is not exposed by Supabase's Data API.

CREATE SCHEMA IF NOT EXISTS ember_private;
REVOKE ALL ON SCHEMA ember_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS ember_private.apple_identity_nonce_replays (
  nonce_digest bytea       PRIMARY KEY,
  accepted_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT apple_identity_nonce_replays_digest_length_check
    CHECK (octet_length(nonce_digest) = 32),
  CONSTRAINT apple_identity_nonce_replays_expiry_order_check
    CHECK (expires_at > accepted_at)
);

CREATE INDEX IF NOT EXISTS apple_identity_nonce_replays_expiry_idx
  ON ember_private.apple_identity_nonce_replays (expires_at);
