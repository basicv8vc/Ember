-- 0012_conversation.sql
-- B1: conversation, message and turn persistence. Additive only.
--
-- Design notes:
--   * One `main` conversation per agent (C-1). Provisioned in the sign-up transaction (I-4).
--   * `sequence` is per conversation and assigned under a row lock on `conversations` (O-2).
--   * Message bodies are business data: bounded text plus a closed `kind` CHECK (M-1/M-6).
--   * `assistant_turns` carries no execution authority; Tasks are the only execution record.

CREATE TABLE IF NOT EXISTS conversations (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  agent_id         uuid        NOT NULL,
  kind             text        NOT NULL DEFAULT 'main',
  last_sequence    bigint      NOT NULL DEFAULT 0,
  transcript_epoch bigint      NOT NULL DEFAULT 0,   -- deletion generation (§6.7)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT conversations_one_per_kind_unique UNIQUE (tenant_id, agent_id, kind),
  CONSTRAINT conversations_agent_fk FOREIGN KEY (tenant_id, agent_id)
    REFERENCES agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversations_kind_check CHECK (kind IN ('main')),
  CONSTRAINT conversations_sequence_non_negative_check CHECK (last_sequence >= 0),
  CONSTRAINT conversations_epoch_non_negative_check CHECK (transcript_epoch >= 0)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  conversation_id       uuid        NOT NULL,
  sequence              bigint      NOT NULL,
  kind                  text        NOT NULL,
  text                  text,
  model_label           text,
  simulated             boolean,
  source                text,
  task_id               uuid,
  commitment_id         uuid,
  outcome              jsonb,
  client_submission_id  uuid,
  -- FK target that is non-NULL only for `ember` rows, so `assistant_turns` cannot reference
  -- any other kind. A CHECK cannot inspect the referenced row's kind; an FK on a generated
  -- column can (T-2, §7.5).
  ember_only_id         uuid        GENERATED ALWAYS AS (CASE WHEN kind = 'ember' THEN id END) STORED,
  -- Same trick for the user message a turn answers (S-1).
  user_only_id          uuid        GENERATED ALWAYS AS (CASE WHEN kind = 'user' THEN id END) STORED,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT conversation_messages_tenant_conversation_id_unique
    UNIQUE (tenant_id, conversation_id, id),
  CONSTRAINT conversation_messages_sequence_unique UNIQUE (tenant_id, conversation_id, sequence),
  CONSTRAINT conversation_messages_tenant_submission_unique
    UNIQUE (tenant_id, conversation_id, client_submission_id),
  CONSTRAINT conversation_messages_ember_target_unique
    UNIQUE (tenant_id, conversation_id, ember_only_id),
  CONSTRAINT conversation_messages_user_target_unique
    UNIQUE (tenant_id, conversation_id, user_only_id),
  CONSTRAINT conversation_messages_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  -- L-5: a `task_reference` points at a real Task in the same tenant.
  CONSTRAINT conversation_messages_task_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_messages_commitment_fk FOREIGN KEY (tenant_id, commitment_id)
    REFERENCES commitments (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_messages_kind_check CHECK (
    kind IN ('user', 'ember', 'activity', 'task_reference',
             'commitment_reference', 'outcome_reference')
  ),
  -- M-2/M-3 closed union: each variant names every other variant's fields as NULL, so a
  -- reference row cannot carry `model_label`/`simulated`/`source`/`client_submission_id`, and a
  -- text row cannot carry a reference. The `OR` chain is the whole point: without it PostgreSQL
  -- rejects the DDL, which is what B1-1's migration smoke test proves.
  CONSTRAINT conversation_messages_shape_check CHECK (
    (kind = 'user'
      AND text IS NOT NULL AND client_submission_id IS NOT NULL
      AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND task_id IS NULL AND commitment_id IS NULL AND outcome IS NULL)
    OR
    (kind = 'ember'
      AND text IS NOT NULL AND model_label IS NOT NULL AND simulated IS NOT NULL
      AND client_submission_id IS NULL AND source IS NULL
      AND task_id IS NULL AND commitment_id IS NULL AND outcome IS NULL)
    OR
    (kind = 'activity'
      AND text IS NOT NULL AND source IS NOT NULL
      AND model_label IS NULL AND simulated IS NULL AND client_submission_id IS NULL
      AND task_id IS NULL AND commitment_id IS NULL AND outcome IS NULL)
    OR
    (kind = 'task_reference'
      AND task_id IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND commitment_id IS NULL AND outcome IS NULL AND client_submission_id IS NULL)
    OR
    (kind = 'commitment_reference'
      AND commitment_id IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND task_id IS NULL AND outcome IS NULL AND client_submission_id IS NULL)
    OR
    (kind = 'outcome_reference'
      AND outcome IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND task_id IS NULL AND commitment_id IS NULL AND client_submission_id IS NULL)
  ),
  -- M-6: per-kind bounds replace one global bound, so an `activity` line cannot be 8 KiB.
  CONSTRAINT conversation_messages_text_bounds_check CHECK (
    (kind = 'user' AND char_length(text) BETWEEN 1 AND 4096)
    OR (kind = 'ember' AND char_length(text) BETWEEN 1 AND 8192)
    OR (kind = 'activity' AND char_length(text) BETWEEN 1 AND 280)
    OR kind IN ('task_reference', 'commitment_reference', 'outcome_reference')
  )
);

CREATE INDEX IF NOT EXISTS conversation_messages_page_idx
  ON conversation_messages (tenant_id, conversation_id, sequence);

-- L-4/L-9: one Task is referenced by at most one message, and the linkage equality check plus
-- the reverse read are a single indexed lookup.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_task_link_unique
  ON conversation_messages (tenant_id, task_id)
  WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS assistant_turns (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  conversation_id     uuid        NOT NULL,
  source_message_id   uuid        NOT NULL,
  response_message_id uuid,
  status              text        NOT NULL DEFAULT 'running',
  failure_reason      text,
  deadline_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_turns_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT assistant_turns_source_unique UNIQUE (tenant_id, source_message_id),
  -- T-2: one message is the response of at most one turn.
  CONSTRAINT assistant_turns_response_unique UNIQUE (tenant_id, response_message_id),
  CONSTRAINT assistant_turns_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  -- S-1/T-2, enforced by the database rather than by convention: the source message must be a
  -- `user` message and the response message must be an `ember` message, and both must live in
  -- this turn's conversation. The referenced targets are generated columns, so any other kind
  -- has no match and the insert fails.
  CONSTRAINT assistant_turns_source_message_fk
    FOREIGN KEY (tenant_id, conversation_id, source_message_id)
    REFERENCES conversation_messages (tenant_id, conversation_id, user_only_id) ON DELETE CASCADE,
  CONSTRAINT assistant_turns_response_message_fk
    FOREIGN KEY (tenant_id, conversation_id, response_message_id)
    REFERENCES conversation_messages (tenant_id, conversation_id, ember_only_id) ON DELETE CASCADE,
  CONSTRAINT assistant_turns_status_check CHECK (
    status IN ('running', 'completed', 'failed', 'cancelled')
  ),
  -- A CHECK accepts UNKNOWN; failed turns must explicitly carry a known reason.
  CONSTRAINT assistant_turns_failure_reason_check CHECK (
    (status = 'failed' AND failure_reason IS NOT NULL
      AND failure_reason IN ('timeout', 'internal_error')) OR
    (status = 'cancelled' AND failure_reason IS NULL) OR
    (status IN ('running', 'completed') AND failure_reason IS NULL)
  ),
  -- T-2: `completed` always has a response message. Uniqueness and kind are the FK above.
  CONSTRAINT assistant_turns_completed_response_check CHECK (
    status <> 'completed' OR response_message_id IS NOT NULL
  ),
  -- A cancelled or failed turn may or may not have produced a message; a running one never has.
  CONSTRAINT assistant_turns_running_response_check CHECK (
    status <> 'running' OR response_message_id IS NULL
  )
);

CREATE INDEX IF NOT EXISTS assistant_turns_due_idx
  ON assistant_turns (deadline_at)
  WHERE status = 'running';
