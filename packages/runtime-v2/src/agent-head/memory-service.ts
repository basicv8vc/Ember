import { DomainError } from '@ember/domain';
import {
  PERSONAL_MEMORY_MAX_CONTENT_CHARS,
  PERSONAL_MEMORY_MAX_ITEMS,
  PERSONAL_MEMORY_MAX_RETRIEVED_CHARS,
  PERSONAL_MEMORY_MAX_RETRIEVED_ITEMS,
  personalMemoryIdSchema,
  savePersonalMemoryRequestSchema,
  type PersonalMemoryCommand,
  type PersonalMemoryContextItem,
  type PersonalMemoryDeleteResultDto,
  type PersonalMemoryItemDto,
  type PersonalMemoryKind,
  type PersonalMemoryListDto,
  type PersonalMemoryResponse,
  type PersonalMemorySaveResultDto,
  type PersonalMemorySource,
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
    const sourceConversationId = input.provenance.conversation_id ?? null;
    const sourceMessageId = input.provenance.message_id ?? null;

    return this.deps.storage.transactionSync(() => {
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
          this.sql.exec(
            `UPDATE personal_memories
                SET kind = ?,
                    content = ?,
                    provenance_source = ?,
                    source_conversation_id = ?,
                    source_message_id = ?,
                    updated_at_ms = ?
              WHERE id = ?
                AND tenant_id = ?
                AND principal_id = ?`,
            input.kind,
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
           content,
           provenance_source,
           source_conversation_id,
           source_message_id,
           created_at_ms,
           updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        cmd.tenantId,
        cmd.principalId,
        input.kind,
        memoryKey,
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
