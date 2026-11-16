import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DELEGATE_NOTES_TOOL_NAME,
  FAKE_MODEL_LABEL,
  FAKE_REPLY_PREFIX,
  ModelGatewayFailure,
  type ModelGateway,
} from '@ember/model-gateway';
import {
  B1_ASSISTANT_TURN_MODEL_LABEL,
  PostgresB1AssistantTurnRepository,
} from '../../packages/postgres/src/repositories/b1-assistant-turn-repository.js';
import { PostgresB1ConversationReadRepository } from '../../packages/postgres/src/repositories/b1-conversation-read.js';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { PostgresB1TaskReadRepository } from '../../packages/postgres/src/repositories/b1-task-read-repository.js';
import {
  insertB1TurnDispatchOutbox,
  PostgresB1TurnDispatchOutboxRepository,
} from '../../packages/postgres/src/repositories/b1-turn-dispatch-outbox.js';
import { resolveCloudRuntimeModelConfig } from '../../apps/cloud-async-runtime/src/config.js';
import cloudAsyncRuntime from '../../apps/cloud-async-runtime/src/index.js';
import {
  consumeTaskDispatchMessage,
  consumeTurnDispatchMessage,
  type TurnDispatchQueueMessage,
} from '../../apps/cloud-async-runtime/src/dispatch.js';
import {
  createNotesTaskExecutor,
  createNotesTaskLeaseQueue,
  createTurnExecutor,
} from '../../apps/cloud-async-runtime/src/runtime.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

interface Fixture {
  readonly tenantId: string;
  readonly principalId: string;
  readonly agentId: string;
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
let taskReads: PostgresB1TaskReadRepository;
let writer: PostgresB1ConversationWriteRepository;
const model = resolveCloudRuntimeModelConfig({
  EMBER_ENV: 'test',
  NODE_ENV: 'test',
  EMBER_MODEL_EXECUTION: 'fake',
});
const TEST_MODEL_KEY = 'sk-test-cloud-staging-alpha-abcdefghijklmnopqrstuvwxyz';

async function createFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'runtime E2E']);
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
    principalId,
    agentId,
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
  taskReads = new PostgresB1TaskReadRepository(db.pool);
  writer = new PostgresB1ConversationWriteRepository(db.pool, {
    writeTurnDispatchOutbox: true,
  });
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('Cloud Async Runtime on PostgreSQL', () => {
  it('authorizes configured Staging Alpha allowlist tenants for Turns and Notes Tasks and refuses non-allowlisted tenants', async () => {
    const allowed = await createFixture();
    const foreign = await createFixture();
    const createdTurnIds = [
      {
        tenantId: allowed.tenantId,
        conversationId: allowed.conversationId,
        turnId: allowed.turnId,
      },
      {
        tenantId: foreign.tenantId,
        conversationId: foreign.conversationId,
        turnId: foreign.turnId,
      },
    ];

    try {
      const submittedLater = await writer.submitUserMessage({
        tenantId: allowed.tenantId,
        conversationId: allowed.conversationId,
        request: {
          client_submission_id: randomUUID(),
          text: 'Second synthetic Alpha Turn.',
          transcript_epoch: 0,
        },
      });
      const secondAllowedTurnId = submittedLater.receipt.turn.turn_id;
      createdTurnIds.push({
        tenantId: allowed.tenantId,
        conversationId: allowed.conversationId,
        turnId: secondAllowedTurnId,
      });

      const alphaModel = resolveCloudRuntimeModelConfig(
        {
          EMBER_ENV: 'staging',
          NODE_ENV: 'staging',
          EMBER_MODEL_EXECUTION: 'real',
          EMBER_MODEL_PROVIDER: 'openrouter',
          EMBER_MODEL_ID: 'nvidia/nemotron-3.5-lightning',
          EMBER_MODEL_API_KEY: TEST_MODEL_KEY,
          EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
          EMBER_MODEL_ALPHA_TENANT_IDS: allowed.tenantId,
        },
        'staging_alpha',
        new Date('2026-11-13T12:00:00.000Z'),
      );
      expect(alphaModel.kind).toBe('enabled');
      if (alphaModel.kind !== 'enabled' || alphaModel.mode !== 'real') {
        throw new Error(`expected enabled staging_alpha model config, got ${alphaModel.kind}`);
      }

      const neverCalledGateway: ModelGateway = {
        providerId: 'openrouter',
        modelLabel: 'nvidia/nemotron-3.5-lightning',
        simulated: false,
        operations: ['conversation.turn', 'task.notes_action_items'],
        generateConversationTurn() {
          throw new Error('the integration test must not call a Provider');
        },
        extractNotesActionItems() {
          throw new Error('the integration test must not call a Provider');
        },
      };
      const makeTurnExecutor = async (turnId: string) => {
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

      const leaseQueue = createNotesTaskLeaseQueue(db.pool, alphaModel);

      expect(await makeTurnExecutor(allowed.turnId)).not.toBeNull();
      expect(await makeTurnExecutor(secondAllowedTurnId)).not.toBeNull();
      expect(await makeTurnExecutor(foreign.turnId)).toBeNull();
      expect(
        await createNotesTaskExecutor({
          pool: db.pool,
          model: alphaModel,
          tenantId: allowed.tenantId,
          leaseQueue,
          gateway: neverCalledGateway,
        }),
      ).not.toBeNull();
      expect(
        await createNotesTaskExecutor({
          pool: db.pool,
          model: alphaModel,
          tenantId: foreign.tenantId,
          leaseQueue,
          gateway: neverCalledGateway,
        }),
      ).toBeNull();

      await turns.finishTurn({
        tenantId: allowed.tenantId,
        conversationId: allowed.conversationId,
        turnId: allowed.turnId,
        result: {
          status: 'completed',
          text: 'Local integration fixture only.',
          modelLabel: B1_ASSISTANT_TURN_MODEL_LABEL,
          simulated: true,
        },
      });
      await outbox.markCompleted(allowed.turnId);
    } finally {
      for (const item of createdTurnIds) {
        await turns.cancelTurn(item).catch(() => undefined);
        await outbox.markCompleted(item.turnId).catch(() => undefined);
      }
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
      operations: ['conversation.turn', 'task.notes_action_items'],
      async generateConversationTurn() {
        entered();
        await heldResult;
        return {
          output: {
            kind: 'reply',
            text: `${FAKE_REPLY_PREFIX}late test response`,
            finishReason: 'stop',
          },
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
      extractNotesActionItems() {
        return Promise.reject(
          new Error('extractNotesActionItems unused in cloud-async-runtime test'),
        );
      },
      stepPythonAgent() {
        return Promise.reject(new Error('stepPythonAgent unused in cloud-async-runtime test'));
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

  it('dispatches delegated Notes Task immediately on Turn completion, executes via Cloud Queue to task_results + outcome_reference, and reconciles via Cron', async () => {
    const fixture = await createFixture();
    const sent: unknown[] = [];
    const env = cloudRuntimeEnv(sent);

    try {
      const event = await outbox.getEvent(fixture.turnId);
      if (event === null) throw new Error('outbox event was not found');

      const delegatingGateway: ModelGateway = {
        providerId: 'fake',
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
        operations: ['conversation.turn', 'task.notes_action_items'],
        generateConversationTurn() {
          return Promise.resolve({
            output: {
              kind: 'delegate' as const,
              toolName: DELEGATE_NOTES_TOOL_NAME,
              text: '好的，我已在云端开始整理会议 Action Items。',
              finishReason: 'stop' as const,
              delegation: {
                toolName: DELEGATE_NOTES_TOOL_NAME,
                arguments: {
                  title: 'Cloud Notes Task',
                  notes: '- Alice: deploy staging check\n- Bob: verify cloud queue',
                },
              },
            },
            modelLabel: FAKE_MODEL_LABEL,
            simulated: true,
            usage: {
              inputTokens: 12,
              outputTokens: 18,
              costMicroUsd: 0,
              rateVersion: 'fake-zero-cost',
            },
          });
        },
        extractNotesActionItems() {
          return Promise.reject(new Error('not used during turn delegation'));
        },
      };

      const turnExecutor = await createTurnExecutor({
        pool: db.pool,
        model,
        event,
        workerId: 'cloud-runtime-notes-delegation',
        queue: env.TURN_DISPATCH_QUEUE,
        gateway: delegatingGateway,
      });
      expect(turnExecutor).not.toBeNull();

      await turnExecutor!.processTurn(event);
      await outbox.markCompleted(fixture.turnId);

      // Immediate Queue send was emitted right after Turn+Task transaction commit.
      expect(sent).toHaveLength(1);
      const taskEnvelope = sent[0] as {
        readonly schemaVersion: number;
        readonly kind: string;
        readonly tenantId: string;
        readonly taskId: string;
      };
      expect(taskEnvelope).toMatchObject({
        schemaVersion: 1,
        kind: 'task',
        tenantId: fixture.tenantId,
      });
      const taskId = taskEnvelope.taskId;

      // Consume Notes Task via Worker Queue entrypoint in Fake Model mode.
      const taskDelivery = new QueueDelivery(taskEnvelope);
      await cloudAsyncRuntime.queue(
        { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [taskDelivery] },
        env,
      );
      expect(taskDelivery.ackCount).toBe(1);

      const detail = await taskReads.getTaskDetail(fixture.tenantId, taskId);
      expect(detail).toMatchObject({
        task_id: taskId,
        kind: 'notes.action_items',
        title: 'Cloud Notes Task',
        status: 'completed',
      });

      const result = await taskReads.getTaskResult(fixture.tenantId, taskId);
      expect(result).toMatchObject({
        task_id: taskId,
        task_status: 'completed',
        result_state: 'available',
        result: {
          simulated: true,
        },
      });
      expect(result?.result?.detail_text).toContain('Alice');

      const page = await conversations.readMessages({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        after: 0,
        limit: 20,
      });
      expect(page.messages.map((m) => m.kind)).toEqual([
        'user',
        'ember',
        'task_reference',
        'outcome_reference',
      ]);

      // Duplicate Queue delivery for the completed Task is safely ACKed without duplicate outcomes.
      const duplicateDelivery = new QueueDelivery(taskEnvelope);
      await cloudAsyncRuntime.queue(
        { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [duplicateDelivery] },
        env,
      );
      expect(duplicateDelivery.ackCount).toBe(1);

      // Cron reconciliation picks up a due open Notes Task if immediate Queue send was dropped.
      const relayFixture = await createFixture();
      try {
        const relayTurn = await outbox.getEvent(relayFixture.turnId);
        if (relayTurn === null) throw new Error('relay outbox event was not found');
        // Mark turn outbox complete and cancel its turn? No, complete turn with delegation WITHOUT queue passed.
        const noQueueExecutor = await createTurnExecutor({
          pool: db.pool,
          model,
          event: relayTurn,
          workerId: 'cloud-runtime-notes-cron-relay',
          gateway: delegatingGateway,
        });
        await noQueueExecutor!.processTurn(relayTurn);
        await outbox.markCompleted(relayFixture.turnId);

        sent.length = 0;
        await runScheduledRelay(env);
        expect(sent).toHaveLength(1);
        const cronEnvelope = sent[0] as {
          readonly schemaVersion: number;
          readonly kind: string;
          readonly tenantId: string;
          readonly taskId: string;
        };
        expect(cronEnvelope).toMatchObject({
          schemaVersion: 1,
          kind: 'task',
          tenantId: relayFixture.tenantId,
        });

        const cronDelivery = new QueueDelivery(cronEnvelope);
        await cloudAsyncRuntime.queue(
          { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [cronDelivery] },
          env,
        );
        expect(cronDelivery.ackCount).toBe(1);
        expect(
          await taskReads.getTaskDetail(relayFixture.tenantId, cronEnvelope.taskId),
        ).toMatchObject({
          status: 'completed',
        });
      } finally {
        await turns
          .cancelTurn({
            tenantId: relayFixture.tenantId,
            conversationId: relayFixture.conversationId,
            turnId: relayFixture.turnId,
          })
          .catch(() => undefined);
        await outbox.markCompleted(relayFixture.turnId).catch(() => undefined);
      }
    } finally {
      await turns
        .cancelTurn({
          tenantId: fixture.tenantId,
          conversationId: fixture.conversationId,
          turnId: fixture.turnId,
        })
        .catch(() => undefined);
      await outbox.markCompleted(fixture.turnId).catch(() => undefined);
    }
  });

  it('renews Notes Task lease across multiple LLM attempts exceeding initial TTL and enforces fencing', async () => {
    const fixture = await createFixture();
    const sent: unknown[] = [];
    const env = cloudRuntimeEnv(sent);

    const delegatingGateway: ModelGateway = {
      providerId: 'fake',
      modelLabel: FAKE_MODEL_LABEL,
      simulated: true,
      operations: ['conversation.turn', 'task.notes_action_items'],
      generateConversationTurn() {
        return Promise.resolve({
          output: {
            kind: 'delegate' as const,
            toolName: DELEGATE_NOTES_TOOL_NAME,
            text: 'Delegating slow multi-call notes task.',
            finishReason: 'stop' as const,
            delegation: {
              toolName: DELEGATE_NOTES_TOOL_NAME,
              arguments: {
                title: 'Slow Notes Task',
                notes: '- Alice: renew lease across multiple model calls',
              },
            },
          },
          modelLabel: FAKE_MODEL_LABEL,
          simulated: true,
          usage: {
            inputTokens: 10,
            outputTokens: 12,
            costMicroUsd: 0,
            rateVersion: 'fake-zero-cost',
          },
        });
      },
      extractNotesActionItems() {
        return Promise.reject(new Error('not used during turn delegation'));
      },
    };

    try {
      const event = await outbox.getEvent(fixture.turnId);
      if (event === null) throw new Error('outbox event was not found');
      const turnExecutor = await createTurnExecutor({
        pool: db.pool,
        model,
        event,
        workerId: 'cloud-runtime-notes-hb-turn',
        queue: env.TURN_DISPATCH_QUEUE,
        gateway: delegatingGateway,
      });
      await turnExecutor!.processTurn(event);
      await outbox.markCompleted(fixture.turnId);

      const taskEnvelope = sent[0] as {
        readonly schemaVersion: number;
        readonly kind: string;
        readonly tenantId: string;
        readonly taskId: string;
      };
      expect(taskEnvelope.kind).toBe('task');
      const taskId = taskEnvelope.taskId;

      const shortLeaseModel = resolveCloudRuntimeModelConfig(
        {
          EMBER_ENV: 'staging',
          NODE_ENV: 'staging',
          EMBER_MODEL_EXECUTION: 'real',
          EMBER_MODEL_PROVIDER: 'openrouter',
          EMBER_MODEL_ID: 'nvidia/nemotron-3.5-lightning',
          EMBER_MODEL_API_KEY: TEST_MODEL_KEY,
          EMBER_MODEL_TURN_LEASE_MS: '1000',
          EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
          EMBER_MODEL_ALPHA_TENANT_IDS: fixture.tenantId,
        },
        'staging_alpha',
        new Date('2026-11-13T12:00:00.000Z'),
      );
      expect(shortLeaseModel.kind).toBe('enabled');
      if (shortLeaseModel.kind !== 'enabled' || shortLeaseModel.mode !== 'real') {
        throw new Error(`expected enabled real model config, got ${shortLeaseModel.kind}`);
      }

      const leaseQueue = createNotesTaskLeaseQueue(db.pool, shortLeaseModel);
      expect(leaseQueue.configuration.leaseDurationMs).toBe(1_000);
      expect(leaseQueue.configuration.heartbeatIntervalMs).toBe(333);

      const initialClaimRow = await db.pool.query<{ readonly updated_at: Date }>(
        'SELECT updated_at FROM tasks WHERE tenant_id = $1 AND id = $2',
        [fixture.tenantId, taskId],
      );
      expect(initialClaimRow.rows).toHaveLength(1);

      let llmAttemptCount = 0;
      let reapedMidFlight = -1;
      let leaseExtendedPastInitialTtl = false;
      let initialLeaseSnapshot: Date | null = null;

      const waitMs = (ms: number, signal: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new ModelGatewayFailure('client_cancelled'));
            return;
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(new ModelGatewayFailure('client_cancelled'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });

      const slowMultiCallGateway: ModelGateway = {
        providerId: 'openrouter',
        modelLabel: 'nvidia/nemotron-3.5-lightning',
        simulated: false,
        operations: ['conversation.turn', 'task.notes_action_items'],
        generateConversationTurn() {
          return Promise.reject(new Error('not used by notes task handler'));
        },
        async extractNotesActionItems(_request, signal) {
          llmAttemptCount += 1;
          if (llmAttemptCount === 1) {
            const firstRow = await db.pool.query<{ readonly lease_expires_at: Date }>(
              'SELECT lease_expires_at FROM tasks WHERE tenant_id = $1 AND id = $2',
              [fixture.tenantId, taskId],
            );
            initialLeaseSnapshot = firstRow.rows[0]?.lease_expires_at ?? null;
            // Hold longer than heartbeatIntervalMs (333ms) and force retry into attempt 2.
            await waitMs(650, signal);
            throw new ModelGatewayFailure('model_unavailable', { kind: 'http_5xx', status: 503 });
          }

          // Total runtime (~1.3s) exceeds initial 1.0s lease TTL; heartbeat keeps lease alive.
          await waitMs(650, signal);
          const midRow = await db.pool.query<{ readonly lease_expires_at: Date }>(
            'SELECT lease_expires_at FROM tasks WHERE tenant_id = $1 AND id = $2',
            [fixture.tenantId, taskId],
          );
          if (
            initialLeaseSnapshot !== null &&
            midRow.rows[0]?.lease_expires_at !== undefined &&
            midRow.rows[0].lease_expires_at.getTime() > initialLeaseSnapshot.getTime()
          ) {
            leaseExtendedPastInitialTtl = true;
          }
          reapedMidFlight = await leaseQueue.reapExpired(new Date());

          return {
            output: {
              actionItems: [
                {
                  title: 'Verify lease heartbeat across slow attempts',
                  owner: 'Alice',
                  dueHint: null,
                  priority: 'high' as const,
                },
              ],
              summaryText: '1. [Alice] Verify lease heartbeat across slow attempts',
              detailText: '- [Alice] Verify lease heartbeat across slow attempts',
              truncated: false,
              finishReason: 'stop' as const,
            },
            modelLabel: 'nvidia/nemotron-3.5-lightning',
            simulated: false,
            usage: {
              inputTokens: 120,
              outputTokens: 60,
              costMicroUsd: 40,
              rateVersion: shortLeaseModel.resolution.rate.rateVersion,
            },
          };
        },
      };

      const handler = await createNotesTaskExecutor({
        pool: db.pool,
        model: shortLeaseModel,
        tenantId: fixture.tenantId,
        leaseQueue,
        gateway: slowMultiCallGateway,
      });
      const delivery = new QueueDelivery(taskEnvelope);
      await consumeTaskDispatchMessage(delivery, {
        leaseQueue,
        workerId: 'cloud-notes-hb-worker',
        handler,
        heartbeatIntervalMs: leaseQueue.configuration.heartbeatIntervalMs,
      });

      expect(delivery.ackCount).toBe(1);
      expect(delivery.retryCount).toBe(0);
      expect(llmAttemptCount).toBe(2);
      expect(leaseExtendedPastInitialTtl).toBe(true);
      expect(reapedMidFlight).toBe(0);

      const result = await taskReads.getTaskResult(fixture.tenantId, taskId);
      expect(result).toMatchObject({
        task_id: taskId,
        task_status: 'completed',
        result_state: 'available',
      });

      const attempts = await db.pool.query<{
        readonly attempt_no: number;
        readonly state: string;
        readonly outcome_code: string | null;
        readonly principal_id: string;
      }>(
        `SELECT attempt_no, state, outcome_code, principal_id
           FROM task_model_attempts
          WHERE tenant_id = $1 AND task_id = $2
          ORDER BY attempt_no ASC`,
        [fixture.tenantId, taskId],
      );
      expect(attempts.rows).toEqual([
        {
          attempt_no: 1,
          state: 'unknown_billed',
          outcome_code: 'model_unavailable',
          principal_id: fixture.principalId,
        },
        {
          attempt_no: 2,
          state: 'settled',
          outcome_code: 'ok',
          principal_id: fixture.principalId,
        },
      ]);

      // Completed/stale lease fences subsequent heartbeats and finishes.
      const taskRow = await db.pool.query<{
        readonly current_run_id: string;
        readonly lease_epoch: string | number;
      }>('SELECT current_run_id, lease_epoch FROM tasks WHERE tenant_id = $1 AND id = $2', [
        fixture.tenantId,
        taskId,
      ]);
      const staleLease = {
        tenantId: fixture.tenantId,
        taskId,
        runId: taskRow.rows[0]!.current_run_id,
        attempt: 1,
        leaseEpoch: Number(taskRow.rows[0]!.lease_epoch),
        leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
      expect(await leaseQueue.heartbeat(staleLease, new Date())).toBe(false);
      expect(await leaseQueue.finish(staleLease, 'failed_terminal')).toBe(false);

      // Second delivery is gracefully ACKed without re-executing or duplicating task_results.
      const secondDelivery = new QueueDelivery(taskEnvelope);
      await consumeTaskDispatchMessage(secondDelivery, {
        leaseQueue,
        workerId: 'cloud-notes-hb-worker-2',
        handler,
        heartbeatIntervalMs: leaseQueue.configuration.heartbeatIntervalMs,
      });
      expect(secondDelivery.ackCount).toBe(1);
      expect(llmAttemptCount).toBe(2);
    } finally {
      await turns
        .cancelTurn({
          tenantId: fixture.tenantId,
          conversationId: fixture.conversationId,
          turnId: fixture.turnId,
        })
        .catch(() => undefined);
      await outbox.markCompleted(fixture.turnId).catch(() => undefined);
    }
  });

  it('aborts slow Cloud Notes LLM call promptly and avoids finishing when heartbeat loses lease epoch', async () => {
    const fixture = await createFixture();
    const sent: unknown[] = [];
    const env = cloudRuntimeEnv(sent);

    const delegatingGateway: ModelGateway = {
      providerId: 'fake',
      modelLabel: FAKE_MODEL_LABEL,
      simulated: true,
      operations: ['conversation.turn', 'task.notes_action_items'],
      generateConversationTurn() {
        return Promise.resolve({
          output: {
            kind: 'delegate' as const,
            toolName: DELEGATE_NOTES_TOOL_NAME,
            text: 'Delegating fenced notes task.',
            finishReason: 'stop' as const,
            delegation: {
              toolName: DELEGATE_NOTES_TOOL_NAME,
              arguments: {
                title: 'Fenced Notes Task',
                notes: '- Bob: abort on lease loss',
              },
            },
          },
          modelLabel: FAKE_MODEL_LABEL,
          simulated: true,
          usage: {
            inputTokens: 8,
            outputTokens: 10,
            costMicroUsd: 0,
            rateVersion: 'fake-zero-cost',
          },
        });
      },
      extractNotesActionItems() {
        return Promise.reject(new Error('not used during turn delegation'));
      },
    };

    try {
      const event = await outbox.getEvent(fixture.turnId);
      if (event === null) throw new Error('outbox event was not found');
      const turnExecutor = await createTurnExecutor({
        pool: db.pool,
        model,
        event,
        workerId: 'cloud-runtime-notes-fenced-turn',
        queue: env.TURN_DISPATCH_QUEUE,
        gateway: delegatingGateway,
      });
      await turnExecutor!.processTurn(event);
      await outbox.markCompleted(fixture.turnId);

      const taskEnvelope = sent[0] as {
        readonly schemaVersion: number;
        readonly kind: string;
        readonly tenantId: string;
        readonly taskId: string;
      };
      const taskId = taskEnvelope.taskId;

      const shortLeaseModel = resolveCloudRuntimeModelConfig(
        {
          EMBER_ENV: 'staging',
          NODE_ENV: 'staging',
          EMBER_MODEL_EXECUTION: 'real',
          EMBER_MODEL_PROVIDER: 'openrouter',
          EMBER_MODEL_ID: 'nvidia/nemotron-3.5-lightning',
          EMBER_MODEL_API_KEY: TEST_MODEL_KEY,
          EMBER_MODEL_TURN_LEASE_MS: '1000',
          EMBER_MODEL_ALPHA_SCOPE: 'allowlist',
          EMBER_MODEL_ALPHA_TENANT_IDS: fixture.tenantId,
        },
        'staging_alpha',
        new Date('2026-11-13T12:00:00.000Z'),
      );
      expect(shortLeaseModel.kind).toBe('enabled');
      if (shortLeaseModel.kind !== 'enabled' || shortLeaseModel.mode !== 'real') {
        throw new Error(`expected enabled real model config, got ${shortLeaseModel.kind}`);
      }

      const leaseQueue = createNotesTaskLeaseQueue(db.pool, shortLeaseModel);
      let entered!: () => void;
      const llmEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let gatewayAborted = false;

      const stalledGateway: ModelGateway = {
        providerId: 'openrouter',
        modelLabel: 'nvidia/nemotron-3.5-lightning',
        simulated: false,
        operations: ['conversation.turn', 'task.notes_action_items'],
        generateConversationTurn() {
          return Promise.reject(new Error('not used'));
        },
        extractNotesActionItems(_request, signal) {
          entered();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                gatewayAborted = true;
                reject(new ModelGatewayFailure('client_cancelled'));
              },
              { once: true },
            );
          });
        },
      };

      const handler = await createNotesTaskExecutor({
        pool: db.pool,
        model: shortLeaseModel,
        tenantId: fixture.tenantId,
        leaseQueue,
        gateway: stalledGateway,
      });

      const finishSpy = vi.spyOn(leaseQueue, 'finish');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const delivery = new QueueDelivery(taskEnvelope);

      try {
        const processing = consumeTaskDispatchMessage(delivery, {
          leaseQueue,
          workerId: 'cloud-notes-fenced-worker',
          handler,
          heartbeatIntervalMs: 120,
          logger: {
            warn(message, context) {
              console.warn(message, context ?? {});
            },
          },
        });

        await llmEntered;
        // Simulate another worker acquiring a higher lease_epoch while the LLM request is in flight.
        await db.pool.query(
          `UPDATE tasks
              SET lease_epoch = lease_epoch + 1
            WHERE tenant_id = $1 AND id = $2`,
          [fixture.tenantId, taskId],
        );

        await processing;
      } finally {
        warnSpy.mockRestore();
      }

      expect(gatewayAborted).toBe(true);
      expect(finishSpy).not.toHaveBeenCalled();
      expect(delivery.ackCount).toBe(0);
      expect(delivery.retryCount).toBe(1);

      const resultsCount = await db.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM task_results WHERE tenant_id = $1 AND task_id = $2',
        [fixture.tenantId, taskId],
      );
      expect(resultsCount.rows[0]?.count).toBe('0');
    } finally {
      await turns
        .cancelTurn({
          tenantId: fixture.tenantId,
          conversationId: fixture.conversationId,
          turnId: fixture.turnId,
        })
        .catch(() => undefined);
      await outbox.markCompleted(fixture.turnId).catch(() => undefined);
    }
  });
});
