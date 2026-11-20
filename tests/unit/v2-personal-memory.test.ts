import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CONVERSATION_SYSTEM_PROMPT,
  CONVERSATION_TOOLS_WITH_MEMORY,
  DEFAULT_MEMORY_SAVE_ACK_TEXT,
  DELEGATION_TOOLS,
  FakeModelGateway,
  MODEL_LIMITS,
  MODEL_RATE_ROWS,
  ModelGatewayFailure,
  OpenAiModelGateway,
  OpenRouterModelGateway,
  PERSONAL_MEMORY_CONTEXT_HEADER,
  PERSONAL_MEMORY_SAVE_SYSTEM_INSTRUCTION,
  SAVE_PERSONAL_MEMORY_TOOL_NAME,
  buildBoundedPersonalMemoryContext,
  preflightConversationTurn,
  type FetchLike,
  type ModelRateRow,
  type OpenRouterRoutingPolicy,
} from '@ember/model-gateway';
import {
  buildConversationTurnMessages,
  parseConversationTurnChoice,
} from '../../packages/model-gateway/src/providers/shared.js';
import {
  AgentHeadMemoryService,
  PERSONAL_MEMORY_LIMIT_EXCEEDED_REPLY,
  PERSONAL_MEMORY_MAX_ITEMS,
  PERSONAL_MEMORY_SAVED_REPLY,
  applyAgentHeadMigrations,
  createDefaultAgentHeadMigrations,
  parseClaimExecutionContext,
  readPersonalMemoriesForTurnSync,
  savePersonalMemoryFromTurnSync,
  toAgentHeadDurableCommitOutcome,
  type DurableObjectStorageLike,
  type SqlStorageCursorLike,
  type SqlStorageRow,
} from '@ember/runtime-v2';
import { executeAuthoritativeTurnCommit } from '../../packages/runtime-v2/src/agent-head/turn-commit.js';
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

  it('gates save_personal_memory behind enablePersonalMemorySaveTool on providers and rejects disabled or invalid tool calls', async () => {
    expect(DELEGATION_TOOLS.map((tool) => tool.function.name)).toEqual([
      'delegate_notes_action_items',
      'delegate_python_agent',
    ]);
    const toolSchema = CONVERSATION_TOOLS_WITH_MEMORY.find(
      (tool) => tool.function.name === SAVE_PERSONAL_MEMORY_TOOL_NAME,
    );
    expect(toolSchema).toBeDefined();
    expect(toolSchema?.function.parameters.additionalProperties).toBe(false);

    const toolChoice = {
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_mem_1',
            type: 'function',
            function: {
              name: SAVE_PERSONAL_MEMORY_TOOL_NAME,
              arguments: JSON.stringify({
                kind: 'preference',
                content: '  Always reply in concise bullet points  ',
                key: 'Response_Style',
              }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    };

    // Disabled by default (V1 / scheduled briefs / tasks) -> rejected fail-closed
    expect(() => parseConversationTurnChoice(toolChoice)).toThrow(ModelGatewayFailure);

    // Enabled explicitly (V2 user-initiated conversation turn) -> parsed cleanly
    const parsed = parseConversationTurnChoice(toolChoice, { allowSavePersonalMemory: true });
    expect(parsed).toEqual({
      kind: 'save_memory',
      toolName: SAVE_PERSONAL_MEMORY_TOOL_NAME,
      text: DEFAULT_MEMORY_SAVE_ACK_TEXT,
      finishReason: 'stop',
      memory: {
        toolName: SAVE_PERSONAL_MEMORY_TOOL_NAME,
        arguments: {
          kind: 'preference',
          content: 'Always reply in concise bullet points',
          key: 'response_style',
        },
      },
    });

    // Provider wire regression: default omits tool & instruction; V2-enabled advertises both
    const capturedRequests: Array<{
      readonly messages: readonly { role: string; content: string }[];
      readonly tools: readonly { function: { name: string } }[];
    }> = [];
    const stubFetch: FetchLike = (_url, init) => {
      const req = JSON.parse(String(init.body)) as {
        readonly model: string;
        readonly messages: readonly { role: string; content: string }[];
        readonly tools: readonly { function: { name: string } }[];
      };
      capturedRequests.push({ messages: req.messages, tools: req.tools });
      const payload = {
        model: req.model,
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_mem_wire',
                  type: 'function',
                  function: {
                    name: SAVE_PERSONAL_MEMORY_TOOL_NAME,
                    arguments: JSON.stringify({ kind: 'fact', content: 'Based in Kyoto' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 15 },
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
      rateVersion: 'test-personal-memory-gate-v1',
      provenance: 'official_price_verified' as const,
      source: 'test fixture',
    });
    const openai = new OpenAiModelGateway({
      apiKey: 'sk-test-abcdefghijklmnopqrstuvwxyz012345',
      modelId: openaiRate.modelId,
      rate: openaiRate,
      isAuthorized: () => true,
      fetchImpl: stubFetch,
    });
    const controller = new AbortController();
    const baseInput = {
      conversationId: randomUUID(),
      turnId: randomUUID(),
      context: [{ role: 'user' as const, text: 'Remember I live in Kyoto' }],
      maxOutputTokens: 256,
    };

    // Default (V1 / task) does NOT advertise save_personal_memory and rejects if model emits it
    await expect(openai.generateConversationTurn(baseInput, controller.signal)).rejects.toThrow(
      ModelGatewayFailure,
    );
    expect(capturedRequests[0]?.tools.map((t) => t.function.name)).toEqual([
      'delegate_notes_action_items',
      'delegate_python_agent',
    ]);
    expect(capturedRequests[0]?.messages[0]?.content).toBe(CONVERSATION_SYSTEM_PROMPT);

    // V2 user-initiated conversation enables it and scopes instruction to latest user message
    const enabledRes = await openai.generateConversationTurn(
      { ...baseInput, enablePersonalMemorySaveTool: true },
      controller.signal,
    );
    expect(enabledRes.output.kind).toBe('save_memory');
    expect(capturedRequests[1]?.tools.map((t) => t.function.name)).toEqual([
      'delegate_notes_action_items',
      'delegate_python_agent',
      'save_personal_memory',
    ]);
    expect(capturedRequests[1]?.messages[0]?.content).toContain(
      PERSONAL_MEMORY_SAVE_SYSTEM_INSTRUCTION,
    );

    // Reject invalid key or unknown extra arguments even when enabled
    expect(() =>
      parseConversationTurnChoice(
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_mem_bad',
                type: 'function',
                function: {
                  name: SAVE_PERSONAL_MEMORY_TOOL_NAME,
                  arguments: JSON.stringify({
                    kind: 'preference',
                    content: 'Valid content',
                    extra_field: 'not_allowed',
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
        { allowSavePersonalMemory: true },
      ),
    ).toThrow(ModelGatewayFailure);

    // Reject plain-text impersonation of the canned acknowledgement without calling the tool
    expect(() =>
      parseConversationTurnChoice(
        {
          message: { content: DEFAULT_MEMORY_SAVE_ACK_TEXT },
          finish_reason: 'stop',
        },
        { allowSavePersonalMemory: true },
      ),
    ).toThrow(ModelGatewayFailure);
  });

  it('fails closed on invalid durable personalMemorySave payload in toAgentHeadDurableCommitOutcome', () => {
    const turnId = randomUUID();
    const operationId = randomUUID();
    const outcome = toAgentHeadDurableCommitOutcome({
      targetKind: 'turn',
      context: {
        entityKind: 'turn',
        entityId: turnId,
        attemptNo: 1,
        operationId,
        sendState: 'sent',
        sendAuthorizingAtMs: null,
        sendStartedAtMs: 1_700_000_000_000,
        deadlineAtMs: 1_700_000_060_000,
        providerJobHandle: null,
        interactiveHandoff: false,
      },
      outcome: {
        status: 'succeeded',
        operationId,
        providerJobHandle: null,
        outputJson: JSON.stringify({
          text: "Got it — I'll remember that.",
          personalMemorySave: { kind: 'invalid_kind', content: '' },
        }),
        errorCode: null,
        usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 100 },
      },
      modelLabel: 'ember-fake-model-gateway-1',
      simulated: true,
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      failureReason: 'internal_error',
    });
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

  it('persists savePersonalMemoryFromTurnSync idempotently with verified provenance and handles cap gracefully', async () => {
    const { storage } = createInMemoryDoStorage();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const principalId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const turnId = randomUUID();
    bootstrapHead(storage, tenantId, agentId);
    storage.sql.exec(
      `INSERT INTO conversations (id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms)
       VALUES (?, 'main', 1, 0, 1700000000000, 1700000000000)`,
      conversationId,
    );
    storage.sql.exec(
      `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
       VALUES (?, ?, 1, 'user', 'Remember I prefer dark roast coffee', ?, 1700000000000)`,
      messageId,
      conversationId,
      randomUUID(),
    );

    const first = savePersonalMemoryFromTurnSync(storage.sql, {
      tenantId,
      principalId,
      turnId,
      conversationId,
      sourceMessageId: messageId,
      input: { kind: 'preference', key: 'coffee', content: 'Prefers dark roast coffee' },
      nowMs: 1_700_000_030_000,
      newId: () => randomUUID(),
    });
    expect(first).toMatchObject({ outcome: 'saved', created: true });

    // Retrying the same turnId is strictly idempotent
    const replay = savePersonalMemoryFromTurnSync(storage.sql, {
      tenantId,
      principalId,
      turnId,
      conversationId,
      sourceMessageId: messageId,
      input: { kind: 'preference', key: 'coffee', content: 'Prefers dark roast coffee' },
      nowMs: 1_700_000_031_000,
      newId: () => randomUUID(),
    });
    expect(replay).toEqual({
      outcome: 'saved',
      memoryId: first.outcome === 'saved' ? first.memoryId : '',
      created: false,
    });

    const service = new AgentHeadMemoryService({
      storage,
      nowMs: () => 1_700_000_032_000,
      newId: () => randomUUID(),
    });
    const list = await service.execute({
      kind: 'list',
      tenantId,
      principalId,
      agentId,
      requestId: randomUUID(),
    });
    if (!('items' in list)) throw new Error('expected list');
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.provenance).toEqual({
      source: 'explicit_user_request',
      conversation_id: conversationId,
      message_id: messageId,
    });

    // Fill remaining slots to hit PERSONAL_MEMORY_MAX_ITEMS
    for (let i = 1; i < PERSONAL_MEMORY_MAX_ITEMS; i += 1) {
      savePersonalMemoryFromTurnSync(storage.sql, {
        tenantId,
        principalId,
        turnId: randomUUID(),
        conversationId,
        sourceMessageId: messageId,
        input: { kind: 'fact', content: `Turn fact #${i}` },
        nowMs: 1_700_000_040_000 + i,
        newId: () => randomUUID(),
      });
    }

    const overflow = savePersonalMemoryFromTurnSync(storage.sql, {
      tenantId,
      principalId,
      turnId: randomUUID(),
      conversationId,
      sourceMessageId: messageId,
      input: { kind: 'fact', content: 'Over the cap' },
      nowMs: 1_700_000_050_000,
      newId: () => randomUUID(),
    });
    expect(overflow).toEqual({ outcome: 'budget_exceeded' });
  });

  it('enforces effect boundary on executeAuthoritativeTurnCommit: no writes on stale fence/cancel, truthful reply on cap', async () => {
    const { storage } = createInMemoryDoStorage();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const principalId = randomUUID();
    const conversationId = randomUUID();
    const cancelledTurnId = randomUUID();
    const fencedTurnId = randomUUID();
    const capTurnId = randomUUID();
    const nowMs = 1_700_000_100_000;
    bootstrapHead(storage, tenantId, agentId);
    storage.sql.exec(
      `INSERT INTO conversations (id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms)
       VALUES (?, 'main', 0, 0, ?, ?)`,
      conversationId,
      nowMs,
      nowMs,
    );

    let nextSeq = 0;
    const seedTurnAndAttempt = (
      turnId: string,
      operationId: string,
      cancelRequestedAtMs: number | null,
    ) => {
      nextSeq += 1;
      const sourceMessageId = randomUUID();
      storage.sql.exec(
        `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
         VALUES (?, ?, ?, 'user', 'Remember this', ?, ?)`,
        sourceMessageId,
        conversationId,
        nextSeq,
        randomUUID(),
        nowMs,
      );
      storage.sql.exec(
        `UPDATE conversations SET last_sequence = ? WHERE id = ?`,
        nextSeq,
        conversationId,
      );
      storage.sql.exec(
        `INSERT INTO assistant_turns (
           id, conversation_id, source_message_id, response_message_id, status, failure_reason,
           execution_mode, deadline_at_ms, interactive_deadline_ms, lease_epoch, lease_owner,
           lease_expires_at_ms, claim_count, cancel_requested_at_ms, provider_job_handle,
           handoff_reason, linked_task_id, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, NULL, 'running', NULL, 'fast_interactive', ?, ?, 2, 'worker-1', ?, 1, ?, NULL, NULL, NULL, ?, ?)`,
        turnId,
        conversationId,
        sourceMessageId,
        nowMs + 60_000,
        nowMs + 30_000,
        nowMs + 30_000,
        cancelRequestedAtMs,
        nowMs,
        nowMs,
      );
      storage.sql.exec(
        `INSERT INTO model_attempts (
           subject_type, subject_id, attempt_no, operation_id, principal_id, utc_day,
           lease_epoch, provider_id, model_label, rate_version, budget_mode, state, outcome_code,
           reserved_micro_usd, observed_cost_micro_usd, input_tokens, output_tokens,
           global_grant_id, global_grant_expires_ms, send_started_at_ms, started_at_ms
         ) VALUES ('turn', ?, 1, ?, ?, '2026-11-20', 2, 'fake', 'ember-fake-model-gateway-1', 'fake-v2-m1', 'simulated_full_protocol', 'reserved', NULL, 250, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        turnId,
        operationId,
        principalId,
        nowMs,
        nowMs,
      );
      return sourceMessageId;
    };

    const makeCommitDeps = () => ({
      storage,
      recoveryAdmission: {
        ensureCoverageAsync: () => Promise.resolve({ covered: true, activeGeneration: 1 }),
        confirmCoverageSync: () => true,
        isCoverageValidAtSync: () => true,
      } as never,
      eventCoordinator: {
        enqueueDurableOutboxSync: () => undefined,
        cancelEntityOutboxSync: () => 0,
        recomputeAlarmSync: () => null,
      } as never,
      recoveryHooks: {
        syncAlarm: () => Promise.resolve(),
        relayBudgetSync: () => Promise.resolve(),
        getCoverageRowSync: () => ({
          id: 1 as const,
          active_generation: 1,
          actual_recovery_at_ms: nowMs + 120_000,
          dirty: 0 as const,
          updated_at_ms: nowMs,
        }),
      } as never,
      recoveryRegistry: {} as never,
      globalBudget: {} as never,
      earliestDiscovery: { earliestRequiredDiscoveryAtMsSync: () => null },
      nowMs: () => nowMs + 1_000,
      idFactory: () => randomUUID(),
    });

    // 1. Stale lease fence -> fenced, zero memory writes
    const fencedOp = randomUUID();
    seedTurnAndAttempt(fencedTurnId, fencedOp, null);
    const fencedRes = await executeAuthoritativeTurnCommit(makeCommitDeps(), {
      tenantId,
      agentId,
      turnId: fencedTurnId,
      leaseEpoch: 1, // stale epoch (current is 2)
      leaseOwner: 'worker-1',
      attemptNo: 1,
      operationId: fencedOp,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 120 },
      result: {
        status: 'completed',
        text: 'Stale ack',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        personalMemorySave: { kind: 'fact', content: 'Must not persist on stale fence' },
      },
      allowDeadlineTimeoutPublish: false,
      throwOnScopeMismatch: false,
    });
    expect(fencedRes.outcome).toBe('fenced');
    expect(readPersonalMemoriesForTurnSync(storage.sql, tenantId, principalId)).toEqual([]);

    // 2. Cancelled turn -> reconciled_only, zero memory writes
    const cancelOp = randomUUID();
    seedTurnAndAttempt(cancelledTurnId, cancelOp, nowMs + 500);
    const cancelRes = await executeAuthoritativeTurnCommit(makeCommitDeps(), {
      tenantId,
      agentId,
      turnId: cancelledTurnId,
      leaseEpoch: 2,
      leaseOwner: 'worker-1',
      attemptNo: 1,
      operationId: cancelOp,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 120 },
      result: {
        status: 'completed',
        text: 'Cancelled ack',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        personalMemorySave: { kind: 'fact', content: 'Must not persist on cancelled turn' },
      },
      allowDeadlineTimeoutPublish: false,
      throwOnScopeMismatch: false,
    });
    expect(cancelRes.outcome).toBe('reconciled_only');
    expect(readPersonalMemoriesForTurnSync(storage.sql, tenantId, principalId)).toEqual([]);

    // 3. Budget-limit (50-item cap) -> truthful limit-exceeded assistant message, zero extra rows
    const capOp = randomUUID();
    const capSourceMessageId = seedTurnAndAttempt(capTurnId, capOp, null);
    for (let i = 0; i < PERSONAL_MEMORY_MAX_ITEMS; i += 1) {
      savePersonalMemoryFromTurnSync(storage.sql, {
        tenantId,
        principalId,
        turnId: randomUUID(),
        conversationId,
        sourceMessageId: capSourceMessageId,
        input: { kind: 'fact', content: `Cap filler #${i}` },
        nowMs: nowMs + i,
        newId: () => randomUUID(),
      });
    }
    const capRes = await executeAuthoritativeTurnCommit(makeCommitDeps(), {
      tenantId,
      agentId,
      turnId: capTurnId,
      leaseEpoch: 2,
      leaseOwner: 'worker-1',
      attemptNo: 1,
      operationId: capOp,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 120 },
      result: {
        status: 'completed',
        text: 'Model optimistic ack',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
        personalMemorySave: { kind: 'fact', content: 'Over cap item' },
      },
      allowDeadlineTimeoutPublish: false,
      throwOnScopeMismatch: false,
    });
    expect(capRes.outcome).toBe('published');
    if (capRes.outcome !== 'published') throw new Error('expected published');
    const committedMsg = storage.sql
      .exec<{ readonly text: string }>(
        `SELECT text FROM conversation_messages WHERE id = ?`,
        capRes.responseMessageId,
      )
      .one();
    expect(committedMsg.text).toBe(PERSONAL_MEMORY_LIMIT_EXCEEDED_REPLY);
    expect(committedMsg.text).not.toBe(PERSONAL_MEMORY_SAVED_REPLY);
  });

  it('deduplicates unkeyed savePersonalMemoryFromTurnSync by exact trimmed content and kind, preserving key/client_request_id, keeping case-sensitive values distinct, and working at the 50-item cap', async () => {
    const { storage } = createInMemoryDoStorage();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const principalA = randomUUID();
    const principalB = randomUUID();
    const convA = randomUUID();
    const msgA1 = randomUUID();
    const msgA2 = randomUUID();
    const nowMs = 1_700_000_200_000;
    bootstrapHead(storage, tenantId, agentId);

    const svc = new AgentHeadMemoryService({
      storage,
      nowMs: () => nowMs,
      newId: () => randomUUID(),
    });

    // 1. Unkeyed POST /v2/memories (client_request_id = postReqId) -> matching chat turn B -> unknown-ACK retry of POST A
    const postReqId = randomUUID();
    const postSave = await svc.execute({
      kind: 'save',
      tenantId,
      agentId,
      principalId: principalA,
      requestId: randomUUID(),
      input: {
        kind: 'preference',
        content: 'Prefer concise bullet points',
        client_request_id: postReqId,
        provenance: { source: 'user_settings' },
      },
    });
    if (!('item' in postSave && 'created' in postSave)) throw new Error('expected save result');
    expect(postSave.created).toBe(true);
    const originalMemoryId = postSave.item.memory_id;

    // Fill up to the 50-item cap for principalA
    for (let i = 1; i < PERSONAL_MEMORY_MAX_ITEMS; i += 1) {
      const filler = savePersonalMemoryFromTurnSync(storage.sql, {
        tenantId,
        principalId: principalA,
        turnId: randomUUID(),
        conversationId: convA,
        sourceMessageId: msgA1,
        input: { kind: 'fact', content: `Filler item #${i}` },
        nowMs: nowMs + i,
        newId: () => randomUUID(),
      });
      expect(filler.outcome).toBe('saved');
    }

    // Exact repeat (after trim) from chat turn B updates in place even at 50/50, preserving content and client_request_id
    const deduped = savePersonalMemoryFromTurnSync(storage.sql, {
      tenantId,
      principalId: principalA,
      turnId: randomUUID(),
      conversationId: convA,
      sourceMessageId: msgA2,
      input: {
        kind: 'preference',
        content: '  Prefer concise bullet points  ',
      },
      nowMs: nowMs + 10_000,
      newId: () => randomUUID(),
    });
    expect(deduped).toEqual({
      outcome: 'saved',
      memoryId: originalMemoryId,
      created: false,
    });

    // Unknown-ACK retry of original unkeyed POST A must replay idempotently without creating a duplicate or hitting the cap
    const postRetry = await svc.execute({
      kind: 'save',
      tenantId,
      agentId,
      principalId: principalA,
      requestId: randomUUID(),
      input: {
        kind: 'preference',
        content: 'Prefer concise bullet points',
        client_request_id: postReqId,
        provenance: { source: 'user_settings' },
      },
    });
    if (!('item' in postRetry && 'created' in postRetry)) throw new Error('expected save result');
    expect(postRetry.created).toBe(false);
    expect(postRetry.item.memory_id).toBe(originalMemoryId);

    const listA = await svc.execute({
      kind: 'list',
      tenantId,
      agentId,
      principalId: principalA,
      requestId: randomUUID(),
    });
    if (!('items' in listA)) throw new Error('expected list response');
    expect(listA.items).toHaveLength(PERSONAL_MEMORY_MAX_ITEMS);
    const updatedItem = listA.items.find((item) => item.memory_id === originalMemoryId);
    expect(updatedItem?.content).toBe('Prefer concise bullet points');
    expect(updatedItem?.provenance.source).toBe('user_settings');
    expect(updatedItem?.provenance.message_id).toBeNull();
    expect(updatedItem?.updated_at).toBe(new Date(nowMs + 10_000).toISOString());

    // 2. Case-sensitive facts (e.g. paths/identifiers) must NOT be merged
    const pathUpper = savePersonalMemoryFromTurnSync(storage.sql, {
      tenantId,
      principalId: principalB,
      turnId: randomUUID(),
      conversationId: convA,
      sourceMessageId: msgA1,
      input: { kind: 'fact', content: 'Project path is /data/ABC' },
      nowMs: nowMs + 11_000,
      newId: () => randomUUID(),
    });
    const pathLower = savePersonalMemoryFromTurnSync(storage.sql, {
      tenantId,
      principalId: principalB,
      turnId: randomUUID(),
      conversationId: convA,
      sourceMessageId: msgA2,
      input: { kind: 'fact', content: 'Project path is /data/abc' },
      nowMs: nowMs + 12_000,
      newId: () => randomUUID(),
    });
    expect(pathUpper.outcome).toBe('saved');
    expect(pathLower.outcome).toBe('saved');
    if (pathUpper.outcome !== 'saved' || pathLower.outcome !== 'saved') {
      throw new Error('expected saved');
    }
    expect(pathUpper.created).toBe(true);
    expect(pathLower.created).toBe(true);
    expect(pathLower.memoryId).not.toBe(pathUpper.memoryId);

    // 3. Different kind ('preference' vs 'fact') with identical content is NOT merged
    const diffKind = savePersonalMemoryFromTurnSync(storage.sql, {
      tenantId,
      principalId: principalB,
      turnId: randomUUID(),
      conversationId: convA,
      sourceMessageId: msgA2,
      input: { kind: 'preference', content: 'Project path is /data/ABC' },
      nowMs: nowMs + 13_000,
      newId: () => randomUUID(),
    });
    expect(diffKind.outcome).toBe('saved');
    if (diffKind.outcome !== 'saved') throw new Error('expected saved');
    expect(diffKind.created).toBe(true);
    expect(diffKind.memoryId).not.toBe(pathUpper.memoryId);
  });
});
