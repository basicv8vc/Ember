-- 0019_model_openrouter_provider.sql
-- Add the OpenRouter adapter as a second Model Gateway provider. Provider IDs remain closed and
-- audited; no model ID, credential, prompt or completion is added to the database schema.

ALTER TABLE model_turn_attempts
  DROP CONSTRAINT IF EXISTS model_turn_attempts_provider_check;

ALTER TABLE model_turn_attempts
  ADD CONSTRAINT model_turn_attempts_provider_check
  CHECK (provider_id IN ('openai', 'openrouter'));
