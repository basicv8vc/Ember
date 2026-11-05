import { randomUUID } from 'node:crypto';
import {
  B1SendMessageReceiptSchema,
  B1SendMessageRequestSchema,
  toInvalidArgumentError,
  type B1SendMessageReceipt,
  type B1SendMessageRequest,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import type { B1ConversationRepository } from './b1-interfaces.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

/**
 * B1-3A: the real PostgreSQL transaction behind `submitUserMessage`.
 *
 * This slice owns the Conversation WRITE path only. Reads (`readMessages`, `findSubmissionReceipt`)
 * belong to the read repository, and the full `B1ConversationRepository` is composed by the CTO at
 * integration, so this class is typed as the `Pick` below rather than claiming the frozen interface.
 */
export type B1ConversationWriteRepository = Pick<B1ConversationRepository, 'submitUserMessage'>;

/** Annex §7.1 T-1: one Alpha turn budget, measured from the database clock at commit. */
export const B1_TURN_DEADLINE_SECONDS = 60;

/**
 * Annex §6.4 S-5 and ADR-0004 Q-2: 200 messages per rolling 24 h per Conversation.
 *
 * This is an abuse guard, not model billing. B2's inference spend cap is a separate budget with its
 * own review, so nothing here reads `budget_ledger` or counts Turns against this quota.
 */
export const B1_MESSAGE_QUOTA_LIMIT = 200;
export const B1_MESSAGE_QUOTA_WINDOW_SECONDS = 24 * 60 * 60;

/** Constraint name (annex §11.2) that makes `client_submission_id` unique tenant-wide (CTO 0002). */
const SUBMISSION_UNIQUE = 'conversation_messages_tenant_submission_unique';

/** One `RETURNING` row of {@link INSERT_USER_MESSAGE_SQL}. */
interface MessageInsertRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: string | number;
  readonly text: string;
  readonly client_submission_id: string;
  readonly created_at: Date | string;
}

/** One `RETURNING` row of {@link INSERT_ASSISTANT_TURN_SQL}. */
interface TurnInsertRow {
  readonly id: string;
  readonly created_at: Date | string;
}

/** A `SELECT … FOR UPDATE` target: the generation the fence compares against, and nothing else. */
interface ConversationLockRow {
  readonly transcript_epoch: string | number;
}

/** One row per live submission: the message plus the Turn that was created with it in S-1. */
interface SubmissionRow {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly sequence: string | number;
  readonly text: string;
  readonly client_submission_id: string;
  readonly message_created_at: Date | string;
  readonly turn_id: string | null;
  readonly turn_created_at: Date | string | null;
}

/**
 * Lock the Conversation, or observe nothing.
 *
 * Tenant qualification is inside the `WHERE` of the locked read, so a foreign Conversation and an
 * unknown one produce the same empty result (C-3, ISO-3) and neither leaks which case it was.
 */
const LOCK_CONVERSATION_SQL = `
SELECT transcript_epoch
  FROM conversations
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

/**
 * Tenant-wide submission lookup (CTO Decision 0002), read only after this transaction holds the
 * Conversation lock, so a concurrent send to the same Conversation is already serialised here.
 */
const SELECT_SUBMISSION_SQL = `
SELECT m.id                    AS message_id,
       m.conversation_id,
       m.sequence,
       m.text,
       m.client_submission_id,
       m.created_at            AS message_created_at,
       t.id                    AS turn_id,
       t.created_at            AS turn_created_at
  FROM conversation_messages m
  LEFT JOIN assistant_turns t
    ON t.tenant_id = m.tenant_id AND t.source_message_id = m.id
 WHERE m.tenant_id = $1 AND m.client_submission_id = $2
`;

const SELECT_QUOTA_COUNT_SQL = `
SELECT count(*) AS recent_messages
  FROM conversation_messages
 WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'user'
   AND created_at >= now() - ($3::int * interval '1 second')
`;

/**
 * Allocate the sequence and advance Conversation metadata in one statement (C-4, O-2).
 *
 * The row is already locked by this transaction, so `last_sequence + 1` cannot interleave with
 * another sender, and `RETURNING` hands back the server-assigned value instead of a re-read.
 */
const BUMP_SEQUENCE_SQL = `
UPDATE conversations
   SET last_sequence = last_sequence + 1,
       updated_at = now()
 WHERE tenant_id = $1 AND id = $2
RETURNING last_sequence
`;

const INSERT_USER_MESSAGE_SQL = `
INSERT INTO conversation_messages
       (id, tenant_id, conversation_id, sequence, kind, text, client_submission_id)
VALUES ($1, $2, $3, $4, 'user', $5, $6)
RETURNING id, conversation_id, sequence, text, client_submission_id, created_at
`;

/**
 * Create the one `running` Turn S-1 requires beside its message.
 *
 * `deadline_at` is an absolute instant on the database clock, so client queueing and retries consume
 * the 60 s budget instead of renewing it: a replay returns the original receipt and never rewrites
 * this column, and only the responder or the sweeper can move a Turn out of `running` (T-1).
 *
 * A client timestamp never reaches this statement: `client_created_at` is echo-only diagnostics
 * (O-4) and ordering is `sequence` alone.
 */
const INSERT_ASSISTANT_TURN_SQL = `
INSERT INTO assistant_turns
       (id, tenant_id, conversation_id, source_message_id, status, deadline_at)
VALUES ($1, $2, $3, $4, 'running', now() + ($5::int * interval '1 second'))
RETURNING id, created_at
`;

/**
 * bigint columns arrive as strings through the driver, and the wire DTO is an integer, so the
 * conversion is explicit and refuses anything a JSON client could not represent exactly.
 */
function toInteger(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new DomainError('DB_UNAVAILABLE', `${field} is not a safe integer`);
  }

  return parsed;
}

function isSubmissionIndexViolation(error: unknown): boolean {
  const details = error as { code?: unknown; constraint?: unknown };

  return details.code === '23505' && details.constraint === SUBMISSION_UNIQUE;
}

/**
 * The single canonical receipt builder, used for a new submission and for a replay alike.
 *
 * `turn.status` is the literal the POST returned at the time, not the Turn's current status: N-2
 * promises the original receipt, so a replay after the Turn reached `completed` still reports the
 * body the client lost. Parsing through the frozen schema keeps this method and the wire in step.
 */
function buildReceipt(row: SubmissionRow, transcriptEpoch: number): B1SendMessageReceipt {
  if (row.turn_id === null || row.turn_created_at === null) {
    // S-1 makes an orphaned message unreachable through this path; reporting it as a database
    // fault is honest, and silently inserting a second message would duplicate the user's text.
    throw new DomainError('DB_UNAVAILABLE', 'stored submission has no assistant turn row');
  }

  return B1SendMessageReceiptSchema.parse({
    message: {
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      sequence: toInteger(row.sequence, 'sequence'),
      kind: 'user',
      text: row.text,
      client_submission_id: row.client_submission_id,
      created_at: toIsoTimestamp(row.message_created_at),
    },
    turn: {
      turn_id: row.turn_id,
      status: 'running',
      created_at: toIsoTimestamp(row.turn_created_at),
    },
    transcript_epoch: transcriptEpoch,
  });
}

/**
 * Atomic Conversation message submission on PostgreSQL 17.
 *
 * One transaction, in this order, each step justified by the invariant it protects:
 *
 * 1. `SELECT … FOR UPDATE` on the Conversation row. Absent or foreign → `NOT_FOUND` (C-3, ISO-3).
 *    This lock is what makes the fence, the dedupe read, the quota count and the sequence
 *    allocation one decision instead of four races (O-2, TE-4).
 * 2. `transcript_epoch` fence (TE-3). Any mismatch — older or newer — is the same
 *    `IDEMPOTENCY_CONFLICT`, and nothing has been written yet, so a fenced send leaves no rows.
 * 3. Tenant-wide submission lookup (S-2/S-3, CTO Decision 0002). Same Conversation and same text →
 *    return the stored receipt with `replayed: true` and write nothing; different text, or the same
 *    ID in another Conversation of this tenant → `IDEMPOTENCY_CONFLICT`.
 * 4. Rolling-window quota (S-5) → `BUDGET_EXCEEDED` before any write.
 * 5. `UPDATE … RETURNING` allocates the next sequence and advances `updated_at`.
 * 6. One `user` message, then exactly one `running` Turn with a database-clock deadline.
 *
 * Any throw inside the transaction rolls back all of it; the caller only ever sees a receipt that
 * belongs to a committed transaction (S-4). `UNIQUE (tenant_id, client_submission_id)` is the last
 * line of defence: a submission ID that raced in from another Conversation surfaces as the same
 * 409 rather than as driver text. Public errors carry a fixed message; the cause lives only in
 * `DomainError.diagnostic`, which is never serialised (G-1, G-2, G-4).
 */
export class PostgresB1ConversationWriteRepository implements B1ConversationWriteRepository {
  constructor(private readonly pool: pg.Pool) {}

  async submitUserMessage(command: {
    readonly tenantId: Id;
    readonly conversationId: Id;
    readonly request: B1SendMessageRequest;
  }): Promise<{ readonly replayed: boolean; readonly receipt: B1SendMessageReceipt }> {
    // Request validation happens before a connection is taken, so no transaction is held while
    // parsing, and malformed input is a stable 400 rather than a database error.
    const request = this.parseRequest(command.request);

    try {
      return await withTransaction(this.pool, (client) =>
        this.submit(client, command.tenantId, command.conversationId, request),
      );
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * The frozen request schema is the authority for text bounds, UUID shape and epoch sign, so the
   * repository and the future HTTP route cannot drift into two different input rules (M-6). Only
   * issue paths and codes survive as an error; rejected values are never echoed back (G-4).
   */
  private parseRequest(request: B1SendMessageRequest): B1SendMessageRequest {
    try {
      return B1SendMessageRequestSchema.parse(request);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw toInvalidArgumentError(error);
      }

      throw error;
    }
  }

  private async submit(
    client: pg.PoolClient,
    tenantId: Id,
    conversationId: Id,
    request: B1SendMessageRequest,
  ): Promise<{ readonly replayed: boolean; readonly receipt: B1SendMessageReceipt }> {
    const locked = await client.query<ConversationLockRow>(LOCK_CONVERSATION_SQL, [
      tenantId,
      conversationId,
    ]);
    const conversation = locked.rows[0];

    if (conversation === undefined) {
      throw new DomainError('NOT_FOUND', 'conversation is not visible in this tenant');
    }

    const transcriptEpoch = toInteger(conversation.transcript_epoch, 'transcript_epoch');

    if (request.transcript_epoch !== transcriptEpoch) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        request.transcript_epoch < transcriptEpoch
          ? 'submission is fenced by a transcript deletion'
          : 'submission declares a transcript epoch the conversation has not reached',
      );
    }

    const replay = await this.findReplay(
      client,
      tenantId,
      conversationId,
      request,
      transcriptEpoch,
    );

    if (replay !== undefined) {
      return replay;
    }

    await this.assertWithinQuota(client, tenantId, conversationId);

    const bumped = await client.query<{ readonly last_sequence: string | number }>(
      BUMP_SEQUENCE_SQL,
      [tenantId, conversationId],
    );
    const allocatedRow = bumped.rows[0];

    if (allocatedRow === undefined) {
      // The row is locked two statements above, so this only happens if it disappeared mid-txn.
      throw new DomainError('NOT_FOUND', 'conversation disappeared while accepting a message');
    }

    const sequence = toInteger(allocatedRow.last_sequence, 'last_sequence');
    const messageRow = await this.insertUserMessage(
      client,
      tenantId,
      conversationId,
      sequence,
      request,
    );
    const turnRow = await this.insertAssistantTurn(client, tenantId, conversationId, messageRow.id);

    return {
      replayed: false,
      receipt: buildReceipt(
        {
          message_id: messageRow.id,
          conversation_id: messageRow.conversation_id,
          sequence: messageRow.sequence,
          text: messageRow.text,
          client_submission_id: messageRow.client_submission_id,
          message_created_at: messageRow.created_at,
          turn_id: turnRow.id,
          turn_created_at: turnRow.created_at,
        },
        transcriptEpoch,
      ),
    };
  }

  /**
   * S-2/S-3 evaluated against the rows this transaction has already locked the Conversation for, so
   * two simultaneous identical sends cannot both answer `replayed: false`.
   */
  private async findReplay(
    client: pg.PoolClient,
    tenantId: Id,
    conversationId: Id,
    request: B1SendMessageRequest,
    transcriptEpoch: number,
  ): Promise<{ readonly replayed: boolean; readonly receipt: B1SendMessageReceipt } | undefined> {
    const existing = await client.query<SubmissionRow>(SELECT_SUBMISSION_SQL, [
      tenantId,
      request.client_submission_id,
    ]);
    const submission = existing.rows[0];

    if (submission === undefined) {
      return undefined;
    }

    if (submission.conversation_id !== conversationId) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'client submission id already belongs to another conversation in this tenant',
      );
    }

    if (submission.text !== request.text) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'client submission id already belongs to different text',
      );
    }

    return { replayed: true, receipt: buildReceipt(submission, transcriptEpoch) };
  }

  /**
   * Q-2's rolling window, counted under the Conversation lock: a replay never consumes quota (it
   * returned above), and a rejected send writes nothing (S-5).
   */
  private async assertWithinQuota(
    client: pg.PoolClient,
    tenantId: Id,
    conversationId: Id,
  ): Promise<void> {
    const counted = await client.query<{ readonly recent_messages: string }>(
      SELECT_QUOTA_COUNT_SQL,
      [tenantId, conversationId, B1_MESSAGE_QUOTA_WINDOW_SECONDS],
    );
    const recent = Number(counted.rows[0]?.recent_messages ?? '0');

    if (recent >= B1_MESSAGE_QUOTA_LIMIT) {
      throw new DomainError(
        'BUDGET_EXCEEDED',
        'conversation message quota exceeded for the window',
      );
    }
  }

  private async insertUserMessage(
    client: pg.PoolClient,
    tenantId: Id,
    conversationId: Id,
    sequence: number,
    request: B1SendMessageRequest,
  ): Promise<MessageInsertRow> {
    let inserted: pg.QueryResult<MessageInsertRow>;

    try {
      inserted = await client.query<MessageInsertRow>(INSERT_USER_MESSAGE_SQL, [
        randomUUID(),
        tenantId,
        conversationId,
        sequence,
        request.text,
        request.client_submission_id,
      ]);
    } catch (error) {
      if (isSubmissionIndexViolation(error)) {
        // The dedupe read above ran under this Conversation's lock, so a violated tenant-wide index
        // can only be the same submission id committed into a *different* Conversation — which CTO
        // Decision 0002 requires to conflict. This transaction aborts, so the sequence bump is lost
        // with it and no row is left written.
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'client submission id already belongs to another conversation in this tenant',
        );
      }

      throw error;
    }

    const row = inserted.rows[0];

    if (row === undefined) {
      throw new DomainError('DB_UNAVAILABLE', 'message insert returned no row');
    }

    return row;
  }

  private async insertAssistantTurn(
    client: pg.PoolClient,
    tenantId: Id,
    conversationId: Id,
    sourceMessageId: string,
  ): Promise<TurnInsertRow> {
    const inserted = await client.query<TurnInsertRow>(INSERT_ASSISTANT_TURN_SQL, [
      randomUUID(),
      tenantId,
      conversationId,
      sourceMessageId,
      B1_TURN_DEADLINE_SECONDS,
    ]);
    const row = inserted.rows[0];

    if (row === undefined) {
      throw new DomainError('DB_UNAVAILABLE', 'assistant turn insert returned no row');
    }

    return row;
  }
}
