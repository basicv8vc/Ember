import {
  B1AssistantTurnDtoSchema,
  B1ConversationMessageSchema,
  TaskCommandSchema,
  WebEvidenceSchema,
  toInvalidArgumentError,
  type B1AssistantTurnDto,
  type B1ConversationMessage,
  type V2WebEvidenceItem,
  type WebEvidence,
} from '@ember/contracts';
import { DomainError, type Id, type TaskCommand } from '@ember/domain';
import { V2_B1_COMPAT_CONSTANTS } from '../contracts/constants.js';
import type { B2MessageAttachmentMeta, B2TurnContextRow } from '../contracts/agent-head-rpc.js';
import type { SqlStorageLike, SqlStorageRow } from '../storage.js';
import type {
  AgentHeadMetaRow,
  AssistantTurnRow,
  ConversationMessageRow,
  ConversationRow,
  MessageAttachmentRow,
  ModelAttemptRow,
  RunRow,
  TaskRow,
} from './schema.js';
import { toIsoTimestamp } from './state-machine.js';

export const TASK_COMMAND_DIGEST_VERSION = 'ember.task-command.v1';
export const TASK_COMMAND_MAX_BYTES = 64 * 1024;

export function sqlExecAll<T>(sql: SqlStorageLike, query: string, ...bindings: unknown[]): T[] {
  return sql.exec<SqlStorageRow>(query, ...bindings).toArray() as unknown as T[];
}

export function sqlExecMaybe<T>(
  sql: SqlStorageLike,
  query: string,
  ...bindings: unknown[]
): T | null {
  return sqlExecAll<T>(sql, query, ...bindings)[0] ?? null;
}

export function sqlExecOne<T>(sql: SqlStorageLike, query: string, ...bindings: unknown[]): T {
  return sql.exec<SqlStorageRow>(query, ...bindings).one() as unknown as T;
}

export function getHeadMetaSync(sql: SqlStorageLike): AgentHeadMetaRow | null {
  return sqlExecMaybe<AgentHeadMetaRow>(sql, 'SELECT * FROM agent_head_meta WHERE id = 1');
}

export function assertHeadScopeSync(
  sql: SqlStorageLike,
  tenantId: Id,
  agentId: Id,
): AgentHeadMetaRow {
  const meta = getHeadMetaSync(sql);
  if (meta === null || meta.tenant_id !== tenantId || meta.agent_id !== agentId) {
    throw new DomainError('NOT_FOUND', 'agent head is not visible in this tenant');
  }
  return meta;
}

export function getConversationSync(
  sql: SqlStorageLike,
  conversationId: Id,
): ConversationRow | null {
  return sqlExecMaybe<ConversationRow>(
    sql,
    'SELECT * FROM conversations WHERE id = ?',
    conversationId,
  );
}

export function getMainConversationSync(sql: SqlStorageLike): ConversationRow | null {
  return sqlExecMaybe<ConversationRow>(
    sql,
    `SELECT * FROM conversations WHERE kind = 'main' LIMIT 1`,
  );
}

export function toTurnDto(row: AssistantTurnRow): B1AssistantTurnDto {
  return B1AssistantTurnDtoSchema.parse({
    turn_id: row.id,
    conversation_id: row.conversation_id,
    source_message_id: row.source_message_id,
    status: row.status,
    created_at: toIsoTimestamp(row.created_at_ms),
    updated_at: toIsoTimestamp(row.updated_at_ms),
    response_message_id: row.response_message_id,
    failure_reason: row.failure_reason,
  });
}

export function toConversationMessageDto(row: ConversationMessageRow): B1ConversationMessage {
  const base = {
    message_id: row.id,
    sequence: row.sequence,
    created_at: toIsoTimestamp(row.created_at_ms),
  };

  let candidate: unknown;
  switch (row.kind) {
    case 'user':
      candidate = {
        ...base,
        kind: 'user',
        text: row.text,
        client_submission_id: row.client_submission_id,
      };
      break;
    case 'ember':
      candidate = {
        ...base,
        kind: 'ember',
        text: row.text,
        model_label: row.model_label,
        simulated: row.simulated === 1,
      };
      break;
    case 'activity':
      candidate = {
        ...base,
        kind: 'activity',
        text: row.text,
        source: row.source,
      };
      break;
    case 'task_reference':
      candidate = {
        ...base,
        kind: 'task_reference',
        task_id: row.task_id,
      };
      break;
    case 'commitment_reference':
      candidate = {
        ...base,
        kind: 'commitment_reference',
        commitment_id: row.commitment_id,
      };
      break;
    case 'outcome_reference': {
      const parsedOutcome: unknown =
        row.outcome_json === null ? null : JSON.parse(row.outcome_json);
      candidate = {
        ...base,
        kind: 'outcome_reference',
        outcome: parsedOutcome,
      };
      break;
    }
  }

  return B1ConversationMessageSchema.parse(candidate);
}

export function listAttachmentsForMessageSync(
  sql: SqlStorageLike,
  messageId: Id,
): readonly B2MessageAttachmentMeta[] {
  const rows = sqlExecAll<MessageAttachmentRow>(
    sql,
    'SELECT * FROM message_attachments WHERE message_id = ? ORDER BY position ASC',
    messageId,
  );
  return rows.map((row) => ({
    uploadId: row.upload_id,
    filename: row.filename,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
  }));
}

export function readRecentTurnContextSync(
  sql: SqlStorageLike,
  conversationId: Id,
  maxMessages = V2_B1_COMPAT_CONSTANTS.maxContextMessages,
  throughSequence: number = Number.MAX_SAFE_INTEGER,
): readonly B2TurnContextRow[] {
  const rows = sqlExecAll<ConversationMessageRow>(
    sql,
    `SELECT *
       FROM conversation_messages
      WHERE conversation_id = ?
        AND kind IN ('user', 'ember')
        AND sequence <= ?
      ORDER BY sequence DESC
      LIMIT ?`,
    conversationId,
    throughSequence,
    maxMessages,
  ).reverse();

  return rows.map((row) => {
    const attachments = row.kind === 'user' ? listAttachmentsForMessageSync(sql, row.id) : [];
    return {
      sequence: row.sequence,
      kind: row.kind as 'user' | 'ember',
      text: row.text ?? '',
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  });
}

export function allocateConversationSequenceSync(
  sql: SqlStorageLike,
  conversationId: Id,
  nowMs: number,
): number {
  sql.exec(
    `UPDATE conversations
        SET last_sequence = last_sequence + 1,
            updated_at_ms = ?
      WHERE id = ?`,
    nowMs,
    conversationId,
  );
  const row = sqlExecMaybe<{ readonly last_sequence: number }>(
    sql,
    'SELECT last_sequence FROM conversations WHERE id = ?',
    conversationId,
  );
  if (row === null) {
    throw new DomainError('NOT_FOUND', 'conversation disappeared while allocating sequence');
  }
  return row.last_sequence;
}

export function insertEmberMessageSync(input: {
  readonly sql: SqlStorageLike;
  readonly messageId: Id;
  readonly conversationId: Id;
  readonly text: string;
  readonly modelLabel: string;
  readonly simulated: boolean;
  readonly nowMs: number;
}): { readonly messageId: Id; readonly sequence: number } {
  const sequence = allocateConversationSequenceSync(input.sql, input.conversationId, input.nowMs);
  input.sql.exec(
    `INSERT INTO conversation_messages (
       id, conversation_id, sequence, kind, text, model_label, simulated, created_at_ms
     ) VALUES (?, ?, ?, 'ember', ?, ?, ?, ?)`,
    input.messageId,
    input.conversationId,
    sequence,
    input.text,
    input.modelLabel,
    input.simulated ? 1 : 0,
    input.nowMs,
  );
  return { messageId: input.messageId, sequence };
}

export function getTurnRowSync(sql: SqlStorageLike, turnId: Id): AssistantTurnRow | null {
  return sqlExecMaybe<AssistantTurnRow>(sql, 'SELECT * FROM assistant_turns WHERE id = ?', turnId);
}

export function getTaskRowSync(sql: SqlStorageLike, taskId: Id): TaskRow | null {
  return sqlExecMaybe<TaskRow>(sql, 'SELECT * FROM tasks WHERE id = ?', taskId);
}

export function getLatestRunForTaskSync(sql: SqlStorageLike, taskId: Id): RunRow | null {
  return sqlExecMaybe<RunRow>(
    sql,
    'SELECT * FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1',
    taskId,
  );
}

export function listReservedAttemptsSync(
  sql: SqlStorageLike,
  subjectType: 'turn' | 'task',
  subjectId: Id,
): readonly ModelAttemptRow[] {
  return sqlExecAll<ModelAttemptRow>(
    sql,
    `SELECT *
       FROM model_attempts
      WHERE subject_type = ? AND subject_id = ? AND state = 'reserved'
      ORDER BY attempt_no ASC`,
    subjectType,
    subjectId,
  );
}

export function getLatestAttemptForSubjectSync(
  sql: SqlStorageLike,
  subjectType: 'turn' | 'task',
  subjectId: Id,
): ModelAttemptRow | null {
  return sqlExecMaybe<ModelAttemptRow>(
    sql,
    `SELECT *
       FROM model_attempts
      WHERE subject_type = ? AND subject_id = ?
      ORDER BY attempt_no DESC
      LIMIT 1`,
    subjectType,
    subjectId,
  );
}

export function earliestBusinessAlarmAtMsSync(sql: SqlStorageLike): number | null {
  const turnRow = sqlExecOne<{ readonly m: number | null }>(
    sql,
    `SELECT MIN(
       CASE
         WHEN lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < deadline_at_ms
           THEN lease_expires_at_ms
         ELSE deadline_at_ms
       END
     ) AS m
       FROM assistant_turns
      WHERE status = 'running'`,
  );

  const taskRow = sqlExecOne<{ readonly m: number | null }>(
    sql,
    `SELECT MIN(
       CASE
         WHEN status = 'running' THEN
           CASE
             WHEN lease_expires_at_ms IS NOT NULL AND (deadline_at_ms IS NULL OR lease_expires_at_ms < deadline_at_ms)
               THEN lease_expires_at_ms
             ELSE COALESCE(deadline_at_ms, lease_expires_at_ms)
           END
         WHEN execution_target = 'device' THEN deadline_at_ms
         WHEN status IN ('queued', 'retryable_failed') THEN
           CASE
             WHEN deadline_at_ms IS NOT NULL AND deadline_at_ms < next_run_at_ms
               THEN deadline_at_ms
             ELSE next_run_at_ms
           END
         ELSE deadline_at_ms
       END
     ) AS m
       FROM tasks
      WHERE status IN ('queued', 'retryable_failed', 'running', 'waiting_approval')`,
  );

  const approvalRow = sqlExecOne<{ readonly m: number | null }>(
    sql,
    `SELECT MIN(expires_at_ms) AS m FROM approvals WHERE status = 'pending'`,
  );

  const candidates = [turnRow.m, taskRow.m, approvalRow.m].filter((v): v is number => v !== null);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = sortJsonValue(item);
      }
    }
    return sorted;
  }
  return value;
}

export async function prepareEdgeSafeTaskCommand(command: unknown): Promise<{
  readonly command: TaskCommand;
  readonly canonical: string;
  readonly digest: string;
  readonly deadlineAt: string | null;
}> {
  const parsed = TaskCommandSchema.safeParse(command);
  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  const validated = parsed.data;
  const deadlineAt =
    validated.deadlineAt === undefined ? null : new Date(validated.deadlineAt).toISOString();

  const canonical = JSON.stringify(
    sortJsonValue({
      agentId: validated.agentId,
      kind: validated.kind,
      ...(validated.title === undefined ? {} : { title: validated.title }),
      input: validated.input,
      deadlineAt,
    }),
  );

  if (new TextEncoder().encode(canonical).byteLength > TASK_COMMAND_MAX_BYTES) {
    throw new DomainError('INVALID_ARGUMENT', 'task command exceeds 64 KiB canonical limit');
  }

  const digest = await sha256Hex(`${TASK_COMMAND_DIGEST_VERSION}\n${canonical}`);

  return { command: validated, canonical, digest, deadlineAt };
}

export async function sha256Hex(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deterministicEdgeUuid(seed: string): Promise<Id> {
  const bytes = new TextEncoder().encode(seed);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(hashBuffer).slice(0, 16);
  arr[6] = (arr[6]! & 0x0f) | 0x40;
  arr[8] = (arr[8]! & 0x3f) | 0x80;
  const hex = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function hasMessageWebEvidenceTableSync(sql: SqlStorageLike): boolean {
  return (
    sql
      .exec<{ readonly name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_web_evidence'`,
      )
      .toArray().length > 0
  );
}

/**
 * Validates and stores turn web evidence linked to `response_message_id` inside
 * the authoritative commit transaction.
 */
export function insertMessageWebEvidenceSync(params: {
  readonly sql: SqlStorageLike;
  readonly messageId: Id;
  readonly turnId: Id;
  readonly webEvidence: WebEvidence;
  readonly nowMs: number;
}): WebEvidence {
  const parsed = WebEvidenceSchema.parse(params.webEvidence);
  if (parsed.turn_id !== params.turnId) {
    throw new DomainError('INVALID_ARGUMENT', 'web_evidence turn_id does not match committed turn');
  }
  if (parsed.status === 'failed' || parsed.sources.length === 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'cannot persist empty or failed web_evidence on committed turn',
    );
  }

  params.sql.exec(
    `INSERT INTO message_web_evidence (
      message_id, turn_id, schema_version, status, evidence_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    params.messageId,
    params.turnId,
    parsed.schema_version,
    parsed.status,
    JSON.stringify(parsed),
    params.nowMs,
  );
  return parsed;
}

interface JoinedWebEvidencePageRow {
  readonly message_id: string;
  readonly sequence: number;
  readonly evidence_json: string | null;
}

/**
 * Reads a sequence-cursor-aligned page of web evidence items for a conversation.
 */
export function listMessageWebEvidencePageSync(params: {
  readonly sql: SqlStorageLike;
  readonly conversationId: Id;
  readonly after: number;
  readonly limit: number;
}): {
  readonly items: readonly V2WebEvidenceItem[];
  readonly nextAfter: number;
  readonly hasMore: boolean;
} {
  const includeEvidence = hasMessageWebEvidenceTableSync(params.sql);
  const rows = includeEvidence
    ? sqlExecAll<JoinedWebEvidencePageRow>(
        params.sql,
        `SELECT
           m.id AS message_id,
           m.sequence AS sequence,
           e.evidence_json AS evidence_json
         FROM conversation_messages m
         LEFT JOIN message_web_evidence e ON e.message_id = m.id
         WHERE m.conversation_id = ?
           AND m.sequence > ?
         ORDER BY m.sequence ASC
         LIMIT ?`,
        params.conversationId,
        params.after,
        params.limit + 1,
      )
    : sqlExecAll<{ readonly id: string; readonly sequence: number }>(
        params.sql,
        `SELECT id, sequence
           FROM conversation_messages
          WHERE conversation_id = ?
            AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?`,
        params.conversationId,
        params.after,
        params.limit + 1,
      ).map((row) => ({
        message_id: row.id,
        sequence: row.sequence,
        evidence_json: null,
      }));

  const hasMore = rows.length > params.limit;
  const pageRows = rows.slice(0, params.limit);
  const lastRow = pageRows.at(-1);
  const items: V2WebEvidenceItem[] = [];

  for (const row of pageRows) {
    if (row.evidence_json === null) {
      continue;
    }
    const parsedEvidence = WebEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
    items.push({
      response_message_id: row.message_id,
      sequence: row.sequence,
      web_evidence: parsedEvidence,
    });
  }

  return {
    items,
    nextAfter: lastRow === undefined ? params.after : lastRow.sequence,
    hasMore,
  };
}
