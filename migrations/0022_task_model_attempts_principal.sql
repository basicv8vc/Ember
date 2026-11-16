-- Additive forward migration for task_model_attempts.principal_id.
--
-- Staging applied the initial 0020_b3_notes_action_items.sql (before principal_id
-- was added) together with 0021_b3_python_agent.sql. Restoring 0020 to its
-- deployed checksum and applying principal_id in 0022 keeps existing Staging
-- migration history valid while preserving 0021 for B3-B1 Python Agent.

ALTER TABLE task_model_attempts
  ADD COLUMN IF NOT EXISTS principal_id uuid;

UPDATE task_model_attempts tma
   SET principal_id = c.principal_id
  FROM consumers c
 WHERE c.tenant_id = tma.tenant_id
   AND tma.principal_id IS NULL;

ALTER TABLE task_model_attempts
  ALTER COLUMN principal_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'task_model_attempts_principal_fk'
       AND conrelid = 'task_model_attempts'::regclass
  ) THEN
    ALTER TABLE task_model_attempts
      ADD CONSTRAINT task_model_attempts_principal_fk
      FOREIGN KEY (tenant_id, principal_id)
      REFERENCES principals (tenant_id, id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS task_model_attempts_principal_day_idx
  ON task_model_attempts (tenant_id, principal_id, utc_day);
