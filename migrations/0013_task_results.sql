-- 0013_task_results.sql
-- B1: durable, readable Task results. Additive only.
--
-- Design notes:
--   * `task_results` is written ONLY by the worker, in the same transaction that appends the
--     terminal task event (W-1/W-4). API routes are readers.
--   * `unavailable` is a stored state, not an absent row: `pending` therefore always means
--     "the task has not reached a terminal state yet" (W-2).
--   * Text is bounded and truncation is recorded, never silently applied (X-6/W-3).
--   * No credential or provider payload is stored here.

CREATE TABLE IF NOT EXISTS task_results (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  task_id        uuid        NOT NULL,
  result_state   text        NOT NULL,
  reason_code    text,
  summary_text   text,
  detail_text    text,
  truncated      boolean     NOT NULL DEFAULT false,
  model_label    text,
  simulated      boolean,
  produced_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_results_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT task_results_task_unique UNIQUE (tenant_id, task_id),
  CONSTRAINT task_results_task_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT task_results_state_check CHECK (
    result_state IN ('pending', 'available', 'unavailable')
  ),
  -- Each state has one row shape; no-text states carry neither truncation nor output metadata.
  CONSTRAINT task_results_shape_check CHECK (
    (result_state = 'pending' AND summary_text IS NULL AND detail_text IS NULL
      AND reason_code IS NULL AND truncated = false
      AND model_label IS NULL AND simulated IS NULL AND produced_at IS NULL)
    OR
    (result_state = 'available' AND summary_text IS NOT NULL AND produced_at IS NOT NULL
      AND model_label IS NOT NULL AND simulated IS NOT NULL AND reason_code IS NULL)
    OR
    (result_state = 'unavailable' AND summary_text IS NULL AND detail_text IS NULL
      AND reason_code IS NOT NULL AND truncated = false
      AND model_label IS NULL AND simulated IS NULL AND produced_at IS NULL)
  ),
  CONSTRAINT task_results_bounds_check CHECK (
    (summary_text IS NULL OR char_length(summary_text) <= 2048) AND
    (detail_text  IS NULL OR char_length(detail_text)  <= 16384)
  ),
  -- `reason_code` explains an *absent* text without duplicating `task_status` (X-3): the closed
  -- enum stays at one value in B1 and grows only if a genuinely new cause appears.
  CONSTRAINT task_results_reason_check CHECK (
    reason_code IS NULL OR reason_code = 'no_text_output'
  )
);

CREATE INDEX IF NOT EXISTS task_results_tenant_listing_idx
  ON task_results (tenant_id, created_at DESC, id DESC);
