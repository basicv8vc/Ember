import {
  B1ConversationMessageSchema,
  B1ConversationPageSchema,
  B1SendMessageReceiptSchema,
  IdSchema,
  toInvalidArgumentError,
  type B1ConversationMessage,
  type B1ConversationPage,
  type B1MessageSubmissionReconciliationDto,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import type { B1ConversationIdentity, B1ConversationRepository } from './b1-interfaces.js';
import { asDomainError, toIsoTimestamp } from './support.js';

/**
 * B1-4A durable Conversation READ side.
 *
 * Scope is the read slice of the frozen {@link B1ConversationRepository}; the write half
 * (`submitUserMessage`, `clearTranscript`) belongs to B1-3 and is deliberately absent, so this module
 * compiles and is testable on `main` without it.
 *
 * How each contract rule is satisfied:
 *
 * - **Tenant is an input, never a deduction.** Every statement carries an explicit `tenant_id = $n`
 *   predicate (C-5, ISO-2). No query resolves a tenant from a conversation id, and none is keyed by
 *   conversation id alone, so another tenant's row is indistinguishable from a missing one
 *   (C-3, ISO-3, N-5).
 * - **One snapshot per page.** Each operation is exactly ONE SQL statement. PostgreSQL gives a single
 *   statement a single snapshot even under READ COMMITTED, which is what makes `transcript_epoch` and
 *   the returned rows agree: a transcript deletion committing mid-flight can only land wholly before
 *   or wholly after the page. A two-statement read could pair a new epoch with rows that only existed
 *   at the old one, and the client's epoch fence (RD-6, §6.7) would then be repairing a page that had
 *   already lied about it.
 * - **Nothing leaves here that is not wire data.** Rows are rebuilt field by field into the frozen
 *   DTO and parsed by the frozen schema before they are returned, so an unexpected column, an unknown
 *   `kind`, or out-of-bounds text fails closed instead of leaking (M-1, RD-4).
 */

/** §6.5: `limit` is 1–100 and `after` is an integer ≥ 0. B1-4 HTTP must use the same bounds. */
export const B1_MESSAGE_PAGE_DEFAULT_LIMIT = 50;
export const B1_MESSAGE_PAGE_MAX_LIMIT = 100;

/** The read operations of {@link B1ConversationRepository}, without the B1-3 write half. */
export type B1ConversationReadOperations = Pick<
  B1ConversationRepository,
  'getMainConversation' | 'readMessages' | 'findSubmissionReceipt'
>;

const mainConversationQuerySchema = z.strictObject({
  tenantId: IdSchema,
  agentId: IdSchema,
});

const readMessagesCommandSchema = z.strictObject({
  tenantId: IdSchema,
  conversationId: IdSchema,
  after: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(B1_MESSAGE_PAGE_MAX_LIMIT),
});

const findSubmissionReceiptCommandSchema = z.strictObject({
  tenantId: IdSchema,
  clientSubmissionId: IdSchema,
});

/**
 * The tenant-qualified `main` Conversation (C-1). `kind = 'main'` belongs in the lookup rather than
 * in a post-filter: B1 exposes no conversation list, so no other row is reachable through here.
 */
const SELECT_MAIN_CONVERSATION_SQL = `
SELECT id, tenant_id, agent_id, transcript_epoch, last_sequence
  FROM conversations
 WHERE tenant_id = $1::uuid
   AND agent_id = $2::uuid
   AND kind = 'main'
`;

/**
 * Message page plus the Conversation's current epoch, in a single statement (§6.5, RD-1…RD-6).
 *
 * `scoped_conversation` is the tenant gate, so 0 rows means "not yours, or not there" — one answer
 * for both. The `LEFT JOIN LATERAL` keeps the Conversation row present when nothing matched, which is
 * how an empty page still carries its epoch and `next_after = after` (O-5). `LIMIT limit + 1` is the
 * RD-3 probe.
 */
const SELECT_MESSAGE_PAGE_SQL = `
WITH scoped_conversation AS (
  SELECT c.id, c.transcript_epoch
    FROM conversations c
   WHERE c.tenant_id = $1::uuid
     AND c.id = $2::uuid
)
SELECT s.id AS conversation_id,
       s.transcript_epoch,
       m.id AS message_id,
       m.sequence AS message_sequence,
       m.kind,
       m.text,
       m.model_label,
       m.simulated,
       m.source,
       m.task_id,
       m.commitment_id,
       m.outcome,
       m.client_submission_id,
       m.created_at
  FROM scoped_conversation s
  LEFT JOIN LATERAL (
    SELECT candidate.id,
           candidate.sequence,
           candidate.kind,
           candidate.text,
           candidate.model_label,
           candidate.simulated,
           candidate.source,
           candidate.task_id,
           candidate.commitment_id,
           candidate.outcome,
           candidate.client_submission_id,
           candidate.created_at
      FROM conversation_messages candidate
     WHERE candidate.tenant_id = $1::uuid
       AND candidate.conversation_id = s.id
       AND candidate.sequence > $3::bigint
     ORDER BY candidate.sequence ASC
     LIMIT $4::int
  ) m ON true
 ORDER BY m.sequence ASC NULLS FIRST
`;

/**
 * Original POST receipt, keyed only by `(tenant_id, client_submission_id)` — no conversation id,
 * because tenant-wide uniqueness is what makes an Unknown-ACK lookup unambiguous (§10.1 N-2, CTO
 * Decision 0002).
 *
 * `assistant_turns` contributes the `turn_id` and the original `created_at`, and nothing else. Its
 * `status` and `updated_at` are never read: this body is what the server already acknowledged, and a
 * Turn's current state is a different question owned by `GET .../turns/{id}` (§7.4).
 */
const SELECT_SUBMISSION_RECEIPT_SQL = `
SELECT c.transcript_epoch,
       m.id AS message_id,
       m.conversation_id,
       m.sequence,
       m.kind,
       m.text,
       m.client_submission_id,
       m.created_at AS message_created_at,
       t.id AS turn_id,
       t.created_at AS turn_created_at
  FROM conversation_messages m
  JOIN conversations c
    ON c.tenant_id = m.tenant_id
   AND c.id = m.conversation_id
  JOIN assistant_turns t
    ON t.tenant_id = m.tenant_id
   AND t.conversation_id = m.conversation_id
   AND t.source_message_id = m.id
 WHERE m.tenant_id = $1::uuid
   AND m.client_submission_id = $2::uuid
`;

interface MainConversationRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  transcript_epoch: string | number;
  last_sequence: string | number;
}

/**
 * One row per message, plus one row with every `m.*` column NULL when the page is empty. The
 * Conversation columns are populated on every row, which is what lets an empty page report its epoch.
 */
interface MessagePageRow {
  conversation_id: string;
  transcript_epoch: string | number;
  message_id: string | null;
  message_sequence: string | number | null;
  kind: string | null;
  text: string | null;
  model_label: string | null;
  simulated: boolean | null;
  source: string | null;
  task_id: string | null;
  commitment_id: string | null;
  outcome: unknown;
  client_submission_id: string | null;
  created_at: Date | string | null;
}

interface SubmissionReceiptRow {
  transcript_epoch: string | number;
  message_id: string;
  conversation_id: string;
  sequence: string | number;
  kind: string;
  text: string | null;
  client_submission_id: string | null;
  message_created_at: Date | string;
  turn_id: string;
  turn_created_at: Date | string;
}

/**
 * PostgreSQL `bigint` arrives as a string and is only exact below 2^53. A value outside that range is
 * a corrupted or unintended row, not something to round silently into a wire integer.
 */
function toSafeInteger(value: string | number, column: string): number {
  const numeric = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(numeric)) {
    throw asDomainError(new Error(`column ${column} is outside the safe integer range: ${value}`));
  }

  return numeric;
}

/**
 * The columns this variant owns and no other: the frozen union's `strictObject` arms reject anything
 * else, so shaping per kind is also what keeps internal columns out of the wire (§6.2 M-2/M-3).
 */
function toVariantFields(row: MessagePageRow, kind: string): Record<string, unknown> {
  switch (kind) {
    case 'user':
      return { text: row.text, client_submission_id: row.client_submission_id };
    case 'ember':
      return { text: row.text, model_label: row.model_label, simulated: row.simulated };
    case 'activity':
      return { text: row.text, source: row.source };
    case 'task_reference':
      return { task_id: row.task_id };
    case 'commitment_reference':
      return { commitment_id: row.commitment_id };
    case 'outcome_reference':
      return { outcome: row.outcome };
    default:
      // An unfrozen kind gets no fields, so the union rejects it instead of inventing a variant.
      return {};
  }
}

/**
 * Rebuild one row as exactly one member of the frozen discriminated union, then parse it. An unknown
 * `kind` fails closed rather than being coerced into prose (M-1).
 */
function toConversationMessage(row: MessagePageRow): B1ConversationMessage {
  const { message_id: messageId, message_sequence: sequence, created_at: createdAt } = row;

  if (messageId === null || sequence === null || createdAt === null) {
    throw asDomainError(new Error('message row is missing its identity or sequence'));
  }

  const kind = row.kind ?? '';
  const candidate: unknown = {
    message_id: messageId,
    sequence: toSafeInteger(sequence, 'conversation_messages.sequence'),
    created_at: toIsoTimestamp(createdAt),
    kind,
    ...toVariantFields(row, kind),
  };

  const parsed = B1ConversationMessageSchema.safeParse(candidate);

  if (!parsed.success) {
    // Diagnostics name the row and the kind that failed, never its content (G-2).
    throw asDomainError(
      new Error(`conversation message ${messageId} is not a valid ${kind} variant`),
    );
  }

  return parsed.data;
}

export class PostgresB1ConversationReadRepository implements B1ConversationReadOperations {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Return the caller's own `main` Conversation and its current transcript epoch.
   *
   * `null` covers both "no such Conversation" and "someone else's": the agent id is matched inside
   * the verified tenant, so a Conversation id is never used to infer which tenant owns it.
   */
  async getMainConversation(tenantId: Id, agentId: Id): Promise<B1ConversationIdentity | null> {
    const parsed = mainConversationQuerySchema.safeParse({ tenantId, agentId });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    try {
      const result = await this.pool.query<MainConversationRow>(SELECT_MAIN_CONVERSATION_SQL, [
        parsed.data.tenantId,
        parsed.data.agentId,
      ]);
      const row = result.rows[0];

      if (row === undefined) {
        return null;
      }

      return {
        conversationId: row.id,
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        transcriptEpoch: toSafeInteger(row.transcript_epoch, 'conversations.transcript_epoch'),
        lastSequence: toSafeInteger(row.last_sequence, 'conversations.last_sequence'),
      };
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Forward-only message page (RD-1…RD-6).
   *
   * Ordering is `sequence ASC` alone — server-assigned, per Conversation, never reused — so pages
   * cannot overlap or skip, and `created_at` never takes part (O-3, O-4). `after` is exclusive, which
   * is what lets a caller re-issue the `next_after` it just received as the next cursor.
   *
   * @throws {DomainError} `NOT_FOUND` for an absent Conversation and for another tenant's
   *   Conversation. Both carry the same fixed public message, so a client cannot tell them apart.
   */
  async readMessages(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly after: number;
    readonly limit: number;
  }): Promise<B1ConversationPage> {
    const parsed = readMessagesCommandSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { tenantId, conversationId, after, limit } = parsed.data;

    try {
      // One statement, so epoch and rows come from the same snapshot even mid-deletion.
      const result = await this.pool.query<MessagePageRow>(SELECT_MESSAGE_PAGE_SQL, [
        tenantId,
        conversationId,
        after,
        limit + 1,
      ]);
      const scopeRow = result.rows[0];

      if (scopeRow === undefined) {
        throw new DomainError('NOT_FOUND', 'conversation is not visible to this tenant');
      }

      const messageRows = result.rows.filter((row) => row.message_id !== null);
      // RD-3: the probe row proves more history exists without becoming part of the page.
      const hasMore = messageRows.length > limit;
      const messages = messageRows.slice(0, limit).map(toConversationMessage);
      const lastMessage = messages.at(-1);

      const page: B1ConversationPage = {
        conversation_id: conversationId,
        transcript_epoch: toSafeInteger(
          scopeRow.transcript_epoch,
          'conversations.transcript_epoch',
        ),
        messages,
        next_after: lastMessage === undefined ? after : lastMessage.sequence,
        has_more: hasMore,
      };

      // The frozen schema is the last gate: strictly ascending sequences, at most `limit` rows, and a
      // `next_after` equal to the last row (or the caller's `after` when there is none).
      return B1ConversationPageSchema.parse(page);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Recover the exact body the server acknowledged for `clientSubmissionId`, or `null` when there is
   * nothing to recover (§10.1 N-2/N-5, N-12).
   *
   * The result is the original receipt, not a live view: `turn.status` is the literal `running` the
   * POST returned, and the Turn's current status is deliberately not consulted, so a completed,
   * failed or cancelled Turn replays byte-for-byte as it did at 201.
   *
   * The Turn is joined, not optional: §6.4 S-1 makes "message without a Turn" unobservable, so a row
   * that carries no Turn is a row the client was never given a receipt for, and `null` is the honest
   * answer rather than a fabricated body.
   *
   * Deleting the transcript removes the message and its Turn, so the receipt disappears with them
   * (TE-6). That `null` means "this submission is gone" and must be read as a deletion rather than a
   * lost ACK (N-12); no tombstone is read and none is introduced.
   */
  async findSubmissionReceipt(command: {
    readonly tenantId: Id;
    readonly clientSubmissionId: Id;
  }): Promise<B1MessageSubmissionReconciliationDto | null> {
    const parsed = findSubmissionReceiptCommandSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { tenantId, clientSubmissionId } = parsed.data;

    try {
      const result = await this.pool.query<SubmissionReceiptRow>(SELECT_SUBMISSION_RECEIPT_SQL, [
        tenantId,
        clientSubmissionId,
      ]);
      const row = result.rows[0];

      if (row === undefined) {
        return null;
      }

      // Text and submission id come from the stored row, never from a retry's body, and identity is
      // never decided by matching text or timestamp (N-1, N-9).
      const receipt = {
        message: {
          message_id: row.message_id,
          conversation_id: row.conversation_id,
          sequence: toSafeInteger(row.sequence, 'conversation_messages.sequence'),
          kind: row.kind,
          text: row.text,
          client_submission_id: row.client_submission_id,
          created_at: toIsoTimestamp(row.message_created_at),
        },
        turn: {
          turn_id: row.turn_id,
          // The acknowledged status, frozen by the receipt schema — not `assistant_turns.status`.
          status: 'running',
          created_at: toIsoTimestamp(row.turn_created_at),
        },
        transcript_epoch: toSafeInteger(row.transcript_epoch, 'conversations.transcript_epoch'),
      };

      const validated = B1SendMessageReceiptSchema.safeParse(receipt);

      if (!validated.success) {
        throw asDomainError(
          new Error(`submission ${clientSubmissionId} does not reconstruct the receipt shape`),
        );
      }

      return validated.data;
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
