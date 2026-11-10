import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_MODEL_LABEL, FAKE_REPLY_PREFIX, type ModelGateway } from '@ember/model-gateway';
import { PostgresB1AssistantTurnRepository } from '../../packages/postgres/src/repositories/b1-assistant-turn-repository.js';
import { PostgresB1ConversationReadRepository } from '../../packages/postgres/src/repositories/b1-conversation-read.js';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import {
  insertB1TurnDispatchOutbox,
  PostgresB1TurnDispatchOutboxRepository,
} from '../../packages/postgres/src/repositories/b1-turn-dispatch-outbox.js';
import { resolveCloudRuntimeModelConfig } from '../../apps/cloud-async-runtime/src/config.js';
import {
  consumeTurnDispatchMessage,
  type TurnDispatchQueueMessage,
} from '../../apps/cloud-async-runtime/src/dispatch.js';
import { publishDueTurnDispatches } from '../../apps/cloud-async-runtime/src/relay.js';
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

  constructor(readonly body: unknown) {}

  ack(): void {
    this.ackCount += 1;
  }

  retry(): void {
    this.retryCount += 1;
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

function executorFor(fixture: Fixture, gateway?: ModelGateway) {
  if (model.kind !== 'enabled') {
    throw new Error(`fake test model was unexpectedly refused: ${model.kind}`);
  }

  return outbox.getEvent(fixture.turnId).then((event) => {
    if (event === null) {
      throw new Error('outbox event was not found');
    }

    return createTurnExecutor({
      pool: db.pool,
      model,
      event,
      workerId: 'cloud-runtime-integration',
      ...(gateway === undefined ? {} : { gateway }),
    });
  });
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

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 12 });
  outbox = new PostgresB1TurnDispatchOutboxRepository(db.pool);
  turns = new PostgresB1AssistantTurnRepository(db.pool);
  conversations = new PostgresB1ConversationReadRepository(db.pool);
  writer = new PostgresB1ConversationWriteRepository(db.pool);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('Cloud Async Runtime on PostgreSQL', () => {
  it('self-heals an outbox gap, executes one Turn and returns the reply through B1 reads', async () => {
    const fixture = await createFixture();
    const sent: unknown[] = [];
    const relay = await publishDueTurnDispatches({
      outbox,
      queue: {
        send: (body) => {
          sent.push(body);
          return Promise.resolve();
        },
      },
      workerId: 'cloud-runtime-relay',
    });
    expect(relay).toMatchObject({ claimed: 1, enqueued: 1, failed: 0 });
    expect(sent).toHaveLength(1);

    const executor = await executorFor(fixture);
    const delivery = new QueueDelivery(sent[0]);
    await consumeTurnDispatchMessage(delivery, { outbox, executor });

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

    const duplicate = new QueueDelivery(sent[0]);
    await consumeTurnDispatchMessage(duplicate, { outbox, executor });
    expect(await readAssistantMessages(fixture)).toHaveLength(1);
    expect(duplicate.ackCount).toBe(1);
  });

  it('recovers after a process stops after commit but before Queue acknowledgement', async () => {
    const fixture = await createFixture();
    await enqueueOutbox(fixture);
    const event = await outbox.getEvent(fixture.turnId);
    if (event === null) throw new Error('outbox event was not found');
    const executor = createTurnExecutor({
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
    const executor = createTurnExecutor({
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
