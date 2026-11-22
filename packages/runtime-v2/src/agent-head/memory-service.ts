import { DomainError } from '@ember/domain';
import {
  PERSONAL_MEMORY_MAX_CONTENT_CHARS,
  PERSONAL_MEMORY_MAX_ITEMS,
  PERSONAL_MEMORY_MAX_RETRIEVED_CHARS,
  PERSONAL_MEMORY_MAX_RETRIEVED_ITEMS,
  personalMemoryDeleteTurnCommandSchema,
  personalMemoryIdSchema,
  personalMemorySaveTurnCommandSchema,
  savePersonalMemoryRequestSchema,
  updatePersonalMemoryRequestSchema,
  type PersonalMemoryCommand,
  type PersonalMemoryContextItem,
  type PersonalMemoryDeleteResultDto,
  type PersonalMemoryDeleteTurnCommand,
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
  const rows = sqlExecAll<Pick<PersonalMemoryRow, 'id' | 'kind' | 'memory_key' | 'content'>>(
    sql,
    `SELECT id, kind, memory_key, content
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
    const entryChars = row.content.length + (row.memory_key?.length ?? 0) + row.kind.length + 19;
    if (usedChars + entryChars > maxChars) {
      break;
    }
    selected.push({
      id: row.id,
      kind: row.kind,
      ...(row.memory_key !== null ? { key: row.memory_key } : {}),
      content: row.content,
    });
    usedChars += entryChars;
  }

  return selected;
}

export const PERSONAL_MEMORY_SAVED_REPLY = 'Saved to your personal memory.';
export const PERSONAL_MEMORY_UPDATED_REPLY = 'Updated your personal memory.';
export const PERSONAL_MEMORY_DELETED_REPLY = 'Removed from your personal memory.';
export const PERSONAL_MEMORY_LIMIT_EXCEEDED_REPLY =
  "I couldn't save that memory because you've reached the 50-item personal memory limit. Please remove an older item in Memory settings and try again.";
export const PERSONAL_MEMORY_SAVE_UNAVAILABLE_REPLY =
  "I couldn't save that memory right now. Please try saving it in Memory settings.";
export const PERSONAL_MEMORY_DELETE_UNAVAILABLE_REPLY =
  "I couldn't remove that memory right now. Please try removing it in Memory settings.";

const PLACEHOLDER_MEMORY_ACKS = new Set([
  "Got it — I'll remember that.",
  "Got it — I'll remove that from your personal memory.",
  PERSONAL_MEMORY_SAVED_REPLY,
  PERSONAL_MEMORY_UPDATED_REPLY,
  PERSONAL_MEMORY_DELETED_REPLY,
]);

function hasChineseText(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

type MemoryLookupMatch =
  | {
      readonly status: 'matched';
      readonly row: Pick<PersonalMemoryRow, 'id' | 'memory_key' | 'content'>;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous' };

function findUniqueMemoryByRefSync(
  sql: SqlStorageLike,
  tenantId: string,
  principalId: string,
  refId: string,
): MemoryLookupMatch {
  const normalized = refId.trim().replace(/^#+/, '').toLowerCase();
  if (normalized.length < 4) {
    return { status: 'not_found' };
  }
  const exact = sqlExecMaybe<Pick<PersonalMemoryRow, 'id' | 'memory_key' | 'content'>>(
    sql,
    `SELECT id, memory_key, content
       FROM personal_memories
      WHERE tenant_id = ?
        AND principal_id = ?
        AND id = ?`,
    tenantId,
    principalId,
    normalized,
  );
  if (exact !== null) {
    return { status: 'matched', row: exact };
  }
  const prefixMatches = sqlExecAll<Pick<PersonalMemoryRow, 'id' | 'memory_key' | 'content'>>(
    sql,
    `SELECT id, memory_key, content
       FROM personal_memories
      WHERE tenant_id = ?
        AND principal_id = ?
        AND id LIKE ? ESCAPE '\\'
      LIMIT 2`,
    tenantId,
    principalId,
    `${escapeSqlLike(normalized)}%`,
  );
  if (prefixMatches.length === 1) {
    return { status: 'matched', row: prefixMatches[0]! };
  }
  return prefixMatches.length > 1 ? { status: 'ambiguous' } : { status: 'not_found' };
}

export type TurnPersonalMemorySaveOutcome =
  | {
      readonly outcome: 'saved';
      readonly memoryId: string;
      readonly created: boolean;
      readonly content: string;
    }
  | { readonly outcome: 'budget_exceeded' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'ambiguous' };

export interface TurnPersonalMemoryDeleteOutcome {
  readonly deletedCount: number;
  readonly deletedContents: readonly string[];
  readonly notFoundCount: number;
  readonly ambiguousCount: number;
}

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
  const replaceId = parsed.replaceId ?? null;
  const clientRequestId = params.turnId.toLowerCase();

  const existingByTurn = sqlExecMaybe<Pick<PersonalMemoryRow, 'id' | 'content'>>(
    sql,
    `SELECT id, content
       FROM personal_memories
      WHERE tenant_id = ?
        AND principal_id = ?
        AND client_request_id = ?`,
    params.tenantId,
    params.principalId,
    clientRequestId,
  );
  if (existingByTurn !== null) {
    return {
      outcome: 'saved',
      memoryId: existingByTurn.id,
      created: false,
      content: existingByTurn.content,
    };
  }

  if (replaceId !== null) {
    const targetMatch = findUniqueMemoryByRefSync(
      sql,
      params.tenantId,
      params.principalId,
      replaceId,
    );
    if (targetMatch.status === 'not_found') {
      return { outcome: 'not_found' };
    }
    if (targetMatch.status === 'ambiguous') {
      return { outcome: 'ambiguous' };
    }
    let nextKey = targetMatch.row.memory_key;
    if (memoryKey !== null && memoryKey !== targetMatch.row.memory_key) {
      const collision = sqlExecMaybe<Pick<PersonalMemoryRow, 'id'>>(
        sql,
        `SELECT id
             FROM personal_memories
            WHERE tenant_id = ?
              AND principal_id = ?
              AND memory_key = ?
              AND id != ?`,
        params.tenantId,
        params.principalId,
        memoryKey,
        targetMatch.row.id,
      );
      if (collision === null) {
        nextKey = memoryKey;
      }
    }
    sql.exec(
      `UPDATE personal_memories
            SET kind = ?,
                memory_key = ?,
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
      nextKey,
      clientRequestId,
      parsed.content,
      params.conversationId,
      params.sourceMessageId,
      params.nowMs,
      targetMatch.row.id,
      params.tenantId,
      params.principalId,
    );
    return {
      outcome: 'saved',
      memoryId: targetMatch.row.id,
      created: false,
      content: parsed.content,
    };
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
      return {
        outcome: 'saved',
        memoryId: existingByKey.id,
        created: false,
        content: parsed.content,
      };
    }

    const existingUnkeyedByContent = sqlExecMaybe<Pick<PersonalMemoryRow, 'id'>>(
      sql,
      `SELECT id
         FROM personal_memories
        WHERE tenant_id = ?
          AND principal_id = ?
          AND memory_key IS NULL
          AND kind = ?
          AND content = ?
        ORDER BY updated_at_ms DESC, id ASC
        LIMIT 1`,
      params.tenantId,
      params.principalId,
      parsed.kind,
      parsed.content,
    );
    if (existingUnkeyedByContent !== null) {
      sql.exec(
        `UPDATE personal_memories
            SET memory_key = ?,
                updated_at_ms = ?
          WHERE id = ?
            AND tenant_id = ?
            AND principal_id = ?`,
        memoryKey,
        params.nowMs,
        existingUnkeyedByContent.id,
        params.tenantId,
        params.principalId,
      );
      return {
        outcome: 'saved',
        memoryId: existingUnkeyedByContent.id,
        created: false,
        content: parsed.content,
      };
    }
  } else {
    const existingByContent = sqlExecMaybe<Pick<PersonalMemoryRow, 'id'>>(
      sql,
      `SELECT id
         FROM personal_memories
        WHERE tenant_id = ?
          AND principal_id = ?
          AND kind = ?
          AND content = ?
        ORDER BY updated_at_ms DESC, id ASC
        LIMIT 1`,
      params.tenantId,
      params.principalId,
      parsed.kind,
      parsed.content,
    );
    if (existingByContent !== null) {
      sql.exec(
        `UPDATE personal_memories
            SET updated_at_ms = ?
          WHERE id = ?
            AND tenant_id = ?
            AND principal_id = ?`,
        params.nowMs,
        existingByContent.id,
        params.tenantId,
        params.principalId,
      );
      return {
        outcome: 'saved',
        memoryId: existingByContent.id,
        created: false,
        content: parsed.content,
      };
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

  return { outcome: 'saved', memoryId: id, created: true, content: parsed.content };
}

function findMemoryByKeySync(
  sql: SqlStorageLike,
  tenantId: string,
  principalId: string,
  memoryKey: string,
): Pick<PersonalMemoryRow, 'id' | 'memory_key' | 'content'> | null {
  return sqlExecMaybe<Pick<PersonalMemoryRow, 'id' | 'memory_key' | 'content'>>(
    sql,
    `SELECT id, memory_key, content
       FROM personal_memories
      WHERE tenant_id = ?
        AND principal_id = ?
        AND memory_key = ?`,
    tenantId,
    principalId,
    memoryKey,
  );
}

function matchesContentSelector(rowContent: string, contentMatch: string): boolean {
  const needle = contentMatch.trim().toLowerCase();
  return needle.length > 0 && rowContent.toLowerCase().includes(needle);
}

function findMemoryForDeleteTargetSync(
  sql: SqlStorageLike,
  tenantId: string,
  principalId: string,
  target: PersonalMemoryDeleteTurnCommand['targets'][number],
): MemoryLookupMatch {
  if (target.memoryId !== undefined) {
    const byId = findUniqueMemoryByRefSync(sql, tenantId, principalId, target.memoryId);
    if (byId.status !== 'matched') {
      return byId;
    }
    if (target.key !== undefined && byId.row.memory_key !== target.key) {
      const otherByKey = findMemoryByKeySync(sql, tenantId, principalId, target.key);
      return otherByKey !== null ? { status: 'ambiguous' } : { status: 'not_found' };
    }
    if (
      target.contentMatch !== undefined &&
      !matchesContentSelector(byId.row.content, target.contentMatch)
    ) {
      return { status: 'not_found' };
    }
    return byId;
  }

  if (target.key !== undefined) {
    const byKey = findMemoryByKeySync(sql, tenantId, principalId, target.key);
    if (byKey === null) {
      return { status: 'not_found' };
    }
    if (
      target.contentMatch !== undefined &&
      !matchesContentSelector(byKey.content, target.contentMatch)
    ) {
      return { status: 'not_found' };
    }
    return { status: 'matched', row: byKey };
  }

  if (target.contentMatch !== undefined) {
    const exactMatches = sqlExecAll<Pick<PersonalMemoryRow, 'id' | 'memory_key' | 'content'>>(
      sql,
      `SELECT id, memory_key, content
         FROM personal_memories
        WHERE tenant_id = ?
          AND principal_id = ?
          AND LOWER(TRIM(content)) = LOWER(?)
        LIMIT 2`,
      tenantId,
      principalId,
      target.contentMatch,
    );
    if (exactMatches.length === 1) {
      return { status: 'matched', row: exactMatches[0]! };
    }
    if (exactMatches.length > 1) {
      return { status: 'ambiguous' };
    }

    const substringMatches = sqlExecAll<Pick<PersonalMemoryRow, 'id' | 'memory_key' | 'content'>>(
      sql,
      `SELECT id, memory_key, content
         FROM personal_memories
        WHERE tenant_id = ?
          AND principal_id = ?
          AND LOWER(content) LIKE ? ESCAPE '\\'
        LIMIT 2`,
      tenantId,
      principalId,
      `%${escapeSqlLike(target.contentMatch.toLowerCase())}%`,
    );
    if (substringMatches.length === 1) {
      return { status: 'matched', row: substringMatches[0]! };
    }
    if (substringMatches.length > 1) {
      return { status: 'ambiguous' };
    }
  }

  return { status: 'not_found' };
}

/**
 * Atomically delete explicitly model-requested personal memory items inside the turn commit
 * transaction, strictly scoped to `(tenantId, principalId)` and refusing ambiguous matches.
 */
export function deletePersonalMemoriesFromTurnSync(
  sql: SqlStorageLike,
  params: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly input: PersonalMemoryDeleteTurnCommand;
  },
): TurnPersonalMemoryDeleteOutcome {
  const parsed = personalMemoryDeleteTurnCommandSchema.parse(params.input);
  const deletedIds = new Set<string>();
  const deletedContents: string[] = [];
  let notFoundCount = 0;
  let ambiguousCount = 0;

  for (const target of parsed.targets) {
    const match = findMemoryForDeleteTargetSync(sql, params.tenantId, params.principalId, target);
    if (match.status === 'ambiguous') {
      ambiguousCount += 1;
      continue;
    }
    if (match.status === 'not_found') {
      notFoundCount += 1;
      continue;
    }
    if (deletedIds.has(match.row.id)) {
      continue;
    }
    sql.exec(
      `DELETE FROM personal_memories
        WHERE id = ?
          AND tenant_id = ?
          AND principal_id = ?`,
      match.row.id,
      params.tenantId,
      params.principalId,
    );
    deletedIds.add(match.row.id);
    deletedContents.push(match.row.content);
  }

  return {
    deletedCount: deletedIds.size,
    deletedContents,
    notFoundCount,
    ambiguousCount,
  };
}

/**
 * Resolve the user-visible assistant confirmation for a turn that invoked a personal memory tool.
 * Preserves natural language-matched model confirmations on committed success, replaces empty/generic
 * placeholders with concise language-matched details, and enforces honest failure messages.
 */
export function formatTurnMemoryConfirmationReply(params: {
  readonly modelText: string;
  readonly sourceUserText: string;
  readonly saveOutcome?: TurnPersonalMemorySaveOutcome | 'unavailable';
  readonly deleteOutcome?: TurnPersonalMemoryDeleteOutcome | 'unavailable';
}): string {
  const trimmedModelText = params.modelText.trim();
  const isZh = hasChineseText(params.sourceUserText);
  const hasRealModelReply =
    trimmedModelText.length > 0 && !PLACEHOLDER_MEMORY_ACKS.has(trimmedModelText);

  const saveOutcome = params.saveOutcome;
  if (saveOutcome !== undefined) {
    if (saveOutcome === 'unavailable') {
      return isZh
        ? '目前无法保存该记忆，请稍后在“记忆”设置中添加。'
        : PERSONAL_MEMORY_SAVE_UNAVAILABLE_REPLY;
    }
    if (saveOutcome.outcome === 'budget_exceeded') {
      return isZh
        ? `无法保存该记忆：已达到 ${PERSONAL_MEMORY_MAX_ITEMS} 条个人记忆上限。请在“记忆”设置中删除旧条目后再试。`
        : PERSONAL_MEMORY_LIMIT_EXCEEDED_REPLY;
    }
    if (saveOutcome.outcome === 'not_found') {
      return isZh
        ? '未在个人记忆中找到要更新的条目，没有修改任何内容。请在“记忆”设置中查看后重试。'
        : "I couldn't find that memory item to update, so nothing was changed. Please check Memory settings and try again.";
    }
    if (saveOutcome.outcome === 'ambiguous') {
      return isZh
        ? '找到多条相似的个人记忆，无法确定要更新哪一条。请更具体地说明，或在“记忆”设置中手动编辑。'
        : 'Multiple saved memories matched that reference, so nothing was updated. Please be more specific or edit the item in Memory settings.';
    }
    if (hasRealModelReply) {
      return trimmedModelText;
    }
    if (isZh) {
      return saveOutcome.created
        ? `已记住：${saveOutcome.content}`
        : `已更新记忆：${saveOutcome.content}`;
    }
    return saveOutcome.created
      ? `Saved to your personal memory: ${saveOutcome.content}`
      : `Updated your personal memory: ${saveOutcome.content}`;
  }

  const deleteOutcome = params.deleteOutcome;
  if (deleteOutcome !== undefined) {
    if (deleteOutcome === 'unavailable') {
      return isZh
        ? '目前无法删除该记忆，请稍后在“记忆”设置中删除。'
        : PERSONAL_MEMORY_DELETE_UNAVAILABLE_REPLY;
    }
    if (deleteOutcome.deletedCount === 0) {
      if (deleteOutcome.ambiguousCount > 0) {
        return isZh
          ? '找到多条相似的记忆，无法确定要删除哪一条。请更具体地说明，或在“记忆”设置中手动删除。'
          : 'Multiple saved memories matched that request, so nothing was deleted. Please be more specific or remove the item in Memory settings.';
      }
      return isZh
        ? '未在个人记忆中找到匹配的条目，没有删除任何内容。你可以在“记忆”设置中查看并删除。'
        : "I couldn't find a matching item in your personal memory, so nothing was deleted. You can inspect and remove items in Memory settings.";
    }
    const hasPartialFailure = deleteOutcome.ambiguousCount > 0 || deleteOutcome.notFoundCount > 0;
    if (hasPartialFailure) {
      if (isZh) {
        const suffix =
          deleteOutcome.ambiguousCount > 0
            ? '；另有部分条目存在多个相似匹配，未自动删除，请在“记忆”设置中确认。'
            : '；其余未在个人记忆中找到匹配条目。';
        return `已从个人记忆中移除：${deleteOutcome.deletedContents.join('；')}${suffix}`;
      }
      const suffix =
        deleteOutcome.ambiguousCount > 0
          ? '; other requested items matched multiple saved memories and were left untouched—please confirm in Memory settings.'
          : '; other requested items were not found in your personal memory.';
      return `Removed from your personal memory: ${deleteOutcome.deletedContents.join('; ')}${suffix}`;
    }
    if (hasRealModelReply) {
      return trimmedModelText;
    }
    if (isZh) {
      return `已从个人记忆中移除：${deleteOutcome.deletedContents.join('；')}`;
    }
    return `Removed from your personal memory: ${deleteOutcome.deletedContents.join('; ')}`;
  }

  return trimmedModelText;
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
      } else {
        const existingByContent = sqlExecMaybe<PersonalMemoryRow>(
          this.sql,
          `SELECT *
             FROM personal_memories
            WHERE tenant_id = ?
              AND principal_id = ?
              AND kind = ?
              AND content = ?
            ORDER BY updated_at_ms DESC, id ASC
            LIMIT 1`,
          cmd.tenantId,
          cmd.principalId,
          input.kind,
          input.content,
        );
        if (existingByContent !== null) {
          const nextClientRequestId = existingByContent.client_request_id ?? clientRequestId;
          this.sql.exec(
            `UPDATE personal_memories
                SET client_request_id = ?,
                    updated_at_ms = ?
              WHERE id = ?
                AND tenant_id = ?
                AND principal_id = ?`,
            nextClientRequestId,
            nowMs,
            existingByContent.id,
            cmd.tenantId,
            cmd.principalId,
          );
          const updated: PersonalMemoryRow = {
            ...existingByContent,
            client_request_id: nextClientRequestId,
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
