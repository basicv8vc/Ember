import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ModelGatewayFailure,
  OpenAiModelGateway,
  type FetchLike,
  type FetchRequestInitLike,
  type ModelBudgetCeilings,
  type ModelRateRow,
} from '@ember/model-gateway';
import { B1_TURN_FAILURE_MESSAGE, PostgresB1AssistantTurnRepository } from '@ember/postgres';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { PostgresModelTurnExecutionRepository } from '../../packages/postgres/src/repositories/b2-model-turn-execution-repository.js';
import { createModelTurnResponder } from '../../apps/worker/src/b1/model-turn-responder.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * L4-B — the Mock Provider suite.
 *
 * Every other B2 test replaces the `ModelGateway` interface, which proves the *responder* but not
 * the adapter: request shape, response parsing, usage pricing and the status taxonomy all live in
 * `OpenAiModelGateway` and were only ever exercised against a hand-built stub in a unit test.
 *
 * Here the real adapter is constructed and only `fetch` is replaced. That is the closest a CI run
 * can legally get to a paid call: the origin is still the pinned constant, the request is built by
 * production code, and the reply is parsed by production code — but no socket is opened, no key is
 * real, and nothing is billed. The database is real, so "the message persisted" is a fact rather
 * than an assertion about an in-memory object.
 */

const PINNED_MODEL = 'gpt-5.6-luna';
const API_KEY = 'sk-mock-provider-not-a-real-key-0001';
const SOURCE_TEXT = 'what is the point of a bounded context window';

/** The official GPT-5.6 Luna price row, with its published price reviewed for this mock fixture. */
const RATE: ModelRateRow = Object.freeze({
  providerId: 'openai' as const,
  modelId: PINNED_MODEL,
  inputMicroUsdPerMillion: 200_000,
  outputMicroUsdPerMillion: 1_200_000,
  rateVersion: 'openai-gpt-5.6-luna-published-2026-11-10',
  provenance: 'official_price_verified' as const,
  source: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
  shutdownDate: null,
  reasoningEffort: 'none' as const,
});

const CEILINGS: ModelBudgetCeilings = {
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
};

const PROMPT_TOKENS = 40;
const COMPLETION_TOKENS = 20;
/** ceil((40 × 200 000 + 20 × 1 200 000) / 1 000 000) — the adapter's own arithmetic. */
const OBSERVED_COST = 32;

interface Fixture {
  readonly tenantId: string;
  readonly principalId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly sourceMessageId: string;
}

type MockStep =
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'hang' }
  | { readonly kind: 'hold' };

interface MockProvider {
  readonly fetchImpl: FetchLike;
  readonly calls: FetchRequestInitLike[];
  /** Resolves once the provider has actually been called. */
  readonly entered: Promise<void>;
  release(text?: string): void;
}

/**
 * A provider that answers from a script, at the transport boundary.
 *
 * `hang` rejects only when the request's own `AbortSignal` fires, so a timeout test proves the
 * adapter's cancellation path rather than the test's timer. `hold` keeps the request open until the
 * test releases it, so a cancellation can be applied while a call is genuinely in flight.
 */
function mockProvider(steps: readonly MockStep[]): MockProvider {
  const queue: MockStep[] = [...steps];
  const calls: FetchRequestInitLike[] = [];
  let release: (text: string) => void = () => {};
  let markEntered: () => void = () => {};

  const entered = new Promise<void>((resolveEntered) => {
    markEntered = resolveEntered;
  });

  const fetchImpl: FetchLike = (_url, init) => {
    calls.push(init);
    markEntered();

    const step = queue.shift();

    if (step === undefined) {
      return Promise.reject(new Error('mock provider received an unscripted request'));
    }

    if (step.kind === 'hang') {
      return new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error('aborted'));
        if (init.signal.aborted) {
          onAbort();
          return;
        }
        init.signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    if (step.kind === 'hold') {
      return new Promise((resolve) => {
        release = (text) => resolve(reply(text, PROMPT_TOKENS, COMPLETION_TOKENS));
      });
    }

    if (step.kind === 'status') {
      return Promise.resolve({
        status: step.status,
        ok: false,
        json: () => Promise.resolve({}),
      });
    }

    return Promise.resolve(reply(step.text, PROMPT_TOKENS, COMPLETION_TOKENS));
  };

  return {
    fetchImpl,
    calls,
    entered,
    release: (text = 'a reply that arrives too late') => release(text),
  };
}

function reply(text: string, promptTokens: number, completionTokens: number) {
  return {
    status: 200,
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      }),
  };
}

function gatewayFor(mock: MockProvider) {
  return new OpenAiModelGateway({
    apiKey: API_KEY,
    modelId: PINNED_MODEL,
    rate: RATE,
    isAuthorized: () => true,
    fetchImpl: mock.fetchImpl,
  });
}

let db: TestDatabase;
let repository: PostgresModelTurnExecutionRepository;
let b1Repository: PostgresB1AssistantTurnRepository;
let writer: PostgresB1ConversationWriteRepository;

function makeResponder(
  mock: MockProvider,
  options: {
    readonly ceilings?: ModelBudgetCeilings;
    readonly attemptTimeoutMs?: number;
    readonly maxAttempts?: number;
  } = {},
) {
  return createModelTurnResponder({
    mode: 'real',
    repository,
    gateway: gatewayFor(mock),
    workerId: 'worker-mock-provider',
    leaseMs: 30_000,
    ceilings: options.ceilings ?? CEILINGS,
    maxAttempts: options.maxAttempts ?? 2,
    attemptTimeoutMs: options.attemptTimeoutMs ?? 20_000,
    rate: RATE,
    batchSize: 5,
  });
}

async function createFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();

  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'mock test']);
  await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
    principalId,
    tenantId,
  ]);
  await db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
    randomUUID(),
    tenantId,
    principalId,
  ]);
  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, 'mock agent'],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );

  const submitted = await writer.submitUserMessage({
    tenantId,
    conversationId,
    request: { client_submission_id: randomUUID(), text: SOURCE_TEXT, transcript_epoch: 0 },
  });

  return {
    tenantId,
    principalId,
    conversationId,
    turnId: submitted.receipt.turn.turn_id,
    sourceMessageId: submitted.receipt.message.message_id,
  };
}

function identity(fixture: Fixture) {
  return {
    tenantId: fixture.tenantId,
    conversationId: fixture.conversationId,
    turnId: fixture.turnId,
  };
}

async function readTurn(fixture: Fixture) {
  const result = await db.observerPool.query<{
    readonly status: string;
    readonly failure_reason: string | null;
    readonly response_message_id: string | null;
  }>(
    `SELECT status, failure_reason, response_message_id
       FROM assistant_turns
      WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3`,
    [fixture.tenantId, fixture.conversationId, fixture.turnId],
  );

  return result.rows[0]!;
}

async function readTranscript(fixture: Fixture) {
  const result = await db.observerPool.query<{
    readonly id: string;
    readonly kind: string;
    readonly sequence: string;
    readonly text: string;
    readonly model_label: string | null;
    readonly simulated: boolean;
  }>(
    `SELECT id, kind, sequence::text, text, model_label, simulated
       FROM conversation_messages
      WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY sequence`,
    [fixture.tenantId, fixture.conversationId],
  );

  return result.rows;
}

async function readAttempts(fixture: Fixture) {
  const result = await db.observerPool.query<{
    readonly attempt_no: number;
    readonly state: string;
    readonly outcome_code: string | null;
    readonly reserved_micro_usd: string;
    readonly applied_cost_micro_usd: string | null;
    readonly observed_cost_micro_usd: string | null;
    readonly model_label: string;
    readonly rate_version: string;
  }>(
    `SELECT attempt_no, state, outcome_code, reserved_micro_usd::text,
            applied_cost_micro_usd::text, observed_cost_micro_usd::text, model_label, rate_version
       FROM model_turn_attempts
      WHERE tenant_id = $1 AND turn_id = $2
      ORDER BY attempt_no`,
    [fixture.tenantId, fixture.turnId],
  );

  return result.rows;
}

async function readGlobalSpend() {
  const result = await db.observerPool.query<{
    readonly reserved: string;
    readonly consumed: string;
  }>(
    `SELECT reserved_micro_usd::text AS reserved, consumed_micro_usd::text AS consumed
       FROM model_global_spend_days
      WHERE utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date`,
  );

  return result.rows[0] ?? null;
}

async function clearGlobalSpend(): Promise<void> {
  await db.pool.query(
    "DELETE FROM model_global_spend_days WHERE utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date",
  );
}

/**
 * A failed Turn still writes exactly one Ember row, carrying the frozen user-safe text and flagged
 * `simulated: true`. Asserting on it separates "the user was told" from "a model answered": the
 * failure path must never be mistakable for live output.
 */
async function expectOnlyTheFailureReply(fixture: Fixture): Promise<void> {
  const transcript = await readTranscript(fixture);

  expect(transcript.map((row) => row.kind)).toStrictEqual(['user', 'ember']);
  expect(transcript[1]).toMatchObject({ text: B1_TURN_FAILURE_MESSAGE, simulated: true });
  expect(transcript[1]?.model_label).not.toBe(PINNED_MODEL);
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 12 });
  repository = new PostgresModelTurnExecutionRepository(db.pool);
  b1Repository = new PostgresB1AssistantTurnRepository(db.pool);
  writer = new PostgresB1ConversationWriteRepository(db.pool);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('B2 Mock Provider — production adapter, stubbed transport, real database', () => {
  it('1. completes a Turn, persists the reply and books the provider-reported cost', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const mock = mockProvider([{ kind: 'reply', text: 'a reply from the mock provider' }]);

    const summary = await makeResponder(mock).processOnce();

    expect(summary.completed).toBe(1);
    expect(mock.calls).toHaveLength(1);

    // The request is built by the production adapter: pinned model, pinned origin, no caller knobs.
    const body = JSON.parse(mock.calls[0]!.body) as Record<string, unknown>;
    expect(body['model']).toBe(PINNED_MODEL);
    expect(body['reasoning_effort']).toBe('none');
    expect(body['max_completion_tokens']).toBe(512);
    expect(body['stream']).toBe(false);
    expect(body['store']).toBe(false);
    expect(mock.calls[0]!.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(mock.calls[0]!.redirect).toBe('error');

    const turn = await readTurn(fixture);
    const transcript = await readTranscript(fixture);
    const attempts = await readAttempts(fixture);

    expect(turn.status).toBe('completed');
    expect(turn.failure_reason).toBeNull();

    // Persistence is a database fact: the user message, then exactly one Ember reply.
    expect(transcript.map((row) => row.kind)).toStrictEqual(['user', 'ember']);
    const reply = transcript[1]!;
    expect(reply.text).toBe('a reply from the mock provider');
    expect(reply.model_label).toBe(PINNED_MODEL);
    expect(reply.simulated).toBe(false);
    expect(turn.response_message_id).toBe(reply.id);
    expect(Number(reply.sequence)).toBeGreaterThan(Number(transcript[0]!.sequence));

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt_no: 1,
      state: 'settled',
      outcome_code: 'ok',
      model_label: PINNED_MODEL,
      rate_version: RATE.rateVersion,
      applied_cost_micro_usd: String(OBSERVED_COST),
      observed_cost_micro_usd: String(OBSERVED_COST),
    });

    expect(await readGlobalSpend()).toMatchObject({
      reserved: '0',
      consumed: String(OBSERVED_COST),
    });
  });

  it('2. fails closed on a provider that never answers, and keeps both reservations', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const mock = mockProvider([{ kind: 'hang' }, { kind: 'hang' }]);

    const summary = await makeResponder(mock, { attemptTimeoutMs: 250 }).processOnce();

    expect(summary.timedOut).toBe(1);
    // Two attempts, because a timeout is retryable; the second is the last one allowed.
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls.every((call) => call.signal.aborted)).toBe(true);

    const turn = await readTurn(fixture);
    const attempts = await readAttempts(fixture);

    expect(turn.status).toBe('failed');
    expect(turn.failure_reason).toBe('timeout');
    await expectOnlyTheFailureReply(fixture);
    expect(attempts.map((attempt) => attempt.state)).toStrictEqual([
      'unknown_billed',
      'unknown_billed',
    ]);
    expect(attempts.every((attempt) => attempt.outcome_code === 'model_timeout')).toBe(true);

    const spend = await readGlobalSpend();
    const reserved = attempts.reduce(
      (total, attempt) => total + Number(attempt.reserved_micro_usd),
      0,
    );
    expect(spend?.consumed).toBe('0');
    expect(Number(spend?.reserved)).toBe(reserved);
  });

  it('3. refuses to send a request whose worst case exceeds the per-attempt ceiling', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const mock = mockProvider([{ kind: 'reply', text: 'must never be sent' }]);

    // The priced worst case for this context is ~0.7 mUSD; a 100 µUSD ceiling cannot hold it.
    const summary = await makeResponder(mock, {
      ceilings: { ...CEILINGS, perAttemptMicroUsd: 100 },
    }).processOnce();

    expect(summary.failed).toBe(1);
    // The cap is a limit, not a target: nothing is clamped and nothing leaves the process.
    expect(mock.calls).toHaveLength(0);
    expect(await readAttempts(fixture)).toHaveLength(0);
    expect(await readTurn(fixture)).toMatchObject({
      status: 'failed',
      failure_reason: 'internal_error',
    });
    await expectOnlyTheFailureReply(fixture);
    // Not even a zero-valued bucket row exists: the refusal happened before the reservation, so the
    // day's ledger never learned about this call at all.
    expect(await readGlobalSpend()).toBeNull();
  });

  it('4. discards a reply that arrives after the Turn was cancelled', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const mock = mockProvider([{ kind: 'hold' }]);

    const pass = makeResponder(mock).processOnce();
    await mock.entered;
    await b1Repository.cancelTurn(identity(fixture));
    mock.release('a reply nobody will read');

    const summary = await pass;
    const attempts = await readAttempts(fixture);

    // The provider was called and may bill, so the charge stands; the text does not.
    expect(summary.fenced).toBe(1);
    expect(await readTurn(fixture)).toMatchObject({ status: 'cancelled' });
    expect(await readTranscript(fixture)).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'settled', outcome_code: 'ok' });
  });

  it('5. recovers from a provider 5xx within the attempt budget', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const mock = mockProvider([
      { kind: 'status', status: 503 },
      { kind: 'reply', text: 'a reply after the provider recovered' },
    ]);

    const summary = await makeResponder(mock).processOnce();

    expect(summary.completed).toBe(1);
    expect(mock.calls).toHaveLength(2);

    const attempts = await readAttempts(fixture);
    const transcript = await readTranscript(fixture);

    expect(attempts.map((attempt) => attempt.state)).toStrictEqual(['unknown_billed', 'settled']);
    expect(attempts.map((attempt) => attempt.outcome_code)).toStrictEqual([
      'model_unavailable',
      'ok',
    ]);
    expect(transcript).toHaveLength(2);
    expect(transcript[1]?.text).toBe('a reply after the provider recovered');
    expect(await readTurn(fixture)).toMatchObject({ status: 'completed' });
  });

  it('6. does not retry an authentication failure, and records exactly one attempt', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const mock = mockProvider([{ kind: 'status', status: 401 }]);

    const summary = await makeResponder(mock).processOnce();

    expect(summary.failed).toBe(1);
    // A rejected key is an operator problem: retrying it only doubles the failure.
    expect(mock.calls).toHaveLength(1);

    const attempts = await readAttempts(fixture);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      state: 'unknown_billed',
      outcome_code: 'model_auth_failed',
    });
    await expectOnlyTheFailureReply(fixture);
  });

  it('7. lets a second concurrent pass report busy instead of opening a second call', async () => {
    await clearGlobalSpend();
    await createFixture();
    const mock = mockProvider([{ kind: 'hold' }]);
    const responder = makeResponder(mock);

    const first = responder.processOnce();
    await mock.entered;

    const second = await responder.processOnce();

    expect(second.busy).toBe(true);
    expect(second.examined).toBe(0);

    mock.release('one reply, one call');
    expect((await first).completed).toBe(1);
    expect(mock.calls).toHaveLength(1);
  });

  it('8. reports an unparsable provider body as invalid output without publishing', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const mock = mockProvider([{ kind: 'status', status: 200 }]);

    const summary = await makeResponder(mock, { maxAttempts: 1 }).processOnce();

    expect(summary.failed).toBe(1);
    expect(mock.calls).toHaveLength(1);

    const attempts = await readAttempts(fixture);
    expect(attempts[0]).toMatchObject({
      state: 'unknown_billed',
      outcome_code: 'model_invalid_output',
    });
    await expectOnlyTheFailureReply(fixture);
  });

  it('9. keeps the credential out of every persisted row and error', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const mock = mockProvider([{ kind: 'status', status: 401 }]);

    await makeResponder(mock, { maxAttempts: 1 }).processOnce();

    const attempts = await readAttempts(fixture);
    const serialized = JSON.stringify(attempts) + JSON.stringify(await readTurn(fixture));

    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('sk-');
    // The failure the adapter raised is a closed code, never provider text.
    expect(new ModelGatewayFailure('model_auth_failed').message).not.toContain('Bearer');
  });
});
