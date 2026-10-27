-- P0B-01 infrastructure metadata only.
-- Business tables (tasks, runs, events, artifacts, workspaces) belong to P0B-03+.

CREATE TABLE IF NOT EXISTS platform_metadata (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_metadata (key, value)
VALUES ('ember.foundation.version', 'p0b-01')
ON CONFLICT (key) DO NOTHING;
