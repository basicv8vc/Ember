import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  B1ConversationMessageSchema,
  B1ConversationPageSchema,
  V2ConversationWebEvidencePageSchema,
  WEB_EVIDENCE_LIMITS,
  WebEvidenceSchema,
  type WebEvidence,
} from '@ember/contracts';
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DeepSeekModelGateway,
  EXA_CONTENTS_URL,
  EXA_SEARCH_URL,
  ExaWebSearchClient,
  MODEL_RATE_ROWS,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OpenRouterModelGateway,
  WEB_EVIDENCE_COLLECTOR_LIMITS,
  WebEvidenceCollector,
  executeWebToolCallBatch,
  findRateRow,
  type ConversationTurnInput,
  type FetchLike,
  type ModelRateRow,
} from '@ember/model-gateway';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  applyAgentHeadMigrations,
  createDefaultAgentHeadMigrations,
  parseClaimExecutionContext,
  toAgentHeadDurableCommitOutcome,
  type DurableObjectStorageLike,
  type GlobalBudgetAuthority,
  type RecoveryRegistryPort,
  type SqlStorageCursorLike,
  type SqlStorageRow,
} from '@ember/runtime-v2';
import type { B1SessionRuntime } from '../../apps/api/src/auth/b1-auth-runtime.js';
import { generateSessionToken } from '../../apps/api/src/auth/session-token.js';
import { createLocalV2EdgeWorker } from '../../apps/api/src/local-v2/edge-worker.js';
import type { V2StreamingModelGateway } from '../../apps/api/src/local-v2/model-runtime.js';
import type { EdgeAgentHeadRpc, PrepareTurnRequest } from '../../apps/api/src/local-v2/rpc.js';

function createInMemoryDoStorage(): {
  readonly db: DatabaseSync;
  readonly storage: DurableObjectStorageLike;
} {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  let inTransaction = false;
  let currentAlarm: number | null = null;

  const storage: DurableObjectStorageLike = {
    sql: {
      exec<T extends SqlStorageRow = SqlStorageRow>(
        query: string,
        ...bindings: unknown[]
      ): SqlStorageCursorLike<T> {
        const stmt = db.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        const rows = isReader
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
          rowsRead: isReader ? rows.length : 0,
          rowsWritten: isReader ? 0 : 1,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      if (inTransaction) {
        return closure();
      }
      inTransaction = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const res = closure();
        db.exec('COMMIT');
        return res;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    getAlarm: () => Promise.resolve(currentAlarm),
    setAlarm: (ts) => {
      currentAlarm = typeof ts === 'number' ? ts : ts.getTime();
      return Promise.resolve();
    },
    deleteAlarm: () => {
      currentAlarm = null;
      return Promise.resolve();
    },
  };

  return { db, storage };
}

function createFakeRegistry(): RecoveryRegistryPort {
  let generation = 0;
  let recoveryAtMs: number | null = null;
  return {
    upsertCoverage: async (cmd) => {
      await Promise.resolve();
      generation = Math.max(generation, cmd.generation);
      recoveryAtMs = cmd.recoveryAtMs;
      return { accepted: true, currentGeneration: generation, actualRecoveryAtMs: recoveryAtMs };
    },
    postponeCoverage: async (cmd) => {
      await Promise.resolve();
      generation = cmd.newGeneration;
      recoveryAtMs = cmd.nextRecoveryAtMs;
      return { updated: true, currentGeneration: generation, actualRecoveryAtMs: recoveryAtMs };
    },
    retireCoverage: async () => {
      await Promise.resolve();
      recoveryAtMs = null;
      return { retired: true };
    },
    getCoverage: async () => {
      await Promise.resolve();
      return {
        exists: recoveryAtMs !== null,
        currentGeneration: generation,
        actualRecoveryAtMs: recoveryAtMs,
        status: recoveryAtMs === null ? null : 'armed',
        retryNotBeforeMs: null,
      };
    },
  };
}

function createFakeGlobalBudget(nowMs: () => number): GlobalBudgetAuthority {
  return {
    reserveGlobal: async () => {
      await Promise.resolve();
      return {
        kind: 'reserved',
        globalGrantId: randomUUID(),
        replayed: false,
      };
    },
    authorizeGlobalSend: async () => {
      await Promise.resolve();
      return {
        authorized: true,
        startBeforeMs: nowMs() + 60_000,
      };
    },
    renewGlobalGrant: async () => {
      await Promise.resolve();
      return {
        renewed: true,
        state: 'reserved',
      };
    },
    settleGlobal: async (req) => {
      await Promise.resolve();
      return {
        applied: true,
        alreadySettled: false,
        conflict: false,
        effectiveState: req.state,
        incidentOpened: false,
      };
    },
  };
}

function createHeadHarness() {
  const clockMs = Date.now();
  const nowMs = () => clockMs;
  const { db, storage } = createInMemoryDoStorage();
  const recoveryRegistry = createFakeRegistry();
  const globalBudget = createFakeGlobalBudget(nowMs);
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  let events!: AgentEventRuntimeFacade;

  const core = new AgentHeadCore({
    tenantId,
    agentId,
    storage,
    recoveryRegistry,
    globalBudget,
    nowMs,
    eventRuntimeFactory(business) {
      events = new AgentEventRuntimeFacade({ tenantId, agentId, storage, business });
      return {
        recoveryAdmission: events.coverage,
        eventCoordinator: events.outbox,
        recoveryHooks: events.asTurnRecoveryHooks({
          globalBudget: {
            settleGlobal: async () => {
              await Promise.resolve();
              return {
                applied: true,
                alreadySettled: false,
                conflict: false,
                effectiveState: 'settled',
                incidentOpened: false,
              };
            },
          },
        }),
      };
    },
  });
  core.bootstrapHead({ conversationId });

  return {
    core,
    db,
    storage,
    tenantId,
    principalId,
    agentId,
    conversationId,
    workerId: 'worker-web-evidence-test',
    nowMs,
    makeScope() {
      return {
        tenantId,
        principalId,
        agentId,
        policyVersion: 1,
        requestId: randomUUID(),
      };
    },
    makeTenantScope() {
      return {
        tenantId,
        agentId,
      };
    },
  };
}

function makeModelReservation(
  overrides: Partial<NonNullable<PrepareTurnRequest['modelReservation']>> = {},
) {
  return {
    budgetMode: 'simulated_full_protocol' as const,
    providerId: 'fake' as const,
    modelLabel: 'fake-v2',
    rateVersion: 'fake-2026-11-25',
    maxAttempts: 1,
    estimatedMicroUsd: 250,
    ...overrides,
  };
}

function makeValidWebEvidence(turnId: string, overrides: Partial<WebEvidence> = {}): WebEvidence {
  return WebEvidenceSchema.parse({
    schema_version: 1,
    turn_id: turnId,
    status: 'completed',
    sources: [
      {
        source_id: 'ws_1',
        index: 1,
        title: 'Example Source',
        url: 'https://docs.example.com/guide',
        domain: 'docs.example.com',
        snippet: 'Verified documentation summary.',
        published_at: '2026-11-28',
        fetched: true,
      },
    ],
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function parseSseFrames(raw: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const chunk of raw.split('\n\n')) {
    if (chunk.trim().length === 0) continue;
    let event = '';
    let dataLine = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      if (line.startsWith('data: ')) dataLine = line.slice('data: '.length);
    }
    if (event.length > 0 && dataLine.length > 0) {
      frames.push({ event, data: JSON.parse(dataLine) as unknown });
    }
  }
  return frames;
}

describe('V2 Web Evidence Contract, Collector, DO Storage & Routes', () => {
  describe('Contracts & B1 compatibility', () => {
    it('enforces WebEvidence limits, unique URLs, contiguous indices, and model-gateway parity', () => {
      expect(WEB_EVIDENCE_COLLECTOR_LIMITS).toEqual({
        schemaVersion: WEB_EVIDENCE_LIMITS.schemaVersion,
        maxSources: WEB_EVIDENCE_LIMITS.maxSources,
        maxUrlChars: WEB_EVIDENCE_LIMITS.maxUrlChars,
        maxTitleChars: WEB_EVIDENCE_LIMITS.maxTitleChars,
        maxDomainChars: WEB_EVIDENCE_LIMITS.maxDomainChars,
        maxSnippetChars: WEB_EVIDENCE_LIMITS.maxSnippetChars,
        maxPublishedAtChars: WEB_EVIDENCE_LIMITS.maxPublishedAtChars,
        maxSerializedBytes: WEB_EVIDENCE_LIMITS.maxSerializedBytes,
      });

      const turnId = randomUUID();
      const valid = makeValidWebEvidence(turnId);
      expect(valid.schema_version).toBe(1);

      expect(() =>
        WebEvidenceSchema.parse({
          schema_version: 1,
          turn_id: turnId,
          status: 'completed',
          sources: [],
        }),
      ).toThrow();

      expect(() =>
        WebEvidenceSchema.parse({
          ...valid,
          extra_field: true,
        }),
      ).toThrow();

      expect(() =>
        WebEvidenceSchema.parse({
          schema_version: 1,
          turn_id: turnId,
          status: 'completed',
          sources: [
            { ...valid.sources[0]!, index: 1 },
            { ...valid.sources[0]!, source_id: 'ws_2', index: 3, url: 'https://a.example.com' },
          ],
        }),
      ).toThrow();

      expect(() =>
        WebEvidenceSchema.parse({
          schema_version: 1,
          turn_id: turnId,
          status: 'completed',
          sources: [
            { ...valid.sources[0]!, index: 1 },
            { ...valid.sources[0]!, source_id: 'ws_2', index: 2 },
          ],
        }),
      ).toThrow();

      expect(() =>
        WebEvidenceSchema.parse({
          schema_version: 1,
          turn_id: turnId,
          status: 'completed',
          sources: [
            {
              ...valid.sources[0]!,
              url: 'https://user:secret@docs.example.com/private',
            },
          ],
        }),
      ).toThrow();
    });

    it('keeps B1 conversation messages strictly backward compatible without web_evidence', () => {
      const baseMessage = {
        message_id: randomUUID(),
        sequence: 2,
        created_at: new Date().toISOString(),
        kind: 'ember' as const,
        text: 'Hello',
        model_label: 'fake-v2',
        simulated: true,
      };
      expect(B1ConversationMessageSchema.parse(baseMessage)).toEqual(baseMessage);
      expect(() =>
        B1ConversationMessageSchema.parse({
          ...baseMessage,
          web_evidence: makeValidWebEvidence(randomUUID()),
        }),
      ).toThrow();
      expect(() =>
        B1ConversationPageSchema.parse({
          conversation_id: randomUUID(),
          transcript_epoch: 0,
          messages: [{ ...baseMessage, web_evidence: makeValidWebEvidence(randomUUID()) }],
          next_after: 2,
          has_more: false,
        }),
      ).toThrow();
    });
  });

  describe('Exa URL security & WebEvidenceCollector', () => {
    it('filters unsafe private/credential/secret URLs from Exa search results and fetchPage redirects', async () => {
      const client = new ExaWebSearchClient({
        apiKey: 'exa-test',
        fetchImpl: async (url) => {
          await Promise.resolve();
          const target = String(url);
          if (target === EXA_SEARCH_URL) {
            return jsonResponse({
              results: [
                {
                  title: 'Loopback Trap',
                  url: 'http://127.0.0.1:8080/internal',
                  text: 'secret',
                },
                {
                  title: 'Metadata SSRF',
                  url: 'http://169.254.169.254/latest/meta-data',
                  text: 'iam',
                },
                {
                  title: 'Creds Leak',
                  url: 'https://alice:hunter2@example.com/login',
                  text: 'creds',
                },
                {
                  title: 'Secret Token Query',
                  url: 'https://example.com/cb?api_key=sk-proj-secret123',
                  text: 'key',
                },
                {
                  title: 'Public Weather',
                  url: 'https://Weather.EXAMPLE.com/shanghai',
                  text: 'Sunny 20C',
                },
              ],
            });
          }
          expect(target).toBe(EXA_CONTENTS_URL);
          return jsonResponse({
            results: [
              {
                url: 'http://localhost/evil-redirect',
                title: 'Redirected',
                text: 'Safe body',
              },
            ],
          });
        },
      });

      const search = await client.search(
        { query: 'shanghai weather' },
        new AbortController().signal,
      );
      expect(search.results).toHaveLength(1);
      expect(search.results[0]!.url).toBe('https://weather.example.com/shanghai');

      const page = await client.fetchPage(
        { url: 'https://weather.example.com/shanghai' },
        new AbortController().signal,
      );
      expect(page.url).toBe('https://weather.example.com/shanghai');
    });

    it('marks fetched=true only on non-empty fetch content, deduplicates canonical URLs, bounds payload <= 16 KiB, and marks partial on failure', () => {
      const turnId = randomUUID();
      const collector = new WebEvidenceCollector(turnId);

      collector.recordSearchSuccess([
        {
          url: 'https://EXAMPLE.com/news/1',
          title: 'Headline One',
          snippet: 'First snippet',
          publishedDate: '2026-11-28',
        },
        {
          url: 'https://example.com/news/2',
          title: 'Headline Two',
          snippet: 'Second snippet',
        },
        {
          url: 'http://10.0.0.5/private',
          title: 'Private',
          snippet: 'Hidden',
        },
      ]);

      // Empty web_fetch must NOT mark source #1 as fetched.
      collector.recordFetchSuccess({
        url: 'https://example.com/news/1',
        title: 'Headline One',
        content: '   ',
      });
      // Non-empty web_fetch on duplicate canonical URL flips #2 without duplicating or reordering.
      collector.recordFetchSuccess({
        url: 'https://example.com/news/2#',
        title: 'Headline Two',
        content: 'Detailed full article body from Exa contents.',
      });
      collector.recordToolFailure();

      const built = collector.build();
      expect(built).toBeDefined();
      const parsed = WebEvidenceSchema.parse(built);
      expect(parsed.status).toBe('partial');
      expect(parsed.sources).toHaveLength(2);
      expect(parsed.sources[0]).toMatchObject({
        index: 1,
        url: 'https://example.com/news/1',
        domain: 'example.com',
        fetched: false,
      });
      expect(parsed.sources[1]).toMatchObject({
        index: 2,
        url: 'https://example.com/news/2',
        domain: 'example.com',
        fetched: true,
      });

      const empty = new WebEvidenceCollector(turnId);
      empty.recordToolFailure();
      expect(empty.build()).toBeUndefined();

      const large = new WebEvidenceCollector(turnId);
      large.recordSearchSuccess(
        Array.from({ length: 15 }, (_, i) => ({
          url: `https://example-${i}.com/${'a'.repeat(1900)}`,
          title: `Title ${i} ${'t'.repeat(250)}`,
          snippet: `Snippet ${i} ${'s'.repeat(500)}`,
        })),
      );
      const bounded = large.build()!;
      expect(WebEvidenceSchema.parse(bounded).sources.length).toBeLessThanOrEqual(10);
      expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(
        WEB_EVIDENCE_LIMITS.maxSerializedBytes,
      );
    });

    it('captures OpenRouter and DeepSeek multi-round web_search + web_fetch evidence accurately', async () => {
      const openRouterRate: ModelRateRow = findRateRow(
        MODEL_RATE_ROWS,
        'openrouter',
        'deepseek/deepseek-v4.1-flash-1017',
      )!;
      const deepSeekRate: ModelRateRow = findRateRow(MODEL_RATE_ROWS, 'deepseek', 'deepseek-chat')!;

      const makeProviderFetch = (targetUrl: string, model: string): FetchLike => {
        let round = 0;
        return async (url) => {
          await Promise.resolve();
          expect(String(url)).toBe(targetUrl);
          round += 1;
          if (round === 1) {
            return jsonResponse({
              model,
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'web_search', arguments: '{"query":"ember web"}' },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 20 },
            });
          }
          if (round === 2) {
            return jsonResponse({
              model,
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'c2',
                        type: 'function',
                        function: {
                          name: 'web_fetch',
                          arguments: '{"url":"https://docs.example.com/a"}',
                        },
                      },
                      {
                        id: 'c3',
                        type: 'function',
                        function: {
                          name: 'web_fetch',
                          arguments: '{"url":"http://127.0.0.1/blocked"}',
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 150, completion_tokens: 25 },
            });
          }
          return jsonResponse({
            model,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Final grounded answer.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 200, completion_tokens: 30 },
          });
        };
      };

      const webSearch = {
        search: async (req: { readonly query: string }) => {
          await Promise.resolve();
          return {
            query: req.query,
            results: [
              {
                title: 'Doc A',
                url: 'https://docs.example.com/a',
                snippets: ['Doc A snippet'],
              },
              {
                title: 'Doc B',
                url: 'https://blog.example.com/b',
                snippets: ['Doc B snippet'],
              },
            ],
          };
        },
        fetchPage: async (req: { readonly url: string }) => {
          await Promise.resolve();
          return {
            url: req.url,
            title: 'Doc A',
            content: 'Full body of Doc A',
          };
        },
      };

      const turnInput: ConversationTurnInput = {
        conversationId: randomUUID(),
        turnId: randomUUID(),
        context: [{ role: 'user', text: 'Explain Ember web evidence.' }],
        enableWebSearchTool: true,
        maxOutputTokens: 256,
      };

      const orGw = new OpenRouterModelGateway({
        apiKey: 'or-key',
        modelId: 'deepseek/deepseek-v4.1-flash-1017',
        rate: openRouterRate,
        routing: {
          only: ['deepinfra/fp8'],
          allowFallbacks: false,
          dataCollection: 'deny',
          zdr: true,
          requireParameters: true,
        },
        isAuthorized: () => true,
        fetchImpl: makeProviderFetch(
          OPENROUTER_CHAT_COMPLETIONS_URL,
          'deepseek/deepseek-v4.1-flash-1017',
        ),
        webSearch,
      });
      const dsGw = new DeepSeekModelGateway({
        apiKey: 'ds-key',
        modelId: 'deepseek-chat',
        rate: deepSeekRate,
        isAuthorized: () => true,
        fetchImpl: makeProviderFetch(DEEPSEEK_CHAT_COMPLETIONS_URL, 'deepseek-chat'),
        webSearch,
      });

      for (const gw of [orGw, dsGw]) {
        const res = await gw.generateConversationTurn(turnInput, new AbortController().signal);
        expect(res.output.kind).toBe('reply');
        const evidence = WebEvidenceSchema.parse(res.output.webEvidence);
        expect(evidence.turn_id).toBe(turnInput.turnId);
        expect(evidence.status).toBe('partial');
        expect(evidence.sources[0]!.source_id).toMatch(/^ws_[a-f0-9]{16}$/);
        expect(evidence.sources[1]!.source_id).toMatch(/^ws_[a-f0-9]{16}$/);
        expect(evidence.sources).toEqual([
          {
            source_id: evidence.sources[0]!.source_id,
            index: 1,
            title: 'Doc A',
            url: 'https://docs.example.com/a',
            domain: 'docs.example.com',
            snippet: 'Doc A snippet',
            fetched: true,
          },
          {
            source_id: evidence.sources[1]!.source_id,
            index: 2,
            title: 'Doc B',
            url: 'https://blog.example.com/b',
            domain: 'blog.example.com',
            snippet: 'Doc B snippet',
            fetched: false,
          },
        ]);
      }
    });
  });

  describe('AgentHeadDO Migration v11, Atomic Commit, Recovery & Clear', () => {
    it('upgrades cleanly from v10 DO storage to v11 preserving existing rows and checksums', () => {
      const { db, storage } = createInMemoryDoStorage();
      const allSteps = createDefaultAgentHeadMigrations();
      const v1To10 = allSteps.filter((m) => m.version <= 10);
      expect(v1To10.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      applyAgentHeadMigrations(storage, v1To10, 1_000);
      db.exec(`INSERT INTO agent_head_meta (id, tenant_id, agent_id, policy_version, created_at_ms, updated_at_ms)
        VALUES (1, 't1', 'a1', 1, 1000, 1000)`);
      db.exec(`INSERT INTO conversations (id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms)
        VALUES ('c1', 'main', 1, 0, 1000, 1000)`);
      db.exec(`INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
        VALUES ('m1', 'c1', 1, 'user', 'existing prompt', 'sub-1', 1000)`);

      const upgraded = applyAgentHeadMigrations(storage, allSteps, 2_000);
      expect(upgraded.appliedVersions).toEqual([11]);
      expect(upgraded.alreadyAppliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(db.prepare("SELECT text FROM conversation_messages WHERE id = 'm1'").get()).toEqual({
        text: 'existing prompt',
      });
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_web_evidence'",
        )
        .get();
      expect(table).toEqual({ name: 'message_web_evidence' });
    });

    it('commits web evidence atomically, rejects turn_id mismatches without partial commit, omits B1 fields, paginates, and clears on delete', async () => {
      const h = createHeadHarness();

      // Turn 1: with web evidence
      const p1 = await h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        workerId: h.workerId,
        request: { client_submission_id: randomUUID(), text: 'q1', transcript_epoch: 0 },
        executionMode: 'fast_interactive',
        leaseMs: 30_000,
        interactiveDeadlineMs: 25_000,
        turnDeadlineMs: 120_000,
        modelReservation: makeModelReservation(),
      });
      if (p1.kind !== 'prepared') throw new Error('expected prepared');
      await h.core.markAttemptSent({
        scope: h.makeTenantScope(),
        subjectType: 'turn',
        subjectId: p1.turnId,
        attemptNo: p1.attemptNo,
        operationId: p1.operationId,
        leaseEpoch: p1.leaseEpoch,
        leaseOwner: h.workerId,
      });

      // Mismatched turn_id rolls back completely
      const wrongEvidence = makeValidWebEvidence(randomUUID());
      await expect(
        h.core.commitTurn({
          scope: h.makeTenantScope(),
          conversationId: h.conversationId,
          turnId: p1.turnId,
          leaseEpoch: p1.leaseEpoch,
          leaseOwner: h.workerId,
          attemptNo: p1.attemptNo,
          operationId: p1.operationId,
          settlement: {
            state: 'settled',
            outcomeCode: 'ok',
            observedCostMicroUsd: 120,
          },
          result: {
            status: 'completed',
            text: 'should rollback',
            modelLabel: 'fake-v2',
            simulated: true,
            webEvidence: wrongEvidence,
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(h.db.prepare('SELECT COUNT(*) AS c FROM message_web_evidence').get()).toEqual({
        c: 0,
      });

      const ev1 = makeValidWebEvidence(p1.turnId);
      const c1 = await h.core.commitTurn({
        scope: h.makeTenantScope(),
        conversationId: h.conversationId,
        turnId: p1.turnId,
        leaseEpoch: p1.leaseEpoch,
        leaseOwner: h.workerId,
        attemptNo: p1.attemptNo,
        operationId: p1.operationId,
        settlement: {
          state: 'settled',
          outcomeCode: 'ok',
          observedCostMicroUsd: 120,
        },
        result: {
          status: 'completed',
          text: 'Answer with sources',
          modelLabel: 'fake-v2',
          simulated: true,
          webEvidence: ev1,
        },
      });
      expect(c1.outcome).toBe('published');
      if (c1.outcome !== 'published') throw new Error('expected published');
      expect(c1.webEvidence).toEqual(ev1);

      // Turn 2: normal turn without web evidence (creates seq 3 user, seq 4 ember)
      const p2 = await h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        workerId: h.workerId,
        request: { client_submission_id: randomUUID(), text: 'q2', transcript_epoch: 0 },
        executionMode: 'fast_interactive',
        leaseMs: 30_000,
        interactiveDeadlineMs: 25_000,
        turnDeadlineMs: 120_000,
        modelReservation: makeModelReservation(),
      });
      if (p2.kind !== 'prepared') throw new Error('expected prepared');
      await h.core.markAttemptSent({
        scope: h.makeTenantScope(),
        subjectType: 'turn',
        subjectId: p2.turnId,
        attemptNo: p2.attemptNo,
        operationId: p2.operationId,
        leaseEpoch: p2.leaseEpoch,
        leaseOwner: h.workerId,
      });
      await h.core.commitTurn({
        scope: h.makeTenantScope(),
        conversationId: h.conversationId,
        turnId: p2.turnId,
        leaseEpoch: p2.leaseEpoch,
        leaseOwner: h.workerId,
        attemptNo: p2.attemptNo,
        operationId: p2.operationId,
        settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 100 },
        result: {
          status: 'completed',
          text: 'No web search needed',
          modelLabel: 'fake-v2',
          simulated: true,
        },
      });

      // Turn 3: durable path commit via toAgentHeadDurableCommitOutcome -> commitDurableResult
      const p3 = await h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        workerId: h.workerId,
        request: { client_submission_id: randomUUID(), text: 'q3 durable', transcript_epoch: 0 },
        executionMode: 'durable_queue',
        leaseMs: 30_000,
        interactiveDeadlineMs: 25_000,
        turnDeadlineMs: 120_000,
        modelReservation: makeModelReservation(),
      });
      if (p3.kind !== 'prepared') throw new Error('expected prepared');
      const claimed = await h.core.claimDurableWork({
        envelope: {
          schemaVersion: 2,
          eventId: `turn:${p3.turnId}:epoch:${p3.leaseEpoch}`,
          tenantId: h.tenantId,
          agentId: h.agentId,
          entityKind: 'turn',
          entityId: p3.turnId,
          queueName: 'durable_turn',
          fenceEpoch: p3.leaseEpoch,
        },
        workerId: 'durable-worker-1',
        leaseMs: 60_000,
      });
      expect(claimed.kind).toBe('claimed');
      if (claimed.kind !== 'claimed') throw new Error('expected claimed');
      const claimedContext = parseClaimExecutionContext(claimed);
      const ev3 = makeValidWebEvidence(p3.turnId, { status: 'partial' });
      const durableOutcome = toAgentHeadDurableCommitOutcome({
        targetKind: 'turn',
        context: claimedContext,
        modelLabel: 'openrouter/gpt-4o-mini',
        simulated: false,
        outcome: {
          status: 'succeeded',
          operationId: claimedContext.operationId,
          providerJobHandle: null,
          outputJson: JSON.stringify({
            text: 'Durable grounded answer',
            webEvidence: ev3,
          }),
          errorCode: null,
          usage: { inputTokens: 100, outputTokens: 40, costMicroUsd: 210 },
        },
      });
      const committedDurable = await h.core.commitDurableResult({
        tenantId: h.tenantId,
        agentId: h.agentId,
        entityType: 'turn',
        entityId: p3.turnId,
        leaseEpoch: claimed.leaseEpoch,
        workerId: 'durable-worker-1',
        outcome: durableOutcome,
      });
      expect(committedDurable.accepted).toBe(true);

      // B1 readMessages must remain 100% free of web_evidence
      const b1Page = await h.core.readMessages({
        tenantId: h.tenantId,
        agentId: h.agentId,
        conversationId: h.conversationId,
        after: 0,
        limit: 10,
      });
      expect(b1Page.messages).toHaveLength(6);
      for (const msg of b1Page.messages) {
        expect('web_evidence' in msg).toBe(false);
      }

      // V2 readWebEvidence aligns with message sequence cursors across mixed turns
      const evPage1 = await h.core.readWebEvidence({
        tenantId: h.tenantId,
        agentId: h.agentId,
        conversationId: h.conversationId,
        after: 0,
        limit: 4,
      });
      expect(evPage1).toEqual({
        conversation_id: h.conversationId,
        transcript_epoch: 0,
        items: [
          {
            response_message_id: c1.responseMessageId,
            sequence: 2,
            web_evidence: ev1,
          },
        ],
        next_after: 4,
        has_more: true,
      });

      const evPage2 = await h.core.readWebEvidence({
        tenantId: h.tenantId,
        agentId: h.agentId,
        conversationId: h.conversationId,
        after: evPage1.next_after,
        limit: 4,
      });
      expect(evPage2.items).toHaveLength(1);
      expect(evPage2.items[0]!.sequence).toBe(6);
      expect(evPage2.items[0]!.web_evidence).toEqual(ev3);
      expect(evPage2.next_after).toBe(6);
      expect(evPage2.has_more).toBe(false);

      // Foreign tenant isolation check
      await expect(
        Promise.resolve().then(() =>
          h.core.readWebEvidence({
            tenantId: randomUUID(),
            agentId: h.agentId,
            conversationId: h.conversationId,
            after: 0,
            limit: 50,
          }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // Clear transcript deletes message_web_evidence and increments transcript_epoch
      const cleared = await h.core.clearTranscript({
        tenantId: h.tenantId,
        agentId: h.agentId,
        conversationId: h.conversationId,
      });
      expect(cleared.transcriptEpoch).toBe(1);
      expect(h.db.prepare('SELECT COUNT(*) AS c FROM message_web_evidence').get()).toEqual({
        c: 0,
      });
      const afterClear = await h.core.readWebEvidence({
        tenantId: h.tenantId,
        agentId: h.agentId,
        conversationId: h.conversationId,
        after: 0,
        limit: 50,
      });
      expect(afterClear).toEqual({
        conversation_id: h.conversationId,
        transcript_epoch: 1,
        items: [],
        next_after: 0,
        has_more: false,
      });
    });

    it('never persists web evidence on cancelled or fenced turns', async () => {
      const h = createHeadHarness();

      // 1. Cancelled turn
      const pCancel = await h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        workerId: h.workerId,
        request: { client_submission_id: randomUUID(), text: 'cancel me', transcript_epoch: 0 },
        executionMode: 'fast_interactive',
        leaseMs: 30_000,
        interactiveDeadlineMs: 25_000,
        turnDeadlineMs: 120_000,
        modelReservation: makeModelReservation(),
      });
      if (pCancel.kind !== 'prepared') throw new Error('expected prepared');
      await h.core.markAttemptSent({
        scope: h.makeTenantScope(),
        subjectType: 'turn',
        subjectId: pCancel.turnId,
        attemptNo: pCancel.attemptNo,
        operationId: pCancel.operationId,
        leaseEpoch: pCancel.leaseEpoch,
        leaseOwner: h.workerId,
      });
      await h.core.cancelTurn({
        tenantId: h.tenantId,
        agentId: h.agentId,
        conversationId: h.conversationId,
        turnId: pCancel.turnId,
      });
      const cancelCommit = await h.core.commitTurn({
        scope: h.makeTenantScope(),
        conversationId: h.conversationId,
        turnId: pCancel.turnId,
        leaseEpoch: pCancel.leaseEpoch,
        leaseOwner: h.workerId,
        attemptNo: pCancel.attemptNo,
        operationId: pCancel.operationId,
        settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 50 },
        result: {
          status: 'completed',
          text: 'late result',
          modelLabel: 'fake-v2',
          simulated: true,
          webEvidence: makeValidWebEvidence(pCancel.turnId),
        },
      });
      expect(cancelCommit.outcome).toBe('fenced');
      expect(cancelCommit.turn?.status).toBe('cancelled');

      // 2. Stale lease fenced commit
      const pFence = await h.core.prepareTurn({
        scope: h.makeScope(),
        conversationId: h.conversationId,
        workerId: h.workerId,
        request: { client_submission_id: randomUUID(), text: 'fence me', transcript_epoch: 0 },
        executionMode: 'fast_interactive',
        leaseMs: 30_000,
        interactiveDeadlineMs: 25_000,
        turnDeadlineMs: 120_000,
        modelReservation: makeModelReservation(),
      });
      if (pFence.kind !== 'prepared') throw new Error('expected prepared');
      await h.core.markAttemptSent({
        scope: h.makeTenantScope(),
        subjectType: 'turn',
        subjectId: pFence.turnId,
        attemptNo: pFence.attemptNo,
        operationId: pFence.operationId,
        leaseEpoch: pFence.leaseEpoch,
        leaseOwner: h.workerId,
      });
      // Abort for durable retry advances lease_epoch without writing evidence;
      // a subsequent stale-epoch commit at pFence.leaseEpoch must be fenced.
      const aborted = await h.core.commitTurn({
        scope: h.makeTenantScope(),
        conversationId: h.conversationId,
        turnId: pFence.turnId,
        leaseEpoch: pFence.leaseEpoch,
        leaseOwner: h.workerId,
        attemptNo: pFence.attemptNo,
        operationId: pFence.operationId,
        settlement: { state: 'unknown_billed', outcomeCode: 'client_cancelled' },
        result: { status: 'aborted_for_retry_or_reconcile' },
      });
      expect(aborted.outcome).toBe('reconciled_only');

      const fencedCommit = await h.core.commitTurn({
        scope: h.makeTenantScope(),
        conversationId: h.conversationId,
        turnId: pFence.turnId,
        leaseEpoch: pFence.leaseEpoch,
        leaseOwner: h.workerId,
        attemptNo: pFence.attemptNo,
        operationId: pFence.operationId,
        settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 50 },
        result: {
          status: 'completed',
          text: 'fenced result',
          modelLabel: 'fake-v2',
          simulated: true,
          webEvidence: makeValidWebEvidence(pFence.turnId),
        },
      });
      expect(fencedCommit.outcome).toBe('fenced');
      expect(h.db.prepare('SELECT COUNT(*) AS c FROM message_web_evidence').get()).toEqual({
        c: 0,
      });
    });
  });

  describe('Edge Worker HTTP + SSE integration with AgentHeadCore', () => {
    it('streams web_evidence on turn.committed SSE, serves GET /v2/conversations/:id/web-evidence, and leaves V1 messages unchanged', async () => {
      const h = createHeadHarness();
      const token = generateSessionToken();
      const consumerId = randomUUID();

      const sessions: B1SessionRuntime = {
        service: {
          resolveActiveSession: async (presented) => {
            await Promise.resolve();
            if (presented !== token) return null;
            return {
              auth: { tenantId: h.tenantId, principalId: h.principalId, policyVersion: 1 },
              session: {
                sessionId: randomUUID(),
                consumerId,
                tenantId: h.tenantId,
                expiresAt: '2026-12-01T00:00:00.000Z',
                idleExpiresAt: '2026-12-01T00:00:00.000Z',
                revokedAt: null,
              },
            };
          },
          createSession: () => Promise.reject(new Error('unused')),
          refreshSession: () => Promise.reject(new Error('unused')),
          logout: () => Promise.resolve(),
        },
        appleVerifier: { provider: 'apple', verify: vi.fn() },
        devVerifier: { provider: 'dev', verify: vi.fn() },
        devProvider: { evaluate: vi.fn() },
        me: {
          getMeForTenant: () => Promise.resolve(null),
        },
      };

      const edgeRpc: EdgeAgentHeadRpc = {
        prepareTurn: (req) => h.core.prepareTurn(req),
        markAttemptSent: (req) => h.core.markAttemptSent(req),
        renewTurnLease: (req) => h.core.renewTurnLease(req),
        handoffTurnToDurable: (req) => h.core.handoffTurnToDurable(req),
        commitTurn: (req) => h.core.commitTurn(req),
        cancelTurn: (req) => h.core.cancelTurn(req),
        clearTranscript: (req) => h.core.clearTranscript(req),
        readMessages: (req) => h.core.readMessages(req),
        readWebEvidence: (req) => h.core.readWebEvidence(req),
        findSubmissionReceipt: (req) => h.core.findSubmissionReceipt(req),
        getTurn: (req) => h.core.getTurn(req),
      };

      let emitWithWeb = true;
      const gateway: Pick<V2StreamingModelGateway, 'streamConversationTurn'> = {
        async *streamConversationTurn(request) {
          await Promise.resolve();
          const collector = new WebEvidenceCollector(request.input.turnId);
          if (emitWithWeb) {
            collector.recordSearchSuccess([
              {
                title: 'Official Release Notes',
                url: 'https://ember.example.com/releases/v2',
                snippet: 'V2 introduces web evidence cards.',
                publishedDate: '2026-11-28',
              },
            ]);
            collector.recordFetchSuccess({
              url: 'https://ember.example.com/releases/v2',
              title: 'Official Release Notes',
              content: 'Full release notes body.',
            });
          }
          const webEvidence = collector.build();
          yield { kind: 'delta', text: 'Answer' };
          yield {
            kind: 'result',
            result: {
              output: {
                kind: 'reply',
                text: 'Answer',
                finishReason: 'stop',
                ...(webEvidence !== undefined ? { webEvidence } : {}),
              },
              modelLabel: 'fake-v2',
              simulated: true,
              usage: {
                inputTokens: 50,
                outputTokens: 10,
                costMicroUsd: 120,
                rateVersion: 'fake-2026-11-25',
              },
            },
          };
        },
      };

      const worker = createLocalV2EdgeWorker({
        sessions,
        resolveAgentHead: async () => {
          await Promise.resolve();
          return { agentId: h.agentId, conversationId: h.conversationId, rpc: edgeRpc };
        },
        stream: {
          gateway,
          reportObservedUsage: vi.fn(() => Promise.resolve()),
          expectedSimulated: true,
        },
      });

      const authHeaders = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      };

      // Turn 1 (with web evidence)
      const res1 = await worker.fetch(
        new Request(`http://127.0.0.1/v2/conversations/${h.conversationId}/messages/stream`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            client_submission_id: randomUUID(),
            text: 'Search the web',
            transcript_epoch: 0,
          }),
        }),
      );
      expect(res1.status).toBe(201);
      const frames1 = parseSseFrames(await res1.text());
      const committed1 = frames1.find((f) => f.event === 'turn.committed')!.data as {
        response_message_id: string;
        sequence: number;
        web_evidence?: WebEvidence;
      };
      expect(committed1.sequence).toBe(2);
      const parsedEv1 = WebEvidenceSchema.parse(committed1.web_evidence);
      expect(parsedEv1.sources[0]!.fetched).toBe(true);

      // Turn 2 (no web evidence)
      emitWithWeb = false;
      const res2 = await worker.fetch(
        new Request(`http://127.0.0.1/v2/conversations/${h.conversationId}/messages/stream`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            client_submission_id: randomUUID(),
            text: 'Offline question',
            transcript_epoch: 0,
          }),
        }),
      );
      expect(res2.status).toBe(201);
      const frames2 = parseSseFrames(await res2.text());
      const committed2 = frames2.find((f) => f.event === 'turn.committed')!.data as Record<
        string,
        unknown
      >;
      expect('web_evidence' in committed2).toBe(false);

      // V2 web-evidence GET endpoint
      const getEv = await worker.fetch(
        new Request(
          `http://127.0.0.1/v2/conversations/${h.conversationId}/web-evidence?after=0&limit=50`,
          { method: 'GET', headers: { authorization: `Bearer ${token}` } },
        ),
      );
      expect(getEv.status).toBe(200);
      const evPage = V2ConversationWebEvidencePageSchema.parse(await getEv.json());
      expect(evPage).toEqual({
        conversation_id: h.conversationId,
        transcript_epoch: 0,
        items: [
          {
            response_message_id: committed1.response_message_id,
            sequence: 2,
            web_evidence: parsedEv1,
          },
        ],
        next_after: 4,
        has_more: false,
      });

      // V1 messages GET remains strictly B1-compatible
      const getV1 = await worker.fetch(
        new Request(
          `http://127.0.0.1/v1/conversations/${h.conversationId}/messages?after=0&limit=50`,
          { method: 'GET', headers: { authorization: `Bearer ${token}` } },
        ),
      );
      expect(getV1.status).toBe(200);
      const b1Page = B1ConversationPageSchema.parse(await getV1.json());
      expect(b1Page.messages).toHaveLength(4);
      for (const msg of b1Page.messages) {
        expect('web_evidence' in msg).toBe(false);
      }

      // Security & parameter validation guards on GET /v2/.../web-evidence
      expect(
        (
          await worker.fetch(
            new Request(`http://127.0.0.1/v2/conversations/${h.conversationId}/web-evidence`),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await worker.fetch(
            new Request(`http://127.0.0.1/v2/conversations/not-a-uuid/web-evidence`, {
              headers: { authorization: `Bearer ${token}` },
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await worker.fetch(
            new Request(
              `http://127.0.0.1/v2/conversations/${h.conversationId}/web-evidence?tenant_id=${h.tenantId}`,
              { headers: { authorization: `Bearer ${token}` } },
            ),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await worker.fetch(
            new Request(`http://127.0.0.1/v2/conversations/${h.conversationId}/web-evidence`, {
              headers: {
                authorization: `Bearer ${token}`,
                'x-tenant-id': h.tenantId,
              },
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await worker.fetch(
            new Request(
              `http://127.0.0.1/v2/conversations/${h.conversationId}/web-evidence?limit=999`,
              { headers: { authorization: `Bearer ${token}` } },
            ),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await worker.fetch(
            new Request(`http://127.0.0.1/v2/conversations/${randomUUID()}/web-evidence`, {
              headers: { authorization: `Bearer ${token}` },
            }),
          )
        ).status,
      ).toBe(404);
    });
  });

  describe('CTO Review Fixes (#303)', () => {
    it('does not mark fetched=true when Exa fetchPage falls back to highlights without full text', async () => {
      const client = new ExaWebSearchClient({
        apiKey: 'exa-test',
        fetchImpl: async (url) => {
          await Promise.resolve();
          expect(String(url)).toBe(EXA_CONTENTS_URL);
          return jsonResponse({
            results: [
              {
                url: 'https://example.com/snippet-only',
                title: 'Snippet Only Page',
                text: '   ',
                highlights: ['Short highlight excerpt from search index.'],
              },
            ],
          });
        },
      });

      const page = await client.fetchPage(
        { url: 'https://example.com/snippet-only' },
        new AbortController().signal,
      );
      expect(page.contentKind).toBe('highlights');
      expect(page.content).toBe('Short highlight excerpt from search index.');

      const collector = new WebEvidenceCollector(randomUUID());
      collector.recordFetchSuccess(page);
      const built = collector.build();
      expect(built).toBeDefined();
      expect(built!.sources).toHaveLength(1);
      expect(built!.sources[0]!.fetched).toBe(false);
      expect(built!.sources[0]!.snippet).toContain('Short highlight excerpt');
    });

    it('rejects private, loopback, metadata, local, and obfuscated URLs in WebEvidenceSchema directly', () => {
      const rejectedUrls = [
        'http://127.0.0.1/admin',
        'http://localhost:8787/test',
        'http://sub.localhost/test',
        'http://10.0.0.5/internal',
        'http://172.16.1.2/internal',
        'http://192.168.1.10/router',
        'http://169.254.169.254/latest/meta-data',
        'http://0.0.0.0:3000/',
        'http://[::1]:8080/',
        'http://[fe80::1]/',
        'http://[fd12::1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://redis/keys',
        'https://ember.local/service',
        'https://metadata.internal/token',
        'https://user:pass@example.com/ok',
      ];

      for (const badUrl of rejectedUrls) {
        expect(() =>
          WebEvidenceSchema.parse({
            schema_version: 1,
            turn_id: randomUUID(),
            status: 'completed',
            sources: [
              {
                source_id: 'src-1',
                index: 1,
                title: 'Bad',
                url: badUrl,
                domain: 'example.com',
                fetched: false,
              },
            ],
          }),
        ).toThrow();
      }

      expect(() =>
        WebEvidenceSchema.parse({
          schema_version: 1,
          turn_id: randomUUID(),
          status: 'completed',
          sources: [
            {
              source_id: 'src-1',
              index: 1,
              title: 'Public IPv4',
              url: 'https://93.184.216.34/doc',
              domain: '93.184.216.34',
              fetched: true,
            },
          ],
        }),
      ).not.toThrow();
    });

    it('aligns tool-output citation numbers across multi-call and multi-round search batches with WebEvidence indices', async () => {
      const collector = new WebEvidenceCollector(randomUUID());
      const responses = new Map<string, readonly { title: string; url: string }[]>([
        [
          'query one',
          [
            { title: 'Alpha', url: 'https://alpha.example.com/1' },
            { title: 'Beta', url: 'https://beta.example.com/2' },
          ],
        ],
        [
          'query two',
          [
            { title: 'Beta Duplicate', url: 'https://beta.example.com/2#' },
            { title: 'Gamma', url: 'https://gamma.example.com/3' },
          ],
        ],
      ]);

      const round1 = await executeWebToolCallBatch({
        calls: [
          { id: 'c1', name: 'web_search', arguments: JSON.stringify({ query: 'query one' }) },
          { id: 'c2', name: 'web_search', arguments: JSON.stringify({ query: 'query two' }) },
        ],
        round: 1,
        perCallTokenBudget: 1_500,
        webSearch: {
          search: async (req) => ({
            query: req.query,
            results: (responses.get(req.query) ?? []).map((item) => ({
              title: item.title,
              url: item.url,
              snippets: [],
            })),
          }),
        },
        privacyContext: {},
        evidenceCollector: collector,
        signal: new AbortController().signal,
      });

      expect(round1.outputs[0]!.content).toContain('[1] Alpha');
      expect(round1.outputs[0]!.content).toContain('[2] Beta');
      // Second search call must NOT reset Beta/Gamma back to [1], [2]; must align with [2], [3].
      expect(round1.outputs[1]!.content).toContain('[2] Beta Duplicate');
      expect(round1.outputs[1]!.content).toContain('[3] Gamma');
      expect(round1.outputs[1]!.content).not.toContain('[1] Beta Duplicate');

      const built = collector.build()!;
      expect(built.sources.map((s) => `${s.index}:${s.url}`)).toEqual([
        '1:https://alpha.example.com/1',
        '2:https://beta.example.com/2',
        '3:https://gamma.example.com/3',
      ]);
    });
  });
});
