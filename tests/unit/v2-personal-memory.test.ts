import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CONVERSATION_SYSTEM_PROMPT,
  FakeModelGateway,
  MODEL_LIMITS,
  MODEL_RATE_ROWS,
  OpenAiModelGateway,
  OpenRouterModelGateway,
  PERSONAL_MEMORY_CONTEXT_HEADER,
  buildBoundedPersonalMemoryContext,
  preflightConversationTurn,
  type FetchLike,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
} from '@ember/model-gateway';
import { buildConversationTurnMessages } from '../../packages/model-gateway/src/providers/shared.js';
import {
  AgentHeadMemoryService,
  PERSONAL_MEMORY_MAX_ITEMS,
  applyAgentHeadMigrations,
  createDefaultAgentHeadMigrations,
  parseClaimExecutionContext,
  readPersonalMemoriesForTurnSync,
  type DurableObjectStorageLike,
  type SqlStorageCursorLike,
  type SqlStorageRow,
} from '@ember/runtime-v2';
import { describe, expect, it } from 'vitest';

function createInMemoryDoStorage(): {
  readonly db: DatabaseSync;
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
} {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  const sql = {
    exec<T extends SqlStorageRow = SqlStorageRow>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      const stmt = db.prepare(query);
      const isRead = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
      const rows = isRead
        ? (stmt.all(...(bindings as never[])) as unknown as T[])
        : (stmt.run(...(bindings as never[])), [] as T[]);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`Expected 1 row, got ${rows.length}`);
          }
          return rows[0]!;
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
        rowsRead: isRead ? rows.length : 0,
        rowsWritten: isRead ? 0 : 1,
      };
    },
  };

  let inTx = false;
  const storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'> = {
    sql,
    transactionSync<T>(closure: () => T): T {
      if (inTx) {
        return closure();
      }
      inTx = true;
      db.exec('BEGIN IMMEDIATE;');
      try {
        const result = closure();
        db.exec('COMMIT;');
        return result;
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      } finally {
        inTx = false;
      }
    },
  };

  return { db, storage };
}

function bootstrapHead(
  storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>,
  tenantId: string,
  agentId: string,
) {
  applyAgentHeadMigrations(storage, createDefaultAgentHeadMigrations(), 1_700_000_000_000);
  storage.sql.exec(
    `INSERT INTO agent_head_meta (id, tenant_id, agent_id, policy_version, home_region, created_at_ms, updated_at_ms)
     VALUES (1, ?, ?, 1, 'local', 1700000000000, 1700000000000)`,
    tenantId,
    agentId,
  );
}

describe('Personal Memory — model-gateway bounded context & preflight', () => {
  it('formats bounded personal memories cleanly, strips newlines, and enforces caps', () => {
    const bounded = buildBoundedPersonalMemoryContext([
      { kind: 'preference', key: 'reply_style', content: 'Always use\nbullet\tpoints' },
      { kind: 'fact', content: 'Based in Tokyo' },
    ]);

    expect(bounded.droppedItems).toBe(0);
    expect(bounded.items).toEqual([
      { kind: 'preference', key: 'reply_style', content: 'Always use bullet points' },
      { kind: 'fact', content: 'Based in Tokyo' },
    ]);
    expect(bounded.text).toContain(PERSONAL_MEMORY_CONTEXT_HEADER);
    expect(bounded.text).toContain('- [preference:reply_style] Always use bullet points');
    expect(bounded.text).toContain('- [fact] Based in Tokyo');
    expect(bounded.characters).toBe(bounded.text.length);

    // Enforce maxPersonalMemoryChars without mid-item truncation
    const manyItems = Array.from({ length: 30 }, (_, i) => ({
      kind: 'preference' as const,
      key: `pref_${i}`,
      content: 'x'.repeat(250),
    }));
    const capped = buildBoundedPersonalMemoryContext(manyItems);
    expect(capped.characters).toBeLessThanOrEqual(MODEL_LIMITS.maxPersonalMemoryChars);
    expect(capped.items.length).toBeLessThan(manyItems.length);
    expect(capped.droppedItems).toBe(manyItems.length - capped.items.length);
  });

  it('keeps the fixed system prompt untouched and injects personal memories as a user-role context message', () => {
    const messagesWithout = buildConversationTurnMessages({
      conversationId: randomUUID(),
      turnId: randomUUID(),
      context: [{ role: 'user', text: 'Plan my day' }],
      maxOutputTokens: 256,
    });
    expect(messagesWithout).toEqual([
      { role: 'system', content: CONVERSATION_SYSTEM_PROMPT },
      { role: 'user', content: 'Plan my day' },
    ]);

    const personalMemories = [
      { kind: 'preference' as const, key: 'response_style', content: 'Be concise and use bullets' },
    ];
    const messagesWith = buildConversationTurnMessages({
      conversationId: randomUUID(),
      turnId: randomUUID(),
      context: [{ role: 'user', text: 'Plan my day' }],
      personalMemories,
      maxOutputTokens: 256,
    });
    expect(messagesWith).toHaveLength(3);
    expect(messagesWith[0]).toEqual({ role: 'system', content: CONVERSATION_SYSTEM_PROMPT });
    expect(messagesWith[1]?.role).toBe('user');
    expect(messagesWith[1]?.content).toContain(PERSONAL_MEMORY_CONTEXT_HEADER);
    expect(messagesWith[1]?.content).toContain('Be concise and use bullets');
    expect(messagesWith[2]).toEqual({ role: 'user', content: 'Plan my day' });

    const basePreflight = preflightConversationTurn({
      messages: [{ role: 'user', text: 'Plan my day' }],
      maxOutputTokens: 256,
    });
    const memoryPreflight = preflightConversationTurn({
      messages: [{ role: 'user', text: 'Plan my day' }],
      personalMemories,
      maxOutputTokens: 256,
    });
    expect(memoryPreflight.inputChars).toBeGreaterThan(basePreflight.inputChars);
    expect(memoryPreflight.inputTokens).toBeGreaterThan(basePreflight.inputTokens);
  });

  it('serializes personalMemories as a leading user context message on OpenAI, OpenRouter, and Fake gateways without mutating system role', async () => {
    const capturedBodies: Array<{
      readonly messages: readonly { role: string; content: string }[];
    }> = [];
    const stubFetch: FetchLike = (_url, init) => {
      const parsedBody = JSON.parse(String(init.body)) as {
        readonly model: string;
        readonly messages: readonly { role: string; content: string }[];
      };
      capturedBodies.push(parsedBody);
      const payload = {
        model: parsedBody.model,
        choices: [
          {
            message: { role: 'assistant', content: '- Item 1\n- Item 2' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 42, completion_tokens: 12 },
      };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
        text: () => Promise.resolve(JSON.stringify(payload)),
      });
    };

    const openaiRate: ModelRateRow = Object.freeze({
      providerId: 'openai' as const,
      modelId: 'gpt-5.6-luna',
      inputMicroUsdPerMillion: 200_000,
      outputMicroUsdPerMillion: 1_200_000,
      rateVersion: 'test-personal-memory-rate-v1',
      provenance: 'official_price_verified' as const,
      source: 'test fixture',
    });
    const openrouterRate = MODEL_RATE_ROWS.find((row) => row.providerId === 'openrouter')!;
    const openrouterRouting: OpenRouterRoutingPolicy = Object.freeze({
      only: Object.freeze(['deepinfra']),
      allowFallbacks: false,
      dataCollection: 'deny',
      zdr: true,
      requireParameters: true,
    });

    const openai = new OpenAiModelGateway({
      apiKey: 'sk-test-abcdefghijklmnopqrstuvwxyz012345',
      modelId: openaiRate.modelId,
      rate: openaiRate,
      isAuthorized: () => true,
      fetchImpl: stubFetch,
    });
    const openrouter = new OpenRouterModelGateway({
      apiKey: 'sk-or-v1-test-abcdefghijklmnopqrstuvwxyz012345',
      modelId: openrouterRate.modelId,
      rate: openrouterRate,
      routing: openrouterRouting,
      isAuthorized: () => true,
      fetchImpl: stubFetch,
    });

    const personalMemories = [
      { kind: 'preference' as const, key: 'response_style', content: 'Always use bullet points' },
    ];
    const baseInput = {
      conversationId: randomUUID(),
      turnId: randomUUID(),
      context: [{ role: 'user' as const, text: 'Summarize my day' }],
      maxOutputTokens: 256,
    };

    const controller = new AbortController();
    await openai.generateConversationTurn({ ...baseInput, personalMemories }, controller.signal);
    await openrouter.generateConversationTurn(
      { ...baseInput, personalMemories },
      controller.signal,
    );
    await openai.generateConversationTurn(baseInput, controller.signal);

    expect(capturedBodies).toHaveLength(3);
    for (const wire of [capturedBodies[0]!, capturedBodies[1]!]) {
      expect(wire.messages).toHaveLength(3);
      expect(wire.messages[0]).toEqual({ role: 'system', content: CONVERSATION_SYSTEM_PROMPT });
      expect(wire.messages[1]?.role).toBe('user');
      expect(wire.messages[1]?.content).toContain(PERSONAL_MEMORY_CONTEXT_HEADER);
      expect(wire.messages[1]?.content).toContain('Always use bullet points');
      expect(wire.messages[2]).toEqual({ role: 'user', content: 'Summarize my day' });
    }
    expect(capturedBodies[2]?.messages).toEqual([
      { role: 'system', content: CONVERSATION_SYSTEM_PROMPT },
      { role: 'user', content: 'Summarize my day' },
    ]);

    const fake = new FakeModelGateway();
    const fakeWithout = await fake.generateConversationTurn(baseInput, controller.signal);
    const fakeWith = await fake.generateConversationTurn(
      { ...baseInput, personalMemories },
      controller.signal,
    );
    expect(fakeWith.usage!.inputTokens).toBeGreaterThan(fakeWithout.usage!.inputTokens);
  });
});

describe('Personal Memory — AgentHeadMemoryService & v6 migration', () => {
  it('saves, updates by key, verifies provenance ownership, deletes, and isolates principals', async () => {
    const { storage } = createInMemoryDoStorage();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const principalA = randomUUID();
    const principalB = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    bootstrapHead(storage, tenantId, agentId);
    storage.sql.exec(
      `INSERT INTO conversations (id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms)
       VALUES (?, 'main', 1, 0, 1700000000000, 1700000000000)`,
      conversationId,
    );
    storage.sql.exec(
      `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
       VALUES (?, ?, 1, 'user', 'Please remember my response style', ?, 1700000000000)`,
      messageId,
      conversationId,
      randomUUID(),
    );

    let now = 1_700_000_001_000;
    const service = new AgentHeadMemoryService({
      storage,
      nowMs: () => now,
      newId: () => randomUUID(),
    });

    const created = await service.execute({
      kind: 'save',
      tenantId,
      principalId: principalA,
      agentId,
      requestId: randomUUID(),
      input: {
        kind: 'preference',
        key: 'Response_Style',
        content: 'Prefer concise bullet points',
        provenance: {
          source: 'explicit_user_request',
          conversation_id: conversationId,
          message_id: messageId,
        },
      },
    });
    expect('created' in created && created.created).toBe(true);
    if (!('item' in created)) throw new Error('expected save result');
    expect(created.item.key).toBe('response_style');
    expect(created.item.provenance).toEqual({
      source: 'explicit_user_request',
      conversation_id: conversationId,
      message_id: messageId,
    });

    // Upsert by same normalized key updates in place
    now += 5_000;
    const updated = await service.execute({
      kind: 'save',
      tenantId,
      principalId: principalA,
      agentId,
      requestId: randomUUID(),
      input: {
        kind: 'preference',
        key: 'response_style',
        content: 'Prefer numbered lists',
        provenance: { source: 'user_settings' },
      },
    });
    expect('created' in updated && updated.created).toBe(false);
    if (!('item' in updated)) throw new Error('expected save result');
    expect(updated.item.memory_id).toBe(created.item.memory_id);
    expect(updated.item.content).toBe('Prefer numbered lists');
    expect(updated.item.provenance).toEqual({
      source: 'user_settings',
      conversation_id: null,
      message_id: null,
    });

    // Principal B cannot see or delete Principal A's memory
    const listB = await service.execute({
      kind: 'list',
      tenantId,
      principalId: principalB,
      agentId,
      requestId: randomUUID(),
    });
    expect('items' in listB && listB.items).toEqual([]);
    expect(readPersonalMemoriesForTurnSync(storage.sql, tenantId, principalB)).toEqual([]);

    await expect(
      service.execute({
        kind: 'delete',
        tenantId,
        principalId: principalB,
        agentId,
        requestId: randomUUID(),
        memoryId: created.item.memory_id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Principal A retrieves it for turn context
    expect(readPersonalMemoriesForTurnSync(storage.sql, tenantId, principalA)).toEqual([
      { kind: 'preference', key: 'response_style', content: 'Prefer numbered lists' },
    ]);

    // Principal A deletes it
    const deleted = await service.execute({
      kind: 'delete',
      tenantId,
      principalId: principalA,
      agentId,
      requestId: randomUUID(),
      memoryId: created.item.memory_id,
    });
    expect(deleted).toEqual({ deleted: true, memory_id: created.item.memory_id });
    expect(readPersonalMemoriesForTurnSync(storage.sql, tenantId, principalA)).toEqual([]);
  });

  it('enforces PERSONAL_MEMORY_MAX_ITEMS per principal', async () => {
    const { storage } = createInMemoryDoStorage();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const principalId = randomUUID();
    bootstrapHead(storage, tenantId, agentId);

    const service = new AgentHeadMemoryService({
      storage,
      nowMs: () => 1_700_000_000_000,
      newId: () => randomUUID(),
    });

    for (let i = 0; i < PERSONAL_MEMORY_MAX_ITEMS; i += 1) {
      await service.execute({
        kind: 'save',
        tenantId,
        principalId,
        agentId,
        requestId: randomUUID(),
        input: {
          kind: 'fact',
          content: `Fact #${i}`,
          provenance: { source: 'explicit_user_request' },
        },
      });
    }

    await expect(
      service.execute({
        kind: 'save',
        tenantId,
        principalId,
        agentId,
        requestId: randomUUID(),
        input: {
          kind: 'fact',
          content: 'Overflow fact',
          provenance: { source: 'explicit_user_request' },
        },
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('guarantees idempotency on Unknown ACK retries via client_request_id and rejects conflicting reuse', async () => {
    const { storage } = createInMemoryDoStorage();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const principalId = randomUUID();
    bootstrapHead(storage, tenantId, agentId);

    let now = 1_700_000_010_000;
    const service = new AgentHeadMemoryService({
      storage,
      nowMs: () => now,
      newId: () => randomUUID(),
    });

    const clientRequestId = randomUUID();
    const first = await service.execute({
      kind: 'save',
      tenantId,
      principalId,
      agentId,
      requestId: randomUUID(),
      input: {
        kind: 'fact',
        content: 'Prefers metric units',
        client_request_id: clientRequestId,
        provenance: { source: 'explicit_user_request' },
      },
    });
    expect('created' in first && first.created).toBe(true);
    if (!('item' in first)) throw new Error('expected save result');

    // Fill up to PERSONAL_MEMORY_MAX_ITEMS to verify replay still succeeds at cap
    for (let i = 1; i < PERSONAL_MEMORY_MAX_ITEMS; i += 1) {
      await service.execute({
        kind: 'save',
        tenantId,
        principalId,
        agentId,
        requestId: randomUUID(),
        input: {
          kind: 'fact',
          content: `Filler #${i}`,
          provenance: { source: 'explicit_user_request' },
        },
      });
    }

    now += 5_000;
    const replay = await service.execute({
      kind: 'save',
      tenantId,
      principalId,
      agentId,
      requestId: randomUUID(),
      input: {
        kind: 'fact',
        content: 'Prefers metric units',
        client_request_id: clientRequestId,
        provenance: { source: 'explicit_user_request' },
      },
    });
    expect('created' in replay && replay.created).toBe(false);
    if (!('item' in replay)) throw new Error('expected save result');
    expect(replay.item).toEqual(first.item);

    await expect(
      service.execute({
        kind: 'save',
        tenantId,
        principalId,
        agentId,
        requestId: randomUUID(),
        input: {
          kind: 'fact',
          content: 'Different content with same client_request_id',
          client_request_id: clientRequestId,
          provenance: { source: 'explicit_user_request' },
        },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects unverified provenance conversation_id and message_id references', async () => {
    const { storage } = createInMemoryDoStorage();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const principalId = randomUUID();
    const conversationId = randomUUID();
    bootstrapHead(storage, tenantId, agentId);
    storage.sql.exec(
      `INSERT INTO conversations (id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms)
       VALUES (?, 'main', 0, 0, 1700000000000, 1700000000000)`,
      conversationId,
    );

    const service = new AgentHeadMemoryService({
      storage,
      nowMs: () => 1_700_000_000_000,
      newId: () => randomUUID(),
    });

    await expect(
      service.execute({
        kind: 'save',
        tenantId,
        principalId,
        agentId,
        requestId: randomUUID(),
        input: {
          kind: 'fact',
          content: 'Unknown conversation',
          provenance: {
            source: 'explicit_user_request',
            conversation_id: randomUUID(),
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await expect(
      service.execute({
        kind: 'save',
        tenantId,
        principalId,
        agentId,
        requestId: randomUUID(),
        input: {
          kind: 'fact',
          content: 'Message without conversation',
          provenance: {
            source: 'explicit_user_request',
            message_id: randomUUID(),
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await expect(
      service.execute({
        kind: 'save',
        tenantId,
        principalId,
        agentId,
        requestId: randomUUID(),
        input: {
          kind: 'fact',
          content: 'Message not in conversation',
          provenance: {
            source: 'explicit_user_request',
            conversation_id: conversationId,
            message_id: randomUUID(),
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('parses optional personalMemories in durable claim context', () => {
    const turnId = randomUUID();
    const parsed = parseClaimExecutionContext({
      targetKind: 'turn',
      targetId: turnId,
      leaseEpoch: 1,
      contextJson: JSON.stringify({
        entityKind: 'turn',
        entityId: turnId,
        operationId: randomUUID(),
        attemptNo: 1,
        sendStartedAtMs: null,
        sendAuthorizingAtMs: null,
        sendState: 'unsent',
        deadlineAtMs: 1_700_000_060_000,
        providerJobHandle: null,
        context: [{ sequence: 1, kind: 'user', text: 'hi' }],
        personalMemories: [{ kind: 'preference', key: 'lang', content: 'Reply in English' }],
      }),
    });

    expect(parsed.personalMemories).toEqual([
      { kind: 'preference', key: 'lang', content: 'Reply in English' },
    ]);
  });

  it('updates an existing memory in place by memoryId, preserves provenance, and rejects conflicts or cross-principal edits', async () => {
    const { storage } = createInMemoryDoStorage();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const principalA = randomUUID();
    const principalB = randomUUID();
    bootstrapHead(storage, tenantId, agentId);

    let now = 1_700_000_020_000;
    const service = new AgentHeadMemoryService({
      storage,
      nowMs: () => now,
      newId: () => randomUUID(),
    });

    const first = await service.execute({
      kind: 'save',
      tenantId,
      principalId: principalA,
      agentId,
      requestId: randomUUID(),
      input: {
        kind: 'fact',
        content: 'Based in Tokyo',
        provenance: { source: 'user_settings' },
      },
    });
    if (!('item' in first)) throw new Error('expected save result');

    const second = await service.execute({
      kind: 'save',
      tenantId,
      principalId: principalA,
      agentId,
      requestId: randomUUID(),
      input: {
        kind: 'preference',
        key: 'tone',
        content: 'Direct and concise',
        provenance: { source: 'user_settings' },
      },
    });
    if (!('item' in second)) throw new Error('expected save result');

    now += 10_000;
    const patched = await service.execute({
      kind: 'update',
      tenantId,
      principalId: principalA,
      agentId,
      requestId: randomUUID(),
      memoryId: first.item.memory_id,
      input: {
        content: 'Based in Osaka',
        key: 'Home_City',
      },
    });
    if (!('item' in patched)) throw new Error('expected update result');
    expect(patched.item.memory_id).toBe(first.item.memory_id);
    expect(patched.item.content).toBe('Based in Osaka');
    expect(patched.item.key).toBe('home_city');
    expect(patched.item.created_at).toBe(first.item.created_at);
    expect(patched.item.updated_at).not.toBe(first.item.updated_at);
    expect(patched.item.provenance).toEqual(first.item.provenance);

    // Clearing key with null works
    now += 5_000;
    const clearedKey = await service.execute({
      kind: 'update',
      tenantId,
      principalId: principalA,
      agentId,
      requestId: randomUUID(),
      memoryId: first.item.memory_id,
      input: { key: null },
    });
    if (!('item' in clearedKey)) throw new Error('expected update result');
    expect(clearedKey.item.key).toBeNull();

    // Key collision with another memory returns IDEMPOTENCY_CONFLICT
    await expect(
      service.execute({
        kind: 'update',
        tenantId,
        principalId: principalA,
        agentId,
        requestId: randomUUID(),
        memoryId: first.item.memory_id,
        input: { key: 'tone' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // Empty patch rejected
    await expect(
      service.execute({
        kind: 'update',
        tenantId,
        principalId: principalA,
        agentId,
        requestId: randomUUID(),
        memoryId: first.item.memory_id,
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // Cross-principal edit returns NOT_FOUND
    await expect(
      service.execute({
        kind: 'update',
        tenantId,
        principalId: principalB,
        agentId,
        requestId: randomUUID(),
        memoryId: first.item.memory_id,
        input: { content: 'Hijacked' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
