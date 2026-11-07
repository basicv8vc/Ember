import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@ember/domain';
import {
  ModelGatewayFailure,
  createModelGateway,
  resolveModelExecution,
  type ConversationTurnInput,
  type ConversationTurnOutput,
  type ModelBudgetCeilings,
  type ModelCallResult,
  type ModelFailureCode,
  type ModelGateway,
  type ModelRateRow,
} from '@ember/model-gateway';
import { createPool, loadDatabaseConfig } from '@ember/postgres';
import { PostgresB1AssistantTurnRepository } from '../../packages/postgres/src/repositories/b1-assistant-turn-repository.js';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { PostgresModelTurnExecutionRepository } from '../../packages/postgres/src/repositories/b2-model-turn-execution-repository.js';
import { createModelTurnResponder } from '../../apps/worker/src/b1/model-turn-responder.js';
import { loadWorkerConfig } from '../../apps/worker/src/config.js';
import { backendPid, createTestDatabase, type TestDatabase } from './support/database.js';

const SOURCE_TEXT = 'what is the point of a bounded context window';
const REAL_MODEL_LABEL = 'gpt-test-pinned-2026-11-03';

/** Priced locally. `invoice_verified` because a test may not pretend to be an unapproved model. */
const RATE: ModelRateRow = {
  providerId: 'openai',
  modelId: REAL_MODEL_LABEL,
  inputMicroUsdPerMillion: 250_000,
  outputMicroUsdPerMillion: 2_000_000,
  rateVersion: `${REAL_MODEL_LABEL}-invoice-2026-11-03`,
  provenance: 'invoice_verified',
  source: 'integration fixture',
};

const CEILINGS: ModelBudgetCeilings = {
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
};

const OBSERVED_COST = 130;

interface Fixture {
  readonly tenantId: string;
  readonly principalId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly sourceMessageId: string;
}

interface AttemptRow {
  readonly attempt_no: number;
  readonly state: string;
  readonly outcome_code: string | null;
  readonly reserved_micro_usd: string;
  readonly applied_cost_micro_usd: string | null;
  readonly observed_cost_micro_usd: string | null;
  readonly send_started_at: Date | null;
  readonly provider_id: string;
  readonly model_label: string;
  readonly rate_version: string;
}

let db: TestDatabase;
let repository: PostgresModelTurnExecutionRepository;
let b1Repository: PostgresB1AssistantTurnRepository;
let writer: PostgresB1ConversationWriteRepository;

/** Deterministic stand-in for the provider. No network, no clock, no environment. */
class ScriptedGateway implements ModelGateway {
  readonly providerId = 'openai' as const;
  readonly modelLabel = REAL_MODEL_LABEL;
  readonly simulated = false;
  readonly operations = ['conversation.turn'] as const;

  readonly inputs: ConversationTurnInput[] = [];
  #script: Array<ModelFailureCode | 'ok'>;

  constructor(
    script: Array<ModelFailureCode | 'ok'>,
    private readonly text = 'a live reply',
  ) {
    this.#script = [...script];
  }

  generateConversationTurn(
    input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>> {
    this.inputs.push(input);

    if (signal.aborted) {
      return Promise.reject(new ModelGatewayFailure('client_cancelled'));
    }

    const step = this.#script.shift() ?? 'ok';

    if (step !== 'ok') {
      return Promise.reject(new ModelGatewayFailure(step));
    }

    return Promise.resolve({
      output: { text: this.text, finishReason: 'stop' as const },
      modelLabel: REAL_MODEL_LABEL,
      simulated: false as const,
      usage: {
        inputTokens: 40,
        outputTokens: 20,
        costMicroUsd: OBSERVED_COST,
        rateVersion: RATE.rateVersion,
      },
    });
  }
}

/** A gateway whose call is held open until the test releases or fails it. */
class DeferredGateway implements ModelGateway {
  readonly providerId = 'openai' as const;
  readonly modelLabel = REAL_MODEL_LABEL;
  readonly simulated = false;
  readonly operations = ['conversation.turn'] as const;

  calls = 0;
  #release: (() => void) | null = null;
  #entered: () => void = () => {};
  readonly entered = new Promise<void>((resolve) => {
    this.#entered = resolve;
  });

  constructor(private readonly text = 'reply from the deferred worker') {}

  generateConversationTurn(
    _input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>> {
    this.calls += 1;
    this.#entered();

    return new Promise((resolve, reject) => {
      this.#release = () => {
        resolve({
          output: { text: this.text, finishReason: 'stop' as const },
          modelLabel: REAL_MODEL_LABEL,
          simulated: false as const,
          usage: {
            inputTokens: 40,
            outputTokens: 20,
            costMicroUsd: OBSERVED_COST,
            rateVersion: RATE.rateVersion,
          },
        });
      };

      signal.addEventListener('abort', () => reject(new ModelGatewayFailure('client_cancelled')), {
        once: true,
      });
    });
  }

  release(): void {
    this.#release?.();
  }
}

function makeResponder(
  gateway: ModelGateway,
  options: {
    readonly workerId?: string;
    readonly leaseMs?: number;
    readonly ceilings?: ModelBudgetCeilings;
    readonly repository?: PostgresModelTurnExecutionRepository;
    readonly mode?: 'fake' | 'real';
    readonly batchSize?: number;
  } = {},
) {
  return createModelTurnResponder({
    mode: options.mode ?? 'real',
    repository: options.repository ?? repository,
    gateway,
    workerId: options.workerId ?? 'worker-b2-test',
    leaseMs: options.leaseMs ?? 30_000,
    ceilings: options.ceilings ?? CEILINGS,
    maxAttempts: 2,
    attemptTimeoutMs: 20_000,
    rate: RATE,
    batchSize: options.batchSize ?? 5,
  });
}

async function createFixture(options: { readonly tenantId?: string } = {}): Promise<Fixture> {
  const tenantId = options.tenantId ?? randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();

  if (options.tenantId === undefined) {
    await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'b2 test']);
    await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
      principalId,
      tenantId,
    ]);
    // Consumers are 1:1 with a tenant, and are the only server-derived source of a paid principal.
    await db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
      randomUUID(),
      tenantId,
      principalId,
    ]);
  }

  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, 'b2 test agent'],
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

async function readTurnRow(fixture: Fixture) {
  const result = await db.observerPool.query<{
    readonly status: string;
    readonly failure_reason: string | null;
    readonly lease_epoch: string;
    readonly lease_owner: string | null;
    readonly lease_expires_at: Date | null;
    readonly claim_count: string;
    readonly response_message_id: string | null;
  }>(
    `
SELECT status, failure_reason, lease_epoch::text, lease_owner, lease_expires_at,
       claim_count::text, response_message_id
  FROM assistant_turns
 WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3`,
    [fixture.tenantId, fixture.conversationId, fixture.turnId],
  );

  return result.rows[0]!;
}

async function readEmberMessages(fixture: Fixture) {
  const result = await db.observerPool.query<{
    readonly id: string;
    readonly sequence: string;
    readonly text: string;
    readonly model_label: string;
    readonly simulated: boolean;
  }>(
    `
SELECT id, sequence::text, text, model_label, simulated
  FROM conversation_messages
 WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'
 ORDER BY sequence`,
    [fixture.tenantId, fixture.conversationId],
  );

  return result.rows;
}

async function readAttempts(fixture: Fixture): Promise<readonly AttemptRow[]> {
  const result = await db.observerPool.query<AttemptRow>(
    `
SELECT attempt_no, state, outcome_code, reserved_micro_usd::text,
       applied_cost_micro_usd::text, observed_cost_micro_usd::text, send_started_at,
       provider_id, model_label, rate_version
  FROM model_turn_attempts
 WHERE tenant_id = $1 AND turn_id = $2
 ORDER BY attempt_no`,
    [fixture.tenantId, fixture.turnId],
  );

  return result.rows;
}

interface Spend {
  readonly reserved: number;
  readonly consumed: number;
  readonly turnsStarted: number;
}

async function readSpend(fixture: Fixture): Promise<{
  readonly global: Spend | null;
  readonly tenant: Spend | null;
  readonly principal: Spend | null;
}> {
  const global = await db.observerPool.query<{
    readonly reserved: string;
    readonly consumed: string;
  }>(
    `
SELECT reserved_micro_usd::text AS reserved, consumed_micro_usd::text AS consumed
  FROM model_global_spend_days
 WHERE utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date`,
  );
  const scoped = await db.observerPool.query<{
    readonly scope_kind: 'tenant' | 'principal';
    readonly reserved: string;
    readonly consumed: string;
    readonly turns_started: string;
  }>(
    `
SELECT scope_kind, reserved_micro_usd::text AS reserved, consumed_micro_usd::text AS consumed,
       turns_started::text AS turns_started
  FROM model_spend_days
 WHERE tenant_id = $1 AND utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date`,
    [fixture.tenantId],
  );

  const pick = (kind: 'tenant' | 'principal'): Spend | null => {
    const row = scoped.rows.find((candidate) => candidate.scope_kind === kind);

    return row === undefined
      ? null
      : {
          reserved: Number(row.reserved),
          consumed: Number(row.consumed),
          turnsStarted: Number(row.turns_started),
        };
  };

  return {
    global:
      global.rows[0] === undefined
        ? null
        : {
            reserved: Number(global.rows[0].reserved),
            consumed: Number(global.rows[0].consumed),
            turnsStarted: 0,
          },
    tenant: pick('tenant'),
    principal: pick('principal'),
  };
}

/** Seed a bucket so the very next reservation cannot fit. Deterministic regardless of test order. */
async function seedSpend(
  bucket: 'global' | 'tenant' | 'principal',
  fixture: Fixture,
  reserved: number,
): Promise<void> {
  if (bucket === 'global') {
    await db.pool.query(
      `
INSERT INTO model_global_spend_days (utc_day, reserved_micro_usd)
VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date, $1)
ON CONFLICT (utc_day) DO UPDATE SET reserved_micro_usd = EXCLUDED.reserved_micro_usd`,
      [reserved],
    );
    return;
  }

  await db.pool.query(
    `
INSERT INTO model_spend_days (tenant_id, scope_kind, scope_id, utc_day, reserved_micro_usd, turns_started)
VALUES ($1, $2, $3, (clock_timestamp() AT TIME ZONE 'UTC')::date, $4, 0)
ON CONFLICT (tenant_id, scope_kind, scope_id, utc_day)
DO UPDATE SET reserved_micro_usd = EXCLUDED.reserved_micro_usd`,
    [
      fixture.tenantId,
      bucket,
      bucket === 'tenant' ? fixture.tenantId : fixture.principalId,
      reserved,
    ],
  );
}

async function clearGlobalSpend(): Promise<void> {
  await db.pool.query(
    "DELETE FROM model_global_spend_days WHERE utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date",
  );
}

// One schema for the whole file: the two suites below share a database on purpose, so the money
// ledger observations are made against the same cluster the writes went to.
beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 16 });
  const version = await db.pool.query<{ readonly server_version_num: string }>(
    'SHOW server_version_num',
  );
  const versionNumber = Number(version.rows[0]?.server_version_num ?? 0);
  expect(versionNumber).toBeGreaterThanOrEqual(170000);
  expect(versionNumber).toBeLessThan(180000);

  repository = new PostgresModelTurnExecutionRepository(db.pool);
  b1Repository = new PostgresB1AssistantTurnRepository(db.pool);
  writer = new PostgresB1ConversationWriteRepository(db.pool);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('B2 real model Turn runtime on PostgreSQL 17', () => {
  it('1. publishes one live reply marked simulated:false and books its real cost', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const gateway = new ScriptedGateway(['ok'], 'a reply from a live model');

    const summary = await makeResponder(gateway).processOnce();

    expect(summary.completed).toBe(1);
    expect(gateway.inputs).toHaveLength(1);

    const turn = await readTurnRow(fixture);
    const messages = await readEmberMessages(fixture);
    const attempts = await readAttempts(fixture);
    const spend = await readSpend(fixture);

    expect(turn.status).toBe('completed');
    expect(turn.failure_reason).toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: 'a reply from a live model',
      model_label: REAL_MODEL_LABEL,
      simulated: false,
    });
    expect(turn.response_message_id).toBe(messages[0]?.id);

    // The attempt ledger is the canonical paid operation, and it carries the pinned model identity.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt_no: 1,
      state: 'settled',
      outcome_code: 'ok',
      provider_id: 'openai',
      model_label: REAL_MODEL_LABEL,
      rate_version: RATE.rateVersion,
      observed_cost_micro_usd: String(OBSERVED_COST),
      applied_cost_micro_usd: String(OBSERVED_COST),
    });
    expect(attempts[0]?.send_started_at).not.toBeNull();

    // Nothing is left reserved: the reservation was converted into consumed money exactly.
    expect(spend.global).toMatchObject({ reserved: 0, consumed: OBSERVED_COST });
    // The 60-per-day paid-Turn allowance is a principal limit; the tenant bucket tracks money only.
    expect(spend.tenant).toMatchObject({ reserved: 0, consumed: OBSERVED_COST, turnsStarted: 0 });
    expect(spend.principal).toMatchObject({ consumed: OBSERVED_COST, turnsStarted: 1 });
  });

  it('2. lets only one of two workers holding the same candidate claim it', async () => {
    const fixture = await createFixture();
    const gateway = new ScriptedGateway(['ok', 'ok']);
    const workerA = makeResponder(gateway, { workerId: 'worker-a' });
    const workerB = makeResponder(gateway, { workerId: 'worker-b' });

    const [a, b] = await Promise.all([workerA.processOnce(), workerB.processOnce()]);
    const turn = await readTurnRow(fixture);

    // Exactly one worker completes. The other either saw the lease already taken (skipped) or
    // listed nothing at all, because the winner had already claimed before its scan ran.
    expect(a.completed + b.completed).toBe(1);
    expect(a.examined + b.examined).toBeGreaterThanOrEqual(1);
    expect(a.failed + b.failed + a.timedOut + b.timedOut + a.budgetDenied + b.budgetDenied).toBe(0);
    // One claim, therefore at most one outbound start, therefore at most one paid request.
    expect(gateway.inputs).toHaveLength(1);
    expect(turn.claim_count).toBe('1');
    expect(turn.lease_epoch).toBe('1');
    expect(await readEmberMessages(fixture)).toHaveLength(1);
  });

  it('3. collapses two concurrent identical submissions into one Turn and one reply', async () => {
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'dup test']);
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
      [agentId, tenantId, 'dup agent'],
    );
    await db.pool.query(
      "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
      [conversationId, tenantId, agentId],
    );

    const submissionId = randomUUID();
    const submit = () =>
      writer.submitUserMessage({
        tenantId,
        conversationId,
        request: { client_submission_id: submissionId, text: SOURCE_TEXT, transcript_epoch: 0 },
      });

    const [first, second] = await Promise.all([submit(), submit()]);

    expect(first.receipt.turn.turn_id).toBe(second.receipt.turn.turn_id);
    expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);

    const fixture: Fixture = {
      tenantId,
      principalId,
      conversationId,
      turnId: first.receipt.turn.turn_id,
      sourceMessageId: first.receipt.message.message_id,
    };
    const summary = await makeResponder(new ScriptedGateway(['ok'])).processOnce();

    expect(summary.completed).toBe(1);
    expect(await readEmberMessages(fixture)).toHaveLength(1);
    expect((await readTurnRow(fixture)).claim_count).toBe('1');
  });

  it('4. keeps the reservation when the provider times out, and never publishes text', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const gateway = new ScriptedGateway(['model_timeout', 'model_timeout']);

    const summary = await makeResponder(gateway).processOnce();

    expect(summary.timedOut).toBe(1);
    const turn = await readTurnRow(fixture);
    const attempts = await readAttempts(fixture);
    const spend = await readSpend(fixture);

    expect(turn.status).toBe('failed');
    expect(turn.failure_reason).toBe('timeout');
    expect(await readEmberMessages(fixture)).toHaveLength(1);
    expect(attempts.map((attempt) => attempt.state)).toStrictEqual([
      'unknown_billed',
      'unknown_billed',
    ]);
    expect(attempts.every((attempt) => attempt.outcome_code === 'model_timeout')).toBe(true);
    // An unknown charge is not a free charge: every reservation is still held.
    const reservedTotal = attempts.reduce(
      (total, attempt) => total + Number(attempt.reserved_micro_usd),
      0,
    );
    expect(spend.global).toMatchObject({ reserved: reservedTotal, consumed: 0 });
  });

  it('5. retries a provider 5xx once and keeps both attempt records', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const gateway = new ScriptedGateway(['model_unavailable', 'ok'], 'a reply after a retry');

    const summary = await makeResponder(gateway).processOnce();

    expect(summary.completed).toBe(1);
    expect(gateway.inputs).toHaveLength(2);

    const attempts = await readAttempts(fixture);
    const messages = await readEmberMessages(fixture);

    expect(attempts.map((attempt) => attempt.state)).toStrictEqual(['unknown_billed', 'settled']);
    expect(attempts.map((attempt) => attempt.outcome_code)).toStrictEqual([
      'model_unavailable',
      'ok',
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('a reply after a retry');
    expect((await readTurnRow(fixture)).status).toBe('completed');
  });

  it('6. discards an in-flight reply when the Turn is cancelled during inference', async () => {
    const fixture = await createFixture();
    const gateway = new DeferredGateway('a reply that arrives too late');

    const loop = makeResponder(gateway).processOnce();
    await gateway.entered;
    await b1Repository.cancelTurn(identity(fixture));
    gateway.release();

    const summary = await loop;
    const turn = await readTurnRow(fixture);
    const attempts = await readAttempts(fixture);

    // The money is real — the request may have reached the provider — but the text is discarded.
    expect(summary.fenced).toBe(1);
    expect(turn.status).toBe('cancelled');
    expect(await readEmberMessages(fixture)).toHaveLength(0);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'settled', outcome_code: 'ok' });
  });

  it('7. recovers an abandoned Turn after the crashed worker lease expires', async () => {
    const fixture = await createFixture();
    const crashed = new DeferredGateway();
    const shutdown = new AbortController();

    const abandoned = await (async () => {
      const loop = makeResponder(crashed, { workerId: 'worker-crashed', leaseMs: 1_000 })
        .processOnce(shutdown.signal)
        .then((summary) => summary);

      await crashed.entered;
      shutdown.abort();

      return await loop;
    })();

    expect(abandoned.skipped).toBe(1);
    expect((await readTurnRow(fixture)).status).toBe('running');
    expect(await readEmberMessages(fixture)).toHaveLength(0);

    // While the dead worker's lease is live the Turn is invisible to every other worker.
    expect((await readTurnRow(fixture)).lease_owner).toBe('worker-crashed');
    expect((await repository.listRunningTurns()).map((turn) => turn.turnId)).not.toContain(
      fixture.turnId,
    );

    // Lease expiry is the only thing needed to make it claimable again — no manual repair.
    await db.pool.query(
      "UPDATE assistant_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [fixture.turnId],
    );

    const restarted = makeResponder(new ScriptedGateway(['ok'], 'reply after restart'), {
      workerId: 'worker-restarted',
    });
    const summary = await restarted.processOnce();

    expect(summary.completed).toBe(1);
    const turn = await readTurnRow(fixture);
    expect(turn.status).toBe('completed');
    // Completing the Turn releases the lease but keeps the epoch that published it.
    expect(turn.lease_owner).toBeNull();
    expect(turn.lease_expires_at).toBeNull();
    expect(turn.lease_epoch).toBe('2');
    expect(await readEmberMessages(fixture)).toHaveLength(1);

    // The abandoned attempt stays pessimistically billed; the recovery uses the next attempt number.
    const attempts = await readAttempts(fixture);
    expect(attempts.map((attempt) => attempt.attempt_no)).toStrictEqual([1, 2]);
    expect(attempts[0]).toMatchObject({
      state: 'unknown_billed',
      outcome_code: 'client_cancelled',
    });
    expect(attempts[1]).toMatchObject({ state: 'settled', outcome_code: 'ok' });
  });

  it('8. refuses a stale worker output after its lease is taken over', async () => {
    const fixture = await createFixture();
    const stale = new DeferredGateway('a stale reply from an evicted worker');

    const staleLoop = makeResponder(stale, { workerId: 'worker-stale' }).processOnce();
    await stale.entered;

    // Another worker takes the lease while the first one is still waiting on the provider.
    await db.pool.query(
      "UPDATE assistant_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [fixture.turnId],
    );
    const claimant = await repository.claimTurn({
      turn: identity(fixture),
      workerId: 'worker-takeover',
      leaseMs: 30_000,
    });

    expect(claimant.kind).toBe('claimed');
    if (claimant.kind !== 'claimed') return;
    expect(claimant.lease.leaseEpoch).toBe(2);

    stale.release();
    expect((await staleLoop).fenced).toBe(1);

    expect((await readTurnRow(fixture)).status).toBe('running');
    expect(await readEmberMessages(fixture)).toHaveLength(0);

    const published = await repository.publishCompletion({
      lease: claimant.lease,
      result: {
        status: 'completed',
        text: 'the takeover reply',
        modelLabel: REAL_MODEL_LABEL,
        simulated: false,
      },
    });

    expect(published.outcome).toBe('published');
    const messages = await readEmberMessages(fixture);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('the takeover reply');
  });

  it('9a. hard-refuses at the global ceiling without any provider call or attempt row', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    await seedSpend('global', fixture, CEILINGS.globalDailyMicroUsd - 1);
    const gateway = new ScriptedGateway(['ok']);

    const summary = await makeResponder(gateway).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(await readAttempts(fixture)).toHaveLength(0);
    expect((await readTurnRow(fixture)).status).toBe('failed');
    expect(await readSpend(fixture)).toMatchObject({
      global: { consumed: 0 },
      tenant: null,
      principal: null,
    });
  });

  it('9b. hard-refuses at the tenant ceiling before opening an attempt', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    await seedSpend('tenant', fixture, CEILINGS.tenantDailyMicroUsd - 1);
    const gateway = new ScriptedGateway(['ok']);

    const summary = await makeResponder(gateway).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(await readAttempts(fixture)).toHaveLength(0);
    // The global bucket was never touched, so the rollback covered the whole reservation.
    expect((await readSpend(fixture)).principal).toBeNull();
  });

  it('9c. hard-refuses at the principal ceiling and leaves no partial reservation behind', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    await seedSpend('principal', fixture, CEILINGS.principalDailyMicroUsd - 1);
    const before = await readSpend(fixture);
    const gateway = new ScriptedGateway(['ok']);

    const summary = await makeResponder(gateway).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(await readAttempts(fixture)).toHaveLength(0);

    const after = await readSpend(fixture);
    // Global and tenant were reserved first in lock order, then rolled back with the attempt.
    expect(after.global).toStrictEqual(before.global);
    expect(after.tenant).toStrictEqual(before.tenant);
    expect(after.principal).toStrictEqual(before.principal);
  });

  it('9d. denies a paid call when the principal turn allowance is exhausted', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const ceilings: ModelBudgetCeilings = { ...CEILINGS, principalDailyTurns: 0 };
    const gateway = new ScriptedGateway(['ok']);

    const summary = await makeResponder(gateway, { ceilings }).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(await readAttempts(fixture)).toHaveLength(0);
  });

  it('10. refuses to boot real mode without a credential, an approved model or a verified rate', () => {
    const approvedOnly = {
      models: [
        {
          providerId: 'openai' as const,
          modelId: REAL_MODEL_LABEL,
          approval: {
            approvalId: 'IT-A1',
            approvedBy: 'integration fixture',
            approvedAt: '2026-01-01',
            expiresAt: '2099-12-31',
          },
        },
      ],
      rates: [RATE],
    };

    // The shipped registry approves no real model at all: real is off in code, not by environment.
    expect(
      resolveModelExecution({ mode: 'real', providerId: 'openai', modelId: REAL_MODEL_LABEL }),
    ).toMatchObject({ ok: false, reason: 'model_not_approved' });

    expect(
      resolveModelExecution(
        { mode: 'real', providerId: 'openai', modelId: REAL_MODEL_LABEL, apiKey: undefined },
        approvedOnly,
      ),
    ).toMatchObject({ ok: false, reason: 'credential_missing' });

    expect(
      resolveModelExecution(
        {
          mode: 'real',
          providerId: 'openai',
          modelId: REAL_MODEL_LABEL,
          apiKey: 'sk-REPLACE-WITH-REAL-KEY',
        },
        approvedOnly,
      ),
    ).toMatchObject({ ok: false, reason: 'credential_placeholder' });

    // A verified key still cannot run against an unverified price.
    expect(
      resolveModelExecution(
        {
          mode: 'real',
          providerId: 'openai',
          modelId: REAL_MODEL_LABEL,
          apiKey: 'sk-test-key-0123456789abcdef',
        },
        { models: approvedOnly.models, rates: [{ ...RATE, provenance: 'unverified' }] },
      ),
    ).toMatchObject({ ok: false, reason: 'rate_not_verified' });

    const resolved = resolveModelExecution(
      {
        mode: 'real',
        providerId: 'openai',
        modelId: REAL_MODEL_LABEL,
        apiKey: 'sk-test-key-0123456789abcdef',
      },
      approvedOnly,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Even a fully approved resolution carries a redacted credential.
    expect(JSON.stringify(resolved.settings)).not.toContain('sk-test-key');
  });

  it('10b. keeps the worker process dead when real mode is requested without a credential', () => {
    expect(() =>
      loadWorkerConfig({ EMBER_MODEL_EXECUTION: 'real', EMBER_MODEL_ID: REAL_MODEL_LABEL }),
    ).toThrow(/refused/);

    expect(() => loadWorkerConfig({ EMBER_MODEL_EXECUTION: 'real' })).toThrow(/refused/);
    expect(loadWorkerConfig({}).model).toMatchObject({ ok: true, mode: 'disabled' });
    expect(loadWorkerConfig({ EMBER_MODEL_EXECUTION: 'fake' }).model).toMatchObject({
      ok: true,
      mode: 'fake',
    });

    // One Turn, one responder: the two cannot both be enabled.
    expect(() =>
      loadWorkerConfig({
        EMBER_MODEL_EXECUTION: 'fake',
        EMBER_B1_FAKE_RESPONDER_ENABLED: 'true',
      }),
    ).toThrow(/exactly one responder/);
  });

  it('11. survives a PostgreSQL disconnect without corrupting the Turn', async () => {
    const fixture = await createFixture();
    const config = loadDatabaseConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? '' });

    // (a) An unreachable database surfaces as a retryable domain error, never as driver text.
    const unreachable = createPool({
      ...config,
      maxConnections: 1,
      connectionTimeoutMs: 1_000,
      searchPath: db.schema,
      connectionString: 'postgres://ember:ember_local_dev_only@127.0.0.1:1/ember_test',
    });

    try {
      let caught: unknown;
      try {
        await new PostgresModelTurnExecutionRepository(unreachable).listRunningTurns();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('DB_UNAVAILABLE');
      expect((caught as DomainError).publicMessage).not.toContain('ember_local_dev_only');
      expect((caught as DomainError).publicMessage).not.toContain('127.0.0.1');
    } finally {
      await unreachable.end().catch(() => undefined);
    }

    // (b) A session killed mid-flight fails its own query, and the Turn is untouched by it.
    const fragilePool = createPool({ ...config, maxConnections: 1, searchPath: db.schema });

    try {
      const client = await fragilePool.connect();
      const pid = await backendPid(client);
      await db.adminPool.query('SELECT pg_terminate_backend($1)', [pid]);

      await expect(client.query('SELECT 1')).rejects.toThrow();
      client.release();

      expect((await readTurnRow(fixture)).status).toBe('running');
      expect(await readAttempts(fixture)).toHaveLength(0);
    } finally {
      await fragilePool.end().catch(() => undefined);
    }

    // The pool reconnects on its own: the Turn is completed with no manual repair.
    const summary = await makeResponder(
      new ScriptedGateway(['ok'], 'reply after reconnect'),
    ).processOnce();

    expect(summary.completed).toBe(1);
    expect((await readTurnRow(fixture)).status).toBe('completed');
    expect(await readEmberMessages(fixture)).toHaveLength(1);
  });

  it('12. never produces a second assistant Message for one Turn', async () => {
    const fixture = await createFixture();
    const gateway = new ScriptedGateway(['ok'], 'the only reply');

    await makeResponder(gateway).processOnce();
    const first = await readEmberMessages(fixture);
    expect(first).toHaveLength(1);

    // Re-running the responder over a completed Turn must find no candidate to claim.
    const replay = await makeResponder(gateway).processOnce();
    expect(replay.examined).toBe(0);

    // A late publisher holding the original fence is refused as well.
    const staleLease = {
      ...identity(fixture),
      leaseEpoch: 1,
      leaseOwner: 'worker-b2-test',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const late = await repository.publishCompletion({
      lease: staleLease,
      result: {
        status: 'completed',
        text: 'a duplicate that must never be stored',
        modelLabel: REAL_MODEL_LABEL,
        simulated: false,
      },
    });

    expect(late.outcome).toBe('fenced');
    const messages = await readEmberMessages(fixture);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStrictEqual(first[0]);
  });

  it('13. holds no PostgreSQL client while the provider call is in flight', async () => {
    const fixture = await createFixture();
    let checkedOut: number | null = null;
    let waiting = 0;

    const gateway: ModelGateway = {
      providerId: 'openai',
      modelLabel: REAL_MODEL_LABEL,
      simulated: false,
      operations: ['conversation.turn'] as const,
      generateConversationTurn() {
        // Sampled at the exact moment the paid request would be on the wire.
        checkedOut = db.pool.totalCount - db.pool.idleCount;
        waiting = db.pool.waitingCount;

        return Promise.resolve({
          output: { text: 'no transaction was held', finishReason: 'stop' as const },
          modelLabel: REAL_MODEL_LABEL,
          simulated: false as const,
          usage: {
            inputTokens: 40,
            outputTokens: 20,
            costMicroUsd: OBSERVED_COST,
            rateVersion: RATE.rateVersion,
          },
        });
      },
    };

    const summary = await makeResponder(gateway).processOnce();

    expect(summary.completed).toBe(1);
    expect(checkedOut).toBe(0);
    expect(waiting).toBe(0);
    expect((await readTurnRow(fixture)).status).toBe('completed');
  });

  it('14. keeps the default responder inert when real execution is disabled', async () => {
    await clearGlobalSpend();
    const fixture = await createFixture();
    const fake = createModelGateway(resolveModelExecution({ mode: 'fake' }));

    const summary = await makeResponder(fake, { mode: 'fake' }).processOnce();
    const messages = await readEmberMessages(fixture);
    const attempts = await readAttempts(fixture);

    expect(summary.completed).toBe(1);
    // The simulated path is visibly labelled and never creates a paid attempt.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.simulated).toBe(true);
    expect(messages[0]?.model_label).toMatch(/-(fake|echo)-/);
    expect(attempts).toHaveLength(0);
    // Stronger than "zero": the fake path never writes a spend row at all.
    expect((await readSpend(fixture)).global).toBeNull();
  });

  it('15. refuses to store a real label with simulated:true at the persistence boundary', async () => {
    const fixture = await createFixture();
    const lease = {
      ...identity(fixture),
      leaseEpoch: 1,
      leaseOwner: 'worker-b2-test',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    await repository.claimTurn({
      turn: identity(fixture),
      workerId: 'worker-b2-test',
      leaseMs: 30_000,
    });

    await expect(
      repository.publishCompletion({
        lease,
        result: {
          status: 'completed',
          text: 'a mislabelled reply',
          modelLabel: REAL_MODEL_LABEL,
          simulated: true,
        },
      }),
    ).rejects.toThrow();

    await expect(
      repository.publishCompletion({
        lease,
        result: {
          status: 'completed',
          text: 'a mislabelled simulation',
          modelLabel: 'ember-echo-1',
          simulated: false,
        },
      }),
    ).rejects.toThrow();

    expect(await readEmberMessages(fixture)).toHaveLength(0);
  });
});

/**
 * The invariants a reviewer should not have to trust the TypeScript for.
 *
 * Each case writes around the repository and asserts that the database itself refuses the state.
 */
describe('0014 database guards on PostgreSQL 17', () => {
  async function insertAttempt(
    fixture: Fixture,
    overrides: {
      readonly attemptNo: number;
      readonly state?: string;
      readonly outcomeCode?: string | null;
      readonly appliedCost?: number | null;
      readonly settled?: boolean;
      readonly reserved?: number;
    },
  ): Promise<void> {
    await db.pool.query(
      `
INSERT INTO model_turn_attempts
       (tenant_id, turn_id, attempt_no, operation_id, principal_id, utc_day,
        provider_id, model_label, rate_version, state, outcome_code,
        reserved_micro_usd, applied_cost_micro_usd, settled_at)
VALUES ($1, $2, $3, $4, $5, (clock_timestamp() AT TIME ZONE 'UTC')::date,
        'openai', $6, $7, $8, $9, $10, $11,
        CASE WHEN $12 THEN clock_timestamp() ELSE NULL END)`,
      [
        fixture.tenantId,
        fixture.turnId,
        overrides.attemptNo,
        randomUUID(),
        fixture.principalId,
        REAL_MODEL_LABEL,
        RATE.rateVersion,
        overrides.state ?? 'reserved',
        overrides.outcomeCode ?? null,
        overrides.reserved ?? 1_000,
        overrides.appliedCost ?? null,
        overrides.settled ?? false,
      ],
    );
  }

  it('refuses a third attempt, so a crash loop cannot become an unbounded invoice', async () => {
    const fixture = await createFixture();

    await expect(insertAttempt(fixture, { attemptNo: 3 })).rejects.toThrow(/attempt_no/);
  });

  it('refuses a settled attempt without a booked cost or an outcome code', async () => {
    const fixture = await createFixture();

    await expect(
      insertAttempt(fixture, { attemptNo: 1, state: 'settled', settled: true }),
    ).rejects.toThrow(/state_shape/);

    await expect(
      insertAttempt(fixture, {
        attemptNo: 2,
        state: 'settled',
        settled: true,
        outcomeCode: 'ok',
      }),
    ).rejects.toThrow(/state_shape/);

    expect(await readAttempts(fixture)).toHaveLength(0);
  });

  it('refuses a released attempt that claims a non-zero booked cost', async () => {
    const fixture = await createFixture();

    await expect(
      insertAttempt(fixture, {
        attemptNo: 1,
        state: 'released',
        settled: true,
        outcomeCode: 'not_sent',
        appliedCost: 5,
      }),
    ).rejects.toThrow(/state_shape/);
  });

  it('refuses an unknown provider rather than storing an unreviewed one', async () => {
    const fixture = await createFixture();

    await expect(
      db.pool.query(
        `
INSERT INTO model_turn_attempts
       (tenant_id, turn_id, attempt_no, operation_id, principal_id, utc_day,
        provider_id, model_label, rate_version, state, reserved_micro_usd)
VALUES ($1, $2, 1, $3, $4, (clock_timestamp() AT TIME ZONE 'UTC')::date,
        'anthropic', $5, $6, 'reserved', 1000)`,
        [
          fixture.tenantId,
          fixture.turnId,
          randomUUID(),
          fixture.principalId,
          REAL_MODEL_LABEL,
          RATE.rateVersion,
        ],
      ),
    ).rejects.toThrow(/provider_check/);
  });

  it('refuses a per-day bucket above the absolute ceiling', async () => {
    const fixture = await createFixture();

    await expect(
      db.pool.query(
        `
INSERT INTO model_spend_days (tenant_id, scope_kind, scope_id, utc_day, reserved_micro_usd)
VALUES ($1, 'principal', $2, (clock_timestamp() AT TIME ZONE 'UTC')::date, 250001)`,
        [fixture.tenantId, fixture.principalId],
      ),
    ).rejects.toThrow(/absolute_ceiling/);

    await expect(
      db.pool.query(
        `
INSERT INTO model_spend_days (tenant_id, scope_kind, scope_id, utc_day, reserved_micro_usd)
VALUES ($1, 'tenant', $2, (clock_timestamp() AT TIME ZONE 'UTC')::date, 1000001)`,
        [fixture.tenantId, fixture.tenantId],
      ),
    ).rejects.toThrow(/absolute_ceiling/);

    await expect(
      db.pool.query(
        `
INSERT INTO model_global_spend_days (utc_day, reserved_micro_usd)
VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date, 5000001)`,
      ),
    ).rejects.toThrow(/budget_check/);
  });

  it('refuses a half-cleared lease, which the fencing protocol cannot reason about', async () => {
    const fixture = await createFixture();

    await expect(
      db.pool.query("UPDATE assistant_turns SET lease_owner = 'worker-x' WHERE id = $1", [
        fixture.turnId,
      ]),
    ).rejects.toThrow(/lease_state_check/);
  });

  it('keeps the day buckets when a deleted transcript cascades its Turns away', async () => {
    const fixture = await createFixture();
    // A wide batch so the scan cannot be exhausted by Turns this suite left behind on purpose.
    await makeResponder(new ScriptedGateway(['ok']), { batchSize: 50 }).processOnce();

    // The tenant and principal buckets are this fixture's own, so they are exact.
    const before = await readSpend(fixture);
    expect(before.tenant).toMatchObject({ consumed: OBSERVED_COST });
    expect(before.principal).toMatchObject({ consumed: OBSERVED_COST });

    await db.pool.query('DELETE FROM assistant_turns WHERE tenant_id = $1 AND id = $2', [
      fixture.tenantId,
      fixture.turnId,
    ]);

    // The attempt row is gone with its Turn; the money it spent is the durable record and stays.
    expect(await readAttempts(fixture)).toHaveLength(0);
    const after = await readSpend(fixture);
    expect(after.tenant).toStrictEqual(before.tenant);
    expect(after.principal).toStrictEqual(before.principal);
  });
});
