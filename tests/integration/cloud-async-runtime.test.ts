import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FAKE_MODEL_LABEL, FAKE_REPLY_PREFIX, type ModelGateway } from '@ember/model-gateway';
import {
  B1_ASSISTANT_TURN_MODEL_LABEL,
  PostgresB1AssistantTurnRepository,
} from '../../packages/postgres/src/repositories/b1-assistant-turn-repository.js';
import { PostgresB1ConversationReadRepository } from '../../packages/postgres/src/repositories/b1-conversation-read.js';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import {
  insertB1TurnDispatchOutbox,
  PostgresB1TurnDispatchOutboxRepository,
} from '../../packages/postgres/src/repositories/b1-turn-dispatch-outbox.js';
import { resolveCloudRuntimeModelConfig } from '../../apps/cloud-async-runtime/src/config.js';
import cloudAsyncRuntime from '../../apps/cloud-async-runtime/src/index.js';
import {
  consumeTurnDispatchMessage,
  type TurnDispatchQueueMessage,
} from '../../apps/cloud-async-runtime/src/dispatch.js';
import { createTurnExecutor } from '../../apps/cloud-async-runtime/src/runtime.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

interface Fixture {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly turnId: string;
}

class QueueDelivery implements TurnDispatchQueueMessage {
  readonly attempts = 1;
  ackCount = 0;
  retryCount = 0;
  retryOptions: { readonly delaySeconds?: number } | undefined;

  constructor(readonly body: unknown) {}

  ack(): void {
    this.ackCount += 1;
  }

  retry(options?: { readonly delaySeconds?: number }): void {
    this.retryCount += 1;
    this.retryOptions = options;
  }
}

let db: TestDatabase;
let outbox: PostgresB1TurnDispatchOutboxRepository;
let turns: PostgresB1AssistantTurnRepository;
let conversations: PostgresB1ConversationReadRepository;
let writer: PostgresB1ConversationWriteRepository;
const model = resolveCloudRuntimeModelConfig({
  EMBER_ENV: 'test',
  NODE_ENV: 'test',
  EMBER_MODEL_EXECUTION: 'fake',
});
const TEST_MODEL_KEY = 'sk-test-cloud-staging-alpha-abcdefghijklmnopqrstuvwxyz';

async function createFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'runtime E2E']);
  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, 'runtime E2E agent'],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );
  const submitted = await writer.submitUserMessage({
    tenantId,
    conversationId,
    request: {
      client_submission_id: randomUUID(),
      text: 'A local test message for the cloud runtime path.',
      transcript_epoch: 0,
    },
  });

  return {
    tenantId,
    conversationId,
    turnId: submitted.receipt.turn.turn_id,
  };
}

async function enqueueOutbox(fixture: Fixture): Promise<void> {
  if ((await outbox.getEvent(fixture.turnId)) !== null) {
    return;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await insertB1TurnDispatchOutbox(client, {
      tenantId: fixture.tenantId,
      turnId: fixture.turnId,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readAssistantMessages(fixture: Fixture) {
  const page = await conversations.readMessages({
    tenantId: fixture.tenantId,
    conversationId: fixture.conversationId,
    after: 0,
    limit: 20,
  });
  return page.messages.filter((message) => message.kind === 'ember');
}

function cloudRuntimeEnv(sent: unknown[]) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('TEST_DATABASE_URL is required for the cloud runtime integration test');
  }

  const connectionUrl = new URL(databaseUrl);
  const existingOptions = connectionUrl.searchParams.get('options');
  connectionUrl.searchParams.set(
    'options',
    [existingOptions, `-c search_path=${db.schema}`].filter(Boolean).join(' '),
  );

  return {
    HYPERDRIVE: { connectionString: connectionUrl.toString() },
    TURN_DISPATCH_QUEUE: {
      send: (message: unknown) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    EMBER_ENV: 'test',
    NODE_ENV: 'test',
    EMBER_MODEL_EXECUTION: 'fake',
    EMBER_TURN_DISPATCH_QUEUE_NAME: 'ember-test-assistant-turns',
    EMBER_TURN_DISPATCH_DLQ_NAME: 'ember-test-assistant-turns-dlq',
  };
}

async function runScheduledRelay(env: ReturnType<typeof cloudRuntimeEnv>): Promise<void> {
  let scheduledWork: Promise<unknown> | undefined;
  cloudAsyncRuntime.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, {
    waitUntil(promise) {
      scheduledWork = promise;
    },
  });

  if (scheduledWork === undefined) {
    throw new Error('the Worker did not register its scheduled relay');
  }

  await scheduledWork;
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 12 });
  outbox = new PostgresB1TurnDispatchOutboxRepository(db.pool);
  turns = new PostgresB1AssistantTurnRepository(db.pool);
  conversations = new PostgresB1ConversationReadRepository(db.pool);
  writer = new PostgresB1ConversationWriteRepository(db.pool, {
    writeTurnDispatchOutbox: true,
  });
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('Cloud Async Runtime on PostgreSQL', () => {
  it('authorizes only the first post-watermark Turn in one approved Conversation', async () => {
    const fixture = await createFixture();
    await db.pool.query(
      `UPDATE assistant_turns
          SET created_at = clock_timestamp() - interval '1 minute'
        WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3`,
      [fixture.tenantId, fixture.conversationId, fixture.turnId],
    );
    const watermarkResult = await db.pool.query<{ readonly created_after: Date }>(
      `SELECT clock_timestamp() - interval '1 second' AS created_after`,
    );
    const createdAfter = watermarkResult.rows[0]?.created_after.toISOString();
    if (createdAfter === undefined) throw new Error('database watermark was not returned');

    const submitAfterWatermark = async (text: string): Promise<string> => {
      const submitted = await writer.submitUserMessage({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        request: {
          client_submission_id: randomUUID(),
          text,
          transcript_epoch: 0,
        },
      });
      return submitted.receipt.turn.turn_id;
    };
    const firstApprovedTurnId = await submitAfterWatermark('First synthetic Alpha Turn.');
    const laterTurnId = await submitAfterWatermark('Later synthetic Alpha Turn.');

    const alphaModel = resolveCloudRuntimeModelConfig(
      {
        EMBER_ENV: 'staging',
        NODE_ENV: 'staging',
        EMBER_MODEL_EXECUTION: 'real',
        EMBER_MODEL_PROVIDER: 'openrouter',
        EMBER_MODEL_ID: 'nvidia/nemotron-3.5-lightning',
        EMBER_MODEL_API_KEY: TEST_MODEL_KEY,
        EMBER_MODEL_ALPHA_TENANT_ID: fixture.tenantId,
        EMBER_MODEL_ALPHA_CONVERSATION_ID: fixture.conversationId,
        EMBER_MODEL_ALPHA_TURN_CREATED_AFTER: createdAfter,
      },
      'staging_alpha',
      new Date('2026-11-12T12:00:00.000Z'),
    );
    expect(alphaModel.kind).toBe('enabled');
    if (alphaModel.kind !== 'enabled' || alphaModel.mode !== 'real') return;

    const neverCalledGateway: ModelGateway = {
      providerId: 'openrouter',
      modelLabel: 'nvidia/nemotron-3.5-lightning',
      simulated: false,
      operations: ['conversation.turn'],
      generateConversationTurn() {
        throw new Error('the integration test must not call a Provider');
      },
    };
    const makeExecutor = async (turnId: string) => {
      const persistedEvent = await outbox.getEvent(turnId);
      if (persistedEvent === null) throw new Error('outbox event was not found');
      return createTurnExecutor({
        pool: db.pool,
        model: alphaModel,
        event: persistedEvent,
        workerId: 'cloud-runtime-alpha-authorization',
        gateway: neverCalledGateway,
      });
    };

    expect(
      await outbox.getFirstTurnCreatedAfter({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        createdAfter,
      }),
    ).toBe(firstApprovedTurnId);
    expect(await makeExecutor(fixture.turnId)).toBeNull();
    expect(await makeExecutor(firstApprovedTurnId)).not.toBeNull();
    expect(await makeExecutor(laterTurnId)).toBeNull();

    await turns.finishTurn({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      turnId: firstApprovedTurnId,
      result: {
        status: 'completed',
        text: 'Local integration fixture only.',
        modelLabel: B1_ASSISTANT_TURN_MODEL_LABEL,
        simulated: true,
      },
    });
    expect(
      await outbox.getFirstTurnCreatedAfter({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        createdAfter,
      }),
    ).toBe(firstApprovedTurnId);
    expect(await makeExecutor(laterTurnId)).toBeNull();

    for (const turnId of [fixture.turnId, laterTurnId]) {
      await turns.cancelTurn({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId,
      });
    }
  });

  it('runs the Worker relay and Queue entrypoints with Fake Model and B1 reads', async () => {
    const fixture = await createFixture();
    const persistedEvent = await outbox.getEvent(fixture.turnId);
    expect(persistedEvent).toMatchObject({
      eventId: fixture.turnId,
      tenantId: fixture.tenantId,
      turnId: fixture.turnId,
    });

    // Exercise the relay's reconciliation path after the transactional outbox row disappears.
    // Current API writes insert it atomically with the Turn; this protects old writers/recovery.
    await db.pool.query(
      'DELETE FROM b1_turn_dispatch_outbox WHERE tenant_id = $1 AND turn_id = $2',
      [fixture.tenantId, fixture.turnId],
    );
    expect(await outbox.getEvent(fixture.turnId)).toBeNull();

    const sent: unknown[] = [];
    const env = cloudRuntimeEnv(sent);
    await runScheduledRelay(env);
    expect(sent).toHaveLength(1);
    const queuedEnvelope = sent[0] as {
      readonly schemaVersion: number;
      readonly eventId: string;
      readonly tenantId: string;
      readonly turnId: string;
    };
    expect(queuedEnvelope).toEqual({
      schemaVersion: 1,
      eventId: fixture.turnId,
      tenantId: fixture.tenantId,
      turnId: fixture.turnId,
    });
    expect(JSON.stringify(queuedEnvelope)).not.toContain('local test message');

    // A valid event ID cannot borrow a different tenant ID from the Queue body.
    const wrongTenant = new QueueDelivery({ ...queuedEnvelope, tenantId: randomUUID() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await cloudAsyncRuntime.queue(
        { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [wrongTenant] },
        env,
      );
    } finally {
      warn.mockRestore();
    }
    expect(wrongTenant.ackCount).toBe(1);
    expect(
      (
        await turns.getTurn({
          tenantId: fixture.tenantId,
          conversationId: fixture.conversationId,
          turnId: fixture.turnId,
        })
      )?.status,
    ).toBe('running');
    expect(await readAssistantMessages(fixture)).toHaveLength(0);

    // A live PostgreSQL lease causes a real Queue retry. Once that lease expires, redelivery
    // claims the same Turn and completes it through the Worker handler.
    await db.pool.query(
      `UPDATE assistant_turns
          SET lease_epoch = 1,
              lease_owner = 'integration-held-lease',
              lease_expires_at = clock_timestamp() + interval '5 seconds'
        WHERE tenant_id = $1 AND id = $2`,
      [fixture.tenantId, fixture.turnId],
    );
    const waiting = new QueueDelivery(queuedEnvelope);
    await cloudAsyncRuntime.queue(
      { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [waiting] },
      env,
    );
    expect(waiting.ackCount).toBe(0);
    expect(waiting.retryCount).toBe(1);
    expect(waiting.retryOptions?.delaySeconds).toBeGreaterThan(0);
    expect(await readAssistantMessages(fixture)).toHaveLength(0);

    await db.pool.query(
      `UPDATE assistant_turns
          SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2`,
      [fixture.tenantId, fixture.turnId],
    );
    const delivery = new QueueDelivery(queuedEnvelope);
    await cloudAsyncRuntime.queue(
      { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [delivery] },
      env,
    );

    const turn = await turns.getTurn({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      turnId: fixture.turnId,
    });
    const assistantMessages = await readAssistantMessages(fixture);
    expect(turn?.status).toBe('completed');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      model_label: FAKE_MODEL_LABEL,
      simulated: true,
    });
    expect(assistantMessages[0]?.text.startsWith(FAKE_REPLY_PREFIX)).toBe(true);
    expect(delivery.ackCount).toBe(1);

    const duplicate = new QueueDelivery(queuedEnvelope);
    await cloudAsyncRuntime.queue(
      { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [duplicate] },
      env,
    );
    expect(await readAssistantMessages(fixture)).toHaveLength(1);
    expect(duplicate.ackCount).toBe(1);
  });

  it('recovers after a process stops after commit but before Queue acknowledgement', async () => {
    const fixture = await createFixture();
    await enqueueOutbox(fixture);
    const event = await outbox.getEvent(fixture.turnId);
    if (event === null) throw new Error('outbox event was not found');
    const executor = await createTurnExecutor({
      pool: db.pool,
      model,
      event,
      workerId: 'cloud-runtime-crash-recovery',
    });
    const first = new QueueDelivery({
      schemaVersion: 1,
      eventId: fixture.turnId,
      tenantId: fixture.tenantId,
      turnId: fixture.turnId,
    });
    let simulateCrash = true;
    const crashAfterResultCommit = {
      getEvent: (eventId: string) => outbox.getEvent(eventId),
      deferNextDispatch: (eventId: string, delayMs: number) =>
        outbox.deferNextDispatch(eventId, delayMs),
      markCompleted: async (eventId: string) => {
        if (simulateCrash) {
          simulateCrash = false;
          throw new Error('simulated Worker process exit after result commit');
        }
        return outbox.markCompleted(eventId);
      },
      makeDue: (eventId: string, retryAfterMs: number) => outbox.makeDue(eventId, retryAfterMs),
    };

    await expect(
      consumeTurnDispatchMessage(first, { outbox: crashAfterResultCommit, executor }),
    ).rejects.toThrow('simulated Worker process exit after result commit');
    const restarted = new QueueDelivery(first.body);
    await consumeTurnDispatchMessage(restarted, { outbox, executor });

    expect(await readAssistantMessages(fixture)).toHaveLength(1);
    expect(restarted.ackCount).toBe(1);
  });

  it('cancellation during model execution fences the late result', async () => {
    const fixture = await createFixture();
    await enqueueOutbox(fixture);
    const event = await outbox.getEvent(fixture.turnId);
    if (event === null) throw new Error('outbox event was not found');

    let entered!: () => void;
    let release!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const heldResult = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway: ModelGateway = {
      providerId: 'fake',
      modelLabel: FAKE_MODEL_LABEL,
      simulated: true,
      operations: ['conversation.turn'],
      async generateConversationTurn() {
        entered();
        await heldResult;
        return {
          output: { text: `${FAKE_REPLY_PREFIX}late test response`, finishReason: 'stop' },
          modelLabel: FAKE_MODEL_LABEL,
          simulated: true,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            costMicroUsd: 0,
            rateVersion: 'fake-zero-cost',
          },
        };
      },
    };
    const executor = await createTurnExecutor({
      pool: db.pool,
      model,
      event,
      workerId: 'cloud-runtime-cancel-race',
      gateway,
    });
    const delivery = new QueueDelivery({
      schemaVersion: 1,
      eventId: fixture.turnId,
      tenantId: fixture.tenantId,
      turnId: fixture.turnId,
    });
    const processing = consumeTurnDispatchMessage(delivery, { outbox, executor });

    await providerEntered;
    const cancelled = await turns.cancelTurn({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      turnId: fixture.turnId,
    });
    release();
    await processing;

    expect(cancelled.status).toBe('cancelled');
    expect(await readAssistantMessages(fixture)).toHaveLength(0);
    expect(delivery.ackCount).toBe(1);
  });
});
