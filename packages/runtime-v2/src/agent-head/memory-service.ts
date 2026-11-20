import { DomainError } from '@ember/domain';
import {
  PERSONAL_MEMORY_MAX_CONTENT_CHARS,
  PERSONAL_MEMORY_MAX_ITEMS,
  PERSONAL_MEMORY_MAX_RETRIEVED_CHARS,
  PERSONAL_MEMORY_MAX_RETRIEVED_ITEMS,
  personalMemoryIdSchema,
  personalMemorySaveTurnCommandSchema,
  savePersonalMemoryRequestSchema,
  updatePersonalMemoryRequestSchema,
  type PersonalMemoryCommand,
  type PersonalMemoryContextItem,
  type PersonalMemoryDeleteResultDto,
  type PersonalMemoryItemDto,
  type PersonalMemoryKind,
  type PersonalMemoryListDto,
  type PersonalMemoryResponse,
  type PersonalMemorySaveResultDto,
  type PersonalMemorySaveTurnCommand,
  type PersonalMemorySource,
  type PersonalMemoryUpdateResultDto,
} from '../contracts/personal-memory.js';
import type { DurableObjectStorageLike, SqlStorageLike } from '../storage.js';
import { assertHeadScopeSync, sqlExecAll, sqlExecMaybe } from './queries.js';
import { toIsoTimestamp } from './state-machine.js';

export interface PersonalMemoryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly kind: PersonalMemoryKind;
  readonly memory_key: string | null;
  readonly client_request_id: string | null;
  readonly content: string;
  readonly provenance_source: PersonalMemorySource;
  readonly source_conversation_id: string | null;
  readonly source_message_id: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

function toPersonalMemoryDto(row: PersonalMemoryRow): PersonalMemoryItemDto {
  return {
    memory_id: row.id,
    kind: row.kind,
    key: row.memory_key,
    content: row.content,
    provenance: {
      source: row.provenance_source,
      conversation_id: row.source_conversation_id,
      message_id: row.source_message_id,
    },
    created_at: toIsoTimestamp(row.created_at_ms),
    updated_at: toIsoTimestamp(row.updated_at_ms),
  };
}

/**
 * Read bounded account-scoped personal memories for conversation turn context injection.
 * Ordered newest-updated first; drops items once either the item count or character ceiling
 * would be exceeded. Never throws when the table is empty.
 */
export function readPersonalMemoriesForTurnSync(
  sql: SqlStorageLike,
  tenantId: string,
  principalId: string,
  maxItems = PERSONAL_MEMORY_MAX_RETRIEVED_ITEMS,
  maxChars = PERSONAL_MEMORY_MAX_RETRIEVED_CHARS,
): readonly PersonalMemoryContextItem[] {
  const rows = sqlExecAll<Pick<PersonalMemoryRow, 'kind' | 'memory_key' | 'content'>>(
    sql,
    `SELECT kind, memory_key, content
       FROM personal_memories
      WHERE tenant_id = ?
        AND principal_id = ?
      ORDER BY updated_at_ms DESC, id ASC
      LIMIT ?`,
    tenantId,
    principalId,
    maxItems,
  );

  const selected: PersonalMemoryContextItem[] = [];
  let usedChars = 0;

  for (const row of rows) {
    const entryChars = row.content.length + (row.memory_key?.length ?? 0) + row.kind.length + 8;
    if (usedChars + entryChars > maxChars) {
      break;
    }
    selected.push({
      kind: row.kind,
      ...(row.memory_key !== null ? { key: row.memory_key } : {}),
      content: row.content,
    });
    usedChars += entryChars;
  }

  return selected;
}

function normalizeMemoryContentForDedup(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const PERSONAL_MEMORY_SAVED_REPLY = 'Saved to your personal memory.';
export const PERSONAL_MEMORY_UPDATED_REPLY = 'Updated your personal memory.';
export const PERSONAL_MEMORY_LIMIT_EXCEEDED_REPLY =
  "I couldn't save that memory because you've reached the 50-item personal memory limit. Please remove an older item in Memory settings and try again.";
export const PERSONAL_MEMORY_SAVE_UNAVAILABLE_REPLY =
  "I couldn't save that memory right now. Please try saving it in Memory settings.";

export type TurnPersonalMemorySaveOutcome =
  | { readonly outcome: 'saved'; readonly memoryId: string; readonly created: boolean }
  | { readonly outcome: 'budget_exceeded' };

/**
 * Atomically persist an explicitly model-requested personal memory inside the turn commit
 * transaction, using server-verified `(conversationId, sourceMessageId)` provenance and
 * `client_request_id = turnId` for strict idempotency on commit retries.
 */
export function savePersonalMemoryFromTurnSync(
  sql: SqlStorageLike,
  params: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly turnId: string;
    readonly conversationId: string;
    readonly sourceMessageId: string;
    readonly input: PersonalMemorySaveTurnCommand;
    readonly nowMs: number;
    readonly newId: () => string;
  },
): TurnPersonalMemorySaveOutcome {
  const parsed = personalMemorySaveTurnCommandSchema.parse(params.input);
  const memoryKey = parsed.key ?? null;
  const clientRequestId = params.turnId.toLowerCase();

  const existingByTurn = sqlExecMaybe<Pick<PersonalMemoryRow, 'id'>>(
    sql,
    `SELECT id
       FROM personal_memories
      WHERE tenant_id = ?
        AND principal_id = ?
        AND client_request_id = ?`,
    params.tenantId,
    params.principalId,
    clientRequestId,
  );
  if (existingByTurn !== null) {
    return { outcome: 'saved', memoryId: existingByTurn.id, created: false };
  }

  if (memoryKey !== null) {
    const existingByKey = sqlExecMaybe<Pick<PersonalMemoryRow, 'id'>>(
      sql,
      `SELECT id
         FROM personal_memories
        WHERE tenant_id = ?
          AND principal_id = ?
          AND memory_key = ?`,
      params.tenantId,
      params.principalId,
      memoryKey,
    );
    if (existingByKey !== null) {
      sql.exec(
        `UPDATE personal_memories
            SET kind = ?,
                client_request_id = ?,
                content = ?,
                provenance_source = 'explicit_user_request',
                source_conversation_id = ?,
                source_message_id = ?,
                updated_at_ms = ?
          WHERE id = ?
            AND tenant_id = ?
            AND principal_id = ?`,
        parsed.kind,
        clientRequestId,
        parsed.content,
        params.conversationId,
        params.sourceMessageId,
        params.nowMs,
        existingByKey.id,
        params.tenantId,
        params.principalId,
      );
      return { outcome: 'saved', memoryId: existingByKey.id, created: false };
    }
  } else {
    const normalizedContent = normalizeMemoryContentForDedup(parsed.content);
    const candidates = sqlExecAll<Pick<PersonalMemoryRow, 'id' | 'content'>>(
      sql,
      `SELECT id, content
         FROM personal_memories
        WHERE tenant_id = ?
          AND principal_id = ?
          AND kind = ?
        ORDER BY updated_at_ms DESC, id ASC`,
      params.tenantId,
      params.principalId,
      parsed.kind,
    );
    const existingByContent = candidates.find(
      (row) => normalizeMemoryContentForDedup(row.content) === normalizedContent,
    );
    if (existingByContent !== undefined) {
      sql.exec(
        `UPDATE personal_memories
            SET client_request_id = ?,
                content = ?,
                provenance_source = 'explicit_user_request',
                source_conversation_id = ?,
                source_message_id = ?,
                updated_at_ms = ?
          WHERE id = ?
            AND tenant_id = ?
            AND principal_id = ?`,
        clientRequestId,
        parsed.content,
        params.conversationId,
        params.sourceMessageId,
        params.nowMs,
        existingByContent.id,
        params.tenantId,
        params.principalId,
      );
      return { outcome: 'saved', memoryId: existingByContent.id, created: false };
    }
  }

  const countRow = sqlExecMaybe<{ readonly count: number }>(
    sql,
    `SELECT COUNT(*) AS count
       FROM personal_memories
      WHERE tenant_id = ?
        AND principal_id = ?`,
    params.tenantId,
    params.principalId,
  );
  if ((countRow?.count ?? 0) >= PERSONAL_MEMORY_MAX_ITEMS) {
    return { outcome: 'budget_exceeded' };
  }

  const id = params.newId().toLowerCase();
  sql.exec(
    `INSERT INTO personal_memories (
       id,
       tenant_id,
       principal_id,
       kind,
       memory_key,
       client_request_id,
       content,
       provenance_source,
       source_conversation_id,
       source_message_id,
       created_at_ms,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'explicit_user_request', ?, ?, ?, ?)`,
    id,
    params.tenantId,
    params.principalId,
    parsed.kind,
    memoryKey,
    clientRequestId,
    parsed.content,
    params.conversationId,
    params.sourceMessageId,
    params.nowMs,
    params.nowMs,
  );

  return { outcome: 'saved', memoryId: id, created: true };
}

export interface AgentHeadMemoryServiceDeps {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly nowMs: () => number;
  readonly newId: () => string;
}

export class AgentHeadMemoryService {
  constructor(private readonly deps: AgentHeadMemoryServiceDeps) {}

  private get sql(): SqlStorageLike {
    return this.deps.storage.sql;
  }

  execute(cmd: PersonalMemoryCommand): Promise<PersonalMemoryResponse> {
    try {
      return Promise.resolve(this.executeSync(cmd));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private executeSync(cmd: PersonalMemoryCommand): PersonalMemoryResponse {
    assertHeadScopeSync(this.sql, cmd.tenantId, cmd.agentId);

    switch (cmd.kind) {
      case 'list':
        return this.listSync(cmd.tenantId, cmd.principalId);
      case 'save':
        return this.saveSync(cmd);
      case 'update':
        return this.updateSync(cmd);
      case 'delete':
        return this.deleteSync(cmd.tenantId, cmd.principalId, cmd.memoryId);
    }
  }

  private listSync(tenantId: string, principalId: string): PersonalMemoryListDto {
    const rows = sqlExecAll<PersonalMemoryRow>(
      this.sql,
      `SELECT *
         FROM personal_memories
        WHERE tenant_id = ?
          AND principal_id = ?
        ORDER BY updated_at_ms DESC, id ASC`,
      tenantId,
      principalId,
    );

    return {
      items: rows.map(toPersonalMemoryDto),
      limits: {
        max_items: PERSONAL_MEMORY_MAX_ITEMS,
        max_content_chars: PERSONAL_MEMORY_MAX_CONTENT_CHARS,
      },
    };
  }

  private saveSync(
    cmd: Extract<PersonalMemoryCommand, { kind: 'save' }>,
  ): PersonalMemorySaveResultDto {
    const parsed = savePersonalMemoryRequestSchema.safeParse(cmd.input);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid personal memory payload');
    }

    const input = parsed.data;
    const nowMs = this.deps.nowMs();
    const memoryKey = input.key ?? null;
    const clientRequestId = input.client_request_id ?? null;
    const sourceConversationId = input.provenance.conversation_id ?? null;
    const sourceMessageId = input.provenance.message_id ?? null;

    if (sourceMessageId !== null && sourceConversationId === null) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'provenance.message_id requires provenance.conversation_id',
      );
    }

    return this.deps.storage.transactionSync(() => {
      if (sourceConversationId !== null) {
        const conversation = sqlExecMaybe<{ readonly id: string }>(
          this.sql,
          `SELECT id
             FROM conversations
            WHERE id = ?`,
          sourceConversationId,
        );
        if (conversation === null) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'provenance.conversation_id does not belong to this agent head',
          );
        }
      }

      if (sourceMessageId !== null && sourceConversationId !== null) {
        const message = sqlExecMaybe<{ readonly id: string }>(
          this.sql,
          `SELECT id
             FROM conversation_messages
            WHERE id = ?
              AND conversation_id = ?`,
          sourceMessageId,
          sourceConversationId,
        );
        if (message === null) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'provenance.message_id does not belong to the specified conversation',
          );
        }
      }

      if (clientRequestId !== null) {
        const existingByRequest = sqlExecMaybe<PersonalMemoryRow>(
          this.sql,
          `SELECT *
             FROM personal_memories
            WHERE tenant_id = ?
              AND principal_id = ?
              AND client_request_id = ?`,
          cmd.tenantId,
          cmd.principalId,
          clientRequestId,
        );
        if (existingByRequest !== null) {
          const samePayload =
            existingByRequest.kind === input.kind &&
            existingByRequest.memory_key === memoryKey &&
            existingByRequest.content === input.content &&
            existingByRequest.provenance_source === input.provenance.source &&
            existingByRequest.source_conversation_id === sourceConversationId &&
            existingByRequest.source_message_id === sourceMessageId;
          if (!samePayload) {
            throw new DomainError(
              'IDEMPOTENCY_CONFLICT',
              'client_request_id already used with different personal memory payload',
            );
          }
          return { item: toPersonalMemoryDto(existingByRequest), created: false };
        }
      }

      if (memoryKey !== null) {
        const existing = sqlExecMaybe<PersonalMemoryRow>(
          this.sql,
          `SELECT *
             FROM personal_memories
            WHERE tenant_id = ?
              AND principal_id = ?
              AND memory_key = ?`,
          cmd.tenantId,
          cmd.principalId,
          memoryKey,
        );
        if (existing !== null) {
          const nextClientRequestId = clientRequestId ?? existing.client_request_id;
          this.sql.exec(
            `UPDATE personal_memories
                SET kind = ?,
                    client_request_id = ?,
                    content = ?,
                    provenance_source = ?,
                    source_conversation_id = ?,
                    source_message_id = ?,
                    updated_at_ms = ?
              WHERE id = ?
                AND tenant_id = ?
                AND principal_id = ?`,
            input.kind,
            nextClientRequestId,
            input.content,
            input.provenance.source,
            sourceConversationId,
            sourceMessageId,
            nowMs,
            existing.id,
            cmd.tenantId,
            cmd.principalId,
          );
          const updated: PersonalMemoryRow = {
            ...existing,
            kind: input.kind,
            client_request_id: nextClientRequestId,
            content: input.content,
            provenance_source: input.provenance.source,
            source_conversation_id: sourceConversationId,
            source_message_id: sourceMessageId,
            updated_at_ms: nowMs,
          };
          return { item: toPersonalMemoryDto(updated), created: false };
        }
      }

      const countRow = sqlExecMaybe<{ readonly count: number }>(
        this.sql,
        `SELECT COUNT(*) AS count
           FROM personal_memories
          WHERE tenant_id = ?
            AND principal_id = ?`,
        cmd.tenantId,
        cmd.principalId,
      );
      if ((countRow?.count ?? 0) >= PERSONAL_MEMORY_MAX_ITEMS) {
        throw new DomainError('BUDGET_EXCEEDED', 'personal memory item limit reached');
      }

      const id = this.deps.newId().toLowerCase();
      this.sql.exec(
        `INSERT INTO personal_memories (
           id,
           tenant_id,
           principal_id,
           kind,
           memory_key,
           client_request_id,
           content,
           provenance_source,
           source_conversation_id,
           source_message_id,
           created_at_ms,
           updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        cmd.tenantId,
        cmd.principalId,
        input.kind,
        memoryKey,
        clientRequestId,
        input.content,
        input.provenance.source,
        sourceConversationId,
        sourceMessageId,
        nowMs,
        nowMs,
      );

      const created: PersonalMemoryRow = {
        id,
        tenant_id: cmd.tenantId,
        principal_id: cmd.principalId,
        kind: input.kind,
        memory_key: memoryKey,
        client_request_id: clientRequestId,
        content: input.content,
        provenance_source: input.provenance.source,
        source_conversation_id: sourceConversationId,
        source_message_id: sourceMessageId,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      };
      return { item: toPersonalMemoryDto(created), created: true };
    });
  }

  private updateSync(
    cmd: Extract<PersonalMemoryCommand, { kind: 'update' }>,
  ): PersonalMemoryUpdateResultDto {
    const parsedId = personalMemoryIdSchema.safeParse(cmd.memoryId);
    if (!parsedId.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid personal memory id');
    }
    const parsedInput = updatePersonalMemoryRequestSchema.safeParse(cmd.input);
    if (!parsedInput.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid personal memory update payload');
    }

    const memoryId = parsedId.data;
    const input = parsedInput.data;
    const nowMs = this.deps.nowMs();

    return this.deps.storage.transactionSync(() => {
      const existing = sqlExecMaybe<PersonalMemoryRow>(
        this.sql,
        `SELECT *
           FROM personal_memories
          WHERE id = ?
            AND tenant_id = ?
            AND principal_id = ?`,
        memoryId,
        cmd.tenantId,
        cmd.principalId,
      );
      if (existing === null) {
        throw new DomainError('NOT_FOUND', 'personal memory not found');
      }

      const nextKind = input.kind ?? existing.kind;
      const nextContent = input.content ?? existing.content;
      const nextKey = input.key === undefined ? existing.memory_key : input.key;

      if (nextKey !== null && nextKey !== existing.memory_key) {
        const collision = sqlExecMaybe<Pick<PersonalMemoryRow, 'id'>>(
          this.sql,
          `SELECT id
             FROM personal_memories
            WHERE tenant_id = ?
              AND principal_id = ?
              AND memory_key = ?
              AND id != ?`,
          cmd.tenantId,
          cmd.principalId,
          nextKey,
          memoryId,
        );
        if (collision !== null) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'personal memory key already exists');
        }
      }

      this.sql.exec(
        `UPDATE personal_memories
            SET kind = ?,
                memory_key = ?,
                content = ?,
                updated_at_ms = ?
          WHERE id = ?
            AND tenant_id = ?
            AND principal_id = ?`,
        nextKind,
        nextKey,
        nextContent,
        nowMs,
        memoryId,
        cmd.tenantId,
        cmd.principalId,
      );

      const updated: PersonalMemoryRow = {
        ...existing,
        kind: nextKind,
        memory_key: nextKey,
        content: nextContent,
        updated_at_ms: nowMs,
      };
      return { item: toPersonalMemoryDto(updated) };
    });
  }

  private deleteSync(
    tenantId: string,
    principalId: string,
    rawMemoryId: string,
  ): PersonalMemoryDeleteResultDto {
    const parsedId = personalMemoryIdSchema.safeParse(rawMemoryId);
    if (!parsedId.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid personal memory id');
    }
    const memoryId = parsedId.data;

    return this.deps.storage.transactionSync(() => {
      const existing = sqlExecMaybe<Pick<PersonalMemoryRow, 'id'>>(
        this.sql,
        `SELECT id
           FROM personal_memories
          WHERE id = ?
            AND tenant_id = ?
            AND principal_id = ?`,
        memoryId,
        tenantId,
        principalId,
      );
      if (existing === null) {
        throw new DomainError('NOT_FOUND', 'personal memory not found');
      }

      this.sql.exec(
        `DELETE FROM personal_memories
          WHERE id = ?
            AND tenant_id = ?
            AND principal_id = ?`,
        memoryId,
        tenantId,
        principalId,
      );
      return { deleted: true as const, memory_id: memoryId };
    });
  }
}
