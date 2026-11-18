import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DELEGATE_NOTES_TOOL_NAME,
  DELEGATE_PYTHON_TOOL_NAME,
  FAKE_MODEL_LABEL,
  FAKE_REPLY_PREFIX,
  ModelGatewayFailure,
  type ModelGateway,
} from '@ember/model-gateway';
import { PostgresB3StagedUploadRepository } from '@ember/postgres/b3-worker';
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
import { B1_TURN_DEADLINE_SECONDS } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { createTurnWakeupDispatcher } from '../../apps/api/src/turn-wakeup.js';
import { resolveCloudRuntimeModelConfig } from '../../apps/cloud-async-runtime/src/config.js';
import cloudAsyncRuntime, {
  MAINTENANCE_GC_CRON,
  TASK_RECOVERY_CRON,
  TURN_RECOVERY_CRON,
} from '../../apps/cloud-async-runtime/src/index.js';
import { consumeAgentDispatchMessage } from '../../apps/cloud-async-runtime/src/agent-dispatch.js';
import {
  consumeTaskDispatchMessage,
  consumeTurnDispatchMessage,
  taskDispatchEnvelope,
  type TurnDispatchQueueMessage,
} from '../../apps/cloud-async-runtime/src/dispatch.js';
import {
  createAgentDispatchOutbox,
  createNotesTaskExecutor,
  createNotesTaskLeaseQueue,
  createPythonAgentExecutor,
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

async function runScheduledRelay(
  env: ReturnType<typeof cloudRuntimeEnv>,
  cron: string = TURN_RECOVERY_CRON,
): Promise<void> {
  let scheduledWork: Promise<unknown> | undefined;
  cloudAsyncRuntime.scheduled({ cron, scheduledTime: Date.now() }, env, {
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
        stepPythonAgent() {
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
        stepPythonAgent() {
          return Promise.reject(new Error('not used during notes delegation'));
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
        await runScheduledRelay(env, TASK_RECOVERY_CRON);
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
      stepPythonAgent() {
        return Promise.reject(new Error('not used during notes delegation'));
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
        stepPythonAgent() {
          return Promise.reject(new Error('not used by notes task handler'));
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
      stepPythonAgent() {
        return Promise.reject(new Error('not used during notes delegation'));
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
        stepPythonAgent() {
          return Promise.reject(new Error('not used by notes task handler'));
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
        // Undo synthetic epoch skew and close the synthetic running task so subsequent cron relay tests
        // see neither a mismatched task/run epoch nor an orphaned due Notes task.
        await db.pool
          .query(
            `UPDATE tasks
                SET status = 'cancelled',
                    current_run_id = NULL,
                    lease_expires_at = NULL,
                    lease_epoch = GREATEST(1, lease_epoch - 1)
              WHERE tenant_id = $1 AND id = $2`,
            [fixture.tenantId, taskId],
          )
          .catch(() => undefined);
        await db.pool
          .query(
            `UPDATE runs
                SET status = 'cancelled',
                    finished_at = COALESCE(finished_at, clock_timestamp())
              WHERE tenant_id = $1 AND task_id = $2 AND status IN ('created', 'running')`,
            [fixture.tenantId, taskId],
          )
          .catch(() => undefined);
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

  it('routes Notes and Python Agent delegations through merged Cloud Runtime queues to completion with principal tracking', async () => {
    const fixture = await createFixture();
    const notesSent: unknown[] = [];
    const agentSent: unknown[] = [];
    const env = {
      ...cloudRuntimeEnv(notesSent),
      AGENT_TASK_QUEUE: {
        send: (message: unknown) => {
          agentSent.push(message);
          return Promise.resolve();
        },
      },
      EMBER_AGENT_TASK_QUEUE_NAME: 'ember-test-agent-tasks',
      EMBER_AGENT_TASK_DLQ_NAME: 'ember-test-agent-tasks-dlq',
      DAYTONA_API_KEY: 'daytona-test-cloud-runtime-key-123456',
      EMBER_SANDBOX_OWNER: 'cloud-runtime-test',
    };

    const uploadRepo = new PostgresB3StagedUploadRepository(db.pool);
    const agentOutbox = createAgentDispatchOutbox(db.pool);
    const secondTurnIds: Array<{ tenantId: string; conversationId: string; turnId: string }> = [
      {
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: fixture.turnId,
      },
    ];

    try {
      const staged = await uploadRepo.stageUpload(
        { tenantId: fixture.tenantId, principalId: fixture.principalId, policyVersion: 1 },
        {
          filename: 'sales.csv',
          mediaType: 'text/csv',
          bytes: new TextEncoder().encode('region,amount\napac,200\n'),
        },
      );

      // Turn 1 delegates notes.action_items -> dispatched to TURN_DISPATCH_QUEUE and consumed by Worker queue().
      const event1 = await outbox.getEvent(fixture.turnId);
      if (event1 === null) throw new Error('turn 1 outbox event was not found');
      const notesGateway: ModelGateway = {
        providerId: 'fake',
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
        operations: ['conversation.turn', 'task.notes_action_items'],
        generateConversationTurn() {
          return Promise.resolve({
            output: {
              kind: 'delegate' as const,
              toolName: DELEGATE_NOTES_TOOL_NAME,
              text: 'Delegating Notes extraction.',
              finishReason: 'stop' as const,
              delegation: {
                toolName: DELEGATE_NOTES_TOOL_NAME,
                arguments: {
                  title: 'Merged Cloud Notes',
                  notes: '- Alice: verify merged runtime',
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
        stepPythonAgent() {
          return Promise.reject(new Error('not used during notes delegation'));
        },
      };

      const turn1Executor = await createTurnExecutor({
        pool: db.pool,
        model,
        event: event1,
        workerId: 'cloud-merged-notes-turn',
        queue: env.TURN_DISPATCH_QUEUE,
        agentQueue: env.AGENT_TASK_QUEUE,
        gateway: notesGateway,
      });
      await turn1Executor!.processTurn(event1);
      await outbox.markCompleted(fixture.turnId);

      expect(notesSent).toHaveLength(1);
      expect(agentSent).toHaveLength(0);
      const notesEnvelope = notesSent[0] as { readonly kind: string; readonly taskId: string };
      expect(notesEnvelope.kind).toBe('task');

      const notesDelivery = new QueueDelivery(notesEnvelope);
      await cloudAsyncRuntime.queue(
        { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [notesDelivery] },
        env,
      );
      expect(notesDelivery.ackCount).toBe(1);
      expect(await taskReads.getTaskDetail(fixture.tenantId, notesEnvelope.taskId)).toMatchObject({
        kind: 'notes.action_items',
        status: 'completed',
      });

      // Turn 2 delegates python.agent with staged upload -> routed to AGENT_TASK_QUEUE.
      const sub2 = await writer.submitUserMessage({
        tenantId: fixture.tenantId,
        principalId: fixture.principalId,
        conversationId: fixture.conversationId,
        request: {
          client_submission_id: randomUUID(),
          text: 'Summarize sales.csv into outputs/summary.csv',
          transcript_epoch: 0,
          attachment_ids: [staged.upload_id],
        },
      });
      const turn2Id = sub2.receipt.turn.turn_id;
      secondTurnIds.push({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: turn2Id,
      });

      const event2 = await outbox.getEvent(turn2Id);
      if (event2 === null) throw new Error('turn 2 outbox event was not found');

      let pyStepCalls = 0;
      const pythonGateway: ModelGateway = {
        providerId: 'fake',
        modelLabel: FAKE_MODEL_LABEL,
        simulated: true,
        operations: ['conversation.turn', 'task.python_agent'],
        generateConversationTurn() {
          return Promise.resolve({
            output: {
              kind: 'delegate' as const,
              toolName: DELEGATE_PYTHON_TOOL_NAME,
              text: 'Delegating Python aggregation.',
              finishReason: 'stop' as const,
              delegation: {
                toolName: DELEGATE_PYTHON_TOOL_NAME,
                arguments: {
                  title: 'Merged Cloud Python',
                  prompt: 'Aggregate sales.csv into outputs/summary.csv',
                  attachment_ids: [staged.upload_id],
                },
              },
            },
            modelLabel: FAKE_MODEL_LABEL,
            simulated: true,
            usage: {
              inputTokens: 12,
              outputTokens: 14,
              costMicroUsd: 0,
              rateVersion: 'fake-zero-cost',
            },
          });
        },
        extractNotesActionItems() {
          return Promise.reject(new Error('not used during python delegation'));
        },
        stepPythonAgent() {
          pyStepCalls += 1;
          if (pyStepCalls === 1) {
            const code = "open('outputs/summary.csv', 'w').write('region,amount\\napac,200\\n')";
            const purpose = 'Aggregate sales CSV';
            return Promise.resolve({
              output: {
                kind: 'tool_call' as const,
                toolCallId: 'py_call_1',
                code,
                purpose,
                rawArgumentsJson: JSON.stringify({ code, purpose }),
              },
              modelLabel: FAKE_MODEL_LABEL,
              simulated: true,
              usage: {
                inputTokens: 20,
                outputTokens: 25,
                costMicroUsd: 0,
                rateVersion: 'fake-zero-cost',
              },
            });
          }
          return Promise.resolve({
            output: {
              kind: 'final' as const,
              summaryText: 'Aggregated sales.csv -> outputs/summary.csv',
              detailText: 'apac: 200',
              truncated: false,
              finishReason: 'stop' as const,
            },
            modelLabel: FAKE_MODEL_LABEL,
            simulated: true,
            usage: {
              inputTokens: 30,
              outputTokens: 15,
              costMicroUsd: 0,
              rateVersion: 'fake-zero-cost',
            },
          });
        },
      };

      const turn2Executor = await createTurnExecutor({
        pool: db.pool,
        model,
        event: event2,
        workerId: 'cloud-merged-python-turn',
        queue: env.TURN_DISPATCH_QUEUE,
        agentQueue: env.AGENT_TASK_QUEUE,
        gateway: pythonGateway,
      });
      await turn2Executor!.processTurn(event2);
      await outbox.markCompleted(turn2Id);

      expect(notesSent).toHaveLength(1);
      expect(agentSent).toHaveLength(1);
      const agentEnvelope = agentSent[0] as { readonly taskId: string; readonly tenantId: string };
      expect(agentEnvelope.tenantId).toBe(fixture.tenantId);

      // Scheduled Task Cron relay also reconciles un-completed Python Agent outbox rows onto AGENT_TASK_QUEUE.
      await runScheduledRelay(env, TASK_RECOVERY_CRON);
      expect(agentSent).toHaveLength(2);

      const agentEvent = await agentOutbox.getEvent(agentEnvelope.taskId);
      if (agentEvent === null) throw new Error('python agent outbox event not found');

      const sandboxFiles = new Map<string, Uint8Array>();
      const summaryBytes = new TextEncoder().encode('region,amount\napac,200\n');
      let sandboxClosed = false;

      const pyExecutor = await createPythonAgentExecutor({
        pool: db.pool,
        model,
        daytona: { kind: 'enabled', apiKey: env.DAYTONA_API_KEY, owner: env.EMBER_SANDBOX_OWNER },
        event: agentEvent,
        workerId: 'cloud-merged-python-worker',
        gateway: pythonGateway,
        sandboxFactory: () => ({
          provider: {
            create: () => Promise.resolve({ sandboxId: `sbx-${randomUUID()}` }),
            waitReady: () => Promise.resolve(),
            putTextFile: (_id, rel, text) => {
              sandboxFiles.set(rel, new TextEncoder().encode(text));
              return Promise.resolve();
            },
            putBytesFile: (_id, rel, bytes) => {
              sandboxFiles.set(rel, bytes);
              return Promise.resolve();
            },
            getBytesFile: (_id, rel) => Promise.resolve(sandboxFiles.get(rel) ?? summaryBytes),
            listDirectory: (_id, rel) =>
              Promise.resolve(
                rel === 'outputs'
                  ? [
                      {
                        name: 'summary.csv',
                        isDir: false,
                        isSymlink: false,
                        sizeBytes: summaryBytes.byteLength,
                      },
                    ]
                  : [],
              ),
            exec: () => {
              sandboxFiles.set('outputs/summary.csv', summaryBytes);
              return Promise.resolve({
                exitCode: 0,
                stdoutRef: 'out:ok',
                stderrRef: 'err:',
                artifactRefs: [],
              });
            },
            readOutput: (_id, ref) => Promise.resolve(ref.startsWith('out:') ? 'ok' : ''),
            destroy: () => Promise.resolve(),
          },
          close: () => {
            sandboxClosed = true;
            return Promise.resolve();
          },
        }),
      });

      const agentDelivery = new QueueDelivery(agentEnvelope);
      await consumeAgentDispatchMessage(agentDelivery, {
        outbox: agentOutbox,
        executor: pyExecutor,
      });

      expect(agentDelivery.ackCount).toBe(1);
      expect(sandboxClosed).toBe(true);
      expect(await taskReads.getTaskDetail(fixture.tenantId, agentEnvelope.taskId)).toMatchObject({
        kind: 'python.agent',
        status: 'completed',
      });

      const listedArtifacts = await uploadRepo.listTaskArtifacts(
        { tenantId: fixture.tenantId, principalId: fixture.principalId, policyVersion: 1 },
        agentEnvelope.taskId,
      );
      expect(listedArtifacts?.artifacts.map((a) => a.filename)).toEqual([
        'sales.csv',
        'summary.csv',
      ]);

      const pyAttempts = await db.pool.query<{ readonly principal_id: string }>(
        `SELECT principal_id
           FROM task_model_attempts
          WHERE tenant_id = $1 AND task_id = $2`,
        [fixture.tenantId, agentEnvelope.taskId],
      );
      expect(pyAttempts.rows).toHaveLength(2);
      expect(pyAttempts.rows.every((r) => r.principal_id === fixture.principalId)).toBe(true);
    } finally {
      for (const item of secondTurnIds) {
        await turns.cancelTurn(item).catch(() => undefined);
        await outbox.markCompleted(item.turnId).catch(() => undefined);
      }
    }
  });

  it('executes committed Turns immediately via Queue, recovers un-enqueued outbox rows and crashed tasks, and isolates maintenance GC', async () => {
    const sent: unknown[] = [];
    const env = cloudRuntimeEnv(sent);

    // 1. Immediate Queue path (no Cron): submitUserMessage triggers onTurnCommitted -> Queue -> completion.
    const immediateFixture = await createFixture();
    const immediateWriter = new PostgresB1ConversationWriteRepository(db.pool, {
      writeTurnDispatchOutbox: true,
      onTurnCommitted: (event) => {
        sent.push({
          schemaVersion: 1,
          eventId: event.turnId,
          tenantId: event.tenantId,
          turnId: event.turnId,
        });
      },
    });
    const immediateSubmitted = await immediateWriter.submitUserMessage({
      tenantId: immediateFixture.tenantId,
      conversationId: immediateFixture.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Immediate event-driven Turn without Cron.',
        transcript_epoch: 0,
      },
    });
    const immediateTurnId = immediateSubmitted.receipt.turn.turn_id;

    // 2. Dropped fast-send path: commit succeeds and writes outbox, while Queue send fails.
    const droppedSubmitted = await writer.submitUserMessage({
      tenantId: immediateFixture.tenantId,
      conversationId: immediateFixture.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Committed outbox row whose initial Queue wake dropped.',
        transcript_epoch: 0,
      },
    });
    const droppedTurnId = droppedSubmitted.receipt.turn.turn_id;

    const uploadRepo = new PostgresB3StagedUploadRepository(db.pool);
    const expiredUpload = await uploadRepo.stageUpload(
      {
        tenantId: immediateFixture.tenantId,
        principalId: immediateFixture.principalId,
        policyVersion: 1,
      },
      {
        filename: 'expired.txt',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode('stale upload'),
        now: new Date(Date.now() - 48 * 60 * 60 * 1_000),
      },
    );
    const activeUpload = await uploadRepo.stageUpload(
      {
        tenantId: immediateFixture.tenantId,
        principalId: immediateFixture.principalId,
        policyVersion: 1,
      },
      {
        filename: 'active.txt',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode('fresh upload'),
      },
    );

    try {
      // Cancel the unused initial fixture turn so only the two test Turns remain runnable.
      await turns.cancelTurn({
        tenantId: immediateFixture.tenantId,
        conversationId: immediateFixture.conversationId,
        turnId: immediateFixture.turnId,
      });
      await outbox.markCompleted(immediateFixture.turnId);

      // Deliver immediate Turn without invoking Cron at all.
      expect(sent).toHaveLength(1);
      const immediateDelivery = new QueueDelivery(sent[0]);
      await cloudAsyncRuntime.queue(
        { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [immediateDelivery] },
        env,
      );
      expect(immediateDelivery.ackCount).toBe(1);
      expect(
        (
          await turns.getTurn({
            tenantId: immediateFixture.tenantId,
            conversationId: immediateFixture.conversationId,
            turnId: immediateTurnId,
          })
        )?.status,
      ).toBe('completed');

      // Maintenance GC Cron sweeps expired upload without publishing the pending outbox row.
      sent.length = 0;
      await runScheduledRelay(env, MAINTENANCE_GC_CRON);
      expect(sent).toHaveLength(0);
      const uploadRows = await db.pool.query<{ readonly id: string }>(
        'SELECT id FROM user_staged_uploads WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [immediateFixture.tenantId, [expiredUpload.upload_id, activeUpload.upload_id]],
      );
      expect(uploadRows.rows.map((r) => r.id)).toEqual([activeUpload.upload_id]);

      // Turn Recovery Cron rescues the committed-but-not-enqueued outbox row without losing it.
      await runScheduledRelay(env, TURN_RECOVERY_CRON);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ eventId: droppedTurnId, turnId: droppedTurnId });
      const recoveredDelivery = new QueueDelivery(sent[0]);
      await cloudAsyncRuntime.queue(
        { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [recoveredDelivery] },
        env,
      );
      expect(recoveredDelivery.ackCount).toBe(1);

      // Duplicate Queue delivery after Turn completion produces no duplicate assistant message.
      const duplicateTurnDelivery = new QueueDelivery(sent[0]);
      await cloudAsyncRuntime.queue(
        { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [duplicateTurnDelivery] },
        env,
      );
      expect(duplicateTurnDelivery.ackCount).toBe(1);
      expect(await readAssistantMessages(immediateFixture)).toHaveLength(2);

      // 3. Simulated Worker crash mid Notes Task execution (expired running lease) recovers on Queue redelivery.
      const crashedTaskFixture = await createFixture();
      try {
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
                text: 'Delegating Notes extraction for crash test.',
                finishReason: 'stop' as const,
                delegation: {
                  toolName: DELEGATE_NOTES_TOOL_NAME,
                  arguments: {
                    title: 'Crash Recovery Notes',
                    notes: '- Alice: verify inline lease recovery',
                  },
                },
              },
              modelLabel: FAKE_MODEL_LABEL,
              simulated: true,
              usage: {
                inputTokens: 10,
                outputTokens: 10,
                costMicroUsd: 0,
                rateVersion: 'fake-zero-cost',
              },
            });
          },
          extractNotesActionItems() {
            return Promise.reject(new Error('not used during delegation'));
          },
          stepPythonAgent() {
            return Promise.reject(new Error('not used during notes delegation'));
          },
        };
        const turnEvent = await outbox.getEvent(crashedTaskFixture.turnId);
        if (turnEvent === null) throw new Error('crash fixture outbox event missing');
        sent.length = 0;
        const turnExec = await createTurnExecutor({
          pool: db.pool,
          model,
          event: turnEvent,
          workerId: 'cloud-runtime-crash-delegator',
          queue: env.TURN_DISPATCH_QUEUE,
          gateway: delegatingGateway,
        });
        await turnExec!.processTurn(turnEvent);
        await outbox.markCompleted(crashedTaskFixture.turnId);

        const delegatedTarget = sent[0] as { readonly tenantId: string; readonly taskId: string };
        const notesLeaseQueue = createNotesTaskLeaseQueue(db.pool, model);
        const claimedBeforeCrash = await notesLeaseQueue.claimTask('crashed-worker-1', new Date(), {
          tenantId: delegatedTarget.tenantId,
          taskId: delegatedTarget.taskId,
        });
        expect(claimedBeforeCrash.kind).toBe('claimed');

        // Simulate isolate crash without calling finish(), then advance past lease expiration
        // while respecting `tasks_check` (lease_expires_at >= created_at).
        await db.pool.query(
          `UPDATE tasks
              SET lease_expires_at = created_at
            WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
          [crashedTaskFixture.tenantId, delegatedTarget.taskId],
        );
        await new Promise((resolve) => setTimeout(resolve, 25));

        // First Queue redelivery after crash reaps expired running lease inline and schedules backoff retry.
        const firstRedelivery = new QueueDelivery(taskDispatchEnvelope(delegatedTarget));
        await cloudAsyncRuntime.queue(
          { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [firstRedelivery] },
          env,
        );
        expect(firstRedelivery.ackCount).toBe(0);
        expect(firstRedelivery.retryCount).toBe(1);
        expect(firstRedelivery.retryOptions?.delaySeconds).toBeGreaterThanOrEqual(1);
        expect(
          await taskReads.getTaskDetail(crashedTaskFixture.tenantId, delegatedTarget.taskId),
        ).toMatchObject({ status: 'retryable_failed' });

        // After the 1_000ms retry backoff, the next Queue redelivery completes the Task without Cron.
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const redelivery = new QueueDelivery(taskDispatchEnvelope(delegatedTarget));
        await cloudAsyncRuntime.queue(
          { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [redelivery] },
          env,
        );
        expect(redelivery.ackCount).toBe(1);
        expect(
          await taskReads.getTaskDetail(crashedTaskFixture.tenantId, delegatedTarget.taskId),
        ).toMatchObject({ status: 'completed' });

        const duplicateTaskRedelivery = new QueueDelivery(taskDispatchEnvelope(delegatedTarget));
        await cloudAsyncRuntime.queue(
          { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [duplicateTaskRedelivery] },
          env,
        );
        expect(duplicateTaskRedelivery.ackCount).toBe(1);

        const resultsCount = await db.pool.query<{ readonly count: string }>(
          'SELECT count(*)::text AS count FROM task_results WHERE tenant_id = $1 AND task_id = $2',
          [crashedTaskFixture.tenantId, delegatedTarget.taskId],
        );
        expect(resultsCount.rows[0]?.count).toBe('1');
      } finally {
        await turns
          .cancelTurn({
            tenantId: crashedTaskFixture.tenantId,
            conversationId: crashedTaskFixture.conversationId,
            turnId: crashedTaskFixture.turnId,
          })
          .catch(() => undefined);
        await outbox.markCompleted(crashedTaskFixture.turnId).catch(() => undefined);
      }
    } finally {
      for (const turnId of [immediateFixture.turnId, immediateTurnId, droppedTurnId]) {
        await turns
          .cancelTurn({
            tenantId: immediateFixture.tenantId,
            conversationId: immediateFixture.conversationId,
            turnId,
          })
          .catch(() => undefined);
        await outbox.markCompleted(turnId).catch(() => undefined);
      }
      await db.pool
        .query('DELETE FROM user_staged_uploads WHERE tenant_id = $1', [immediateFixture.tenantId])
        .catch(() => undefined);
    }
  });

  it('recovers from initial Queue publication failures within the 60s B1_TURN_DEADLINE_SECONDS contract', async () => {
    const sent: unknown[] = [];
    const env = cloudRuntimeEnv(sent);
    const fixture = await createFixture();
    const waitUntilPromises: Array<Promise<unknown>> = [];
    const wakeupWarnings: string[] = [];

    // 1. Transient initial Queue publish failure heals via bounded async waitUntil retry without Cron.
    let transientCalls = 0;
    const transientDispatcher = createTurnWakeupDispatcher({
      dispatchQueue: {
        send: (message) => {
          transientCalls += 1;
          if (transientCalls === 1) {
            return Promise.reject(new Error('simulated transient Queue 503'));
          }
          sent.push(message);
          return Promise.resolve();
        },
      },
      context: {
        waitUntil(promise) {
          waitUntilPromises.push(promise);
        },
      },
      logger: {
        warn(message) {
          wakeupWarnings.push(message);
        },
      },
      retryDelaysMs: [50, 100],
    });
    const transientWriter = new PostgresB1ConversationWriteRepository(db.pool, {
      writeTurnDispatchOutbox: true,
      onTurnCommitted: transientDispatcher,
    });

    const transientSubmitted = await transientWriter.submitUserMessage({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Transient initial Queue publish failure recovers via retry.',
        transcript_epoch: 0,
      },
    });
    const transientTurnId = transientSubmitted.receipt.turn.turn_id;

    // 2. Persistent initial Queue publish failure leaves durable outbox row untouched by 30m/6h Crons,
    //    but rescued before the 60s Turn deadline by the 1m Turn recovery Cron.
    const persistentDispatcher = createTurnWakeupDispatcher({
      dispatchQueue: {
        send: () => Promise.reject(new Error('simulated persistent Queue outage')),
      },
      context: {
        waitUntil(promise) {
          waitUntilPromises.push(promise);
        },
      },
      logger: {
        warn(message) {
          wakeupWarnings.push(message);
        },
      },
      retryDelaysMs: [20, 40],
    });
    const persistentWriter = new PostgresB1ConversationWriteRepository(db.pool, {
      writeTurnDispatchOutbox: true,
      onTurnCommitted: persistentDispatcher,
    });
    const persistentSubmitted = await persistentWriter.submitUserMessage({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Persistent initial Queue outage must recover within 60s deadline.',
        transcript_epoch: 0,
      },
    });
    const persistentTurnId = persistentSubmitted.receipt.turn.turn_id;

    // 3. Turn aged past B1_TURN_DEADLINE_SECONDS (simulating what happened with a 30-minute Cron)
    //    cannot recover and expires without reaching the model.
    const expiredSubmitted = await persistentWriter.submitUserMessage({
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Delayed past 60s deadline expires cleanly without model execution.',
        transcript_epoch: 0,
      },
    });
    const expiredTurnId = expiredSubmitted.receipt.turn.turn_id;

    try {
      await turns.cancelTurn({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: fixture.turnId,
      });
      await outbox.markCompleted(fixture.turnId);

      // Finish waitUntil wakeup attempts; transient failure retried and enqueued, persistent logged warning.
      await Promise.all(waitUntilPromises);
      expect(transientCalls).toBe(2);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ turnId: transientTurnId });
      expect(wakeupWarnings).toEqual([
        'Assistant Turn Queue wake failed',
        'Assistant Turn Queue wake failed',
      ]);

      const transientDelivery = new QueueDelivery(sent[0]);
      await cloudAsyncRuntime.queue(
        { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [transientDelivery] },
        env,
      );
      expect(transientDelivery.ackCount).toBe(1);
      expect(
        (
          await turns.getTurn({
            tenantId: fixture.tenantId,
            conversationId: fixture.conversationId,
            turnId: transientTurnId,
          })
        )?.status,
      ).toBe('completed');

      // Age the third turn past the 60s contract to model a delayed recovery tick (> B1_TURN_DEADLINE_SECONDS).
      await db.pool.query(
        `UPDATE assistant_turns
            SET created_at = created_at - interval '70 seconds',
                deadline_at = deadline_at - interval '70 seconds'
          WHERE tenant_id = $1 AND id = $2`,
        [fixture.tenantId, expiredTurnId],
      );

      // Confirm persisted Turn deadline is exactly B1_TURN_DEADLINE_SECONDS (60s) from creation.
      const deadlineCheck = await db.pool.query<{ readonly deadline_seconds: string }>(
        `SELECT EXTRACT(EPOCH FROM (deadline_at - created_at))::int::text AS deadline_seconds
           FROM assistant_turns
          WHERE tenant_id = $1 AND id = $2`,
        [fixture.tenantId, persistentTurnId],
      );
      expect(deadlineCheck.rows[0]?.deadline_seconds).toBe(String(B1_TURN_DEADLINE_SECONDS));

      // Non-Turn Crons (30m Task reconciliation + 6h GC) do NOT touch committed Turn outbox rows.
      sent.length = 0;
      await runScheduledRelay(env, TASK_RECOVERY_CRON);
      await runScheduledRelay(env, MAINTENANCE_GC_CRON);
      expect(sent).toHaveLength(0);

      // 1m Turn Recovery Cron picks up due outbox rows cleanly within the 60s window.
      await runScheduledRelay(env, TURN_RECOVERY_CRON);
      const recoveredTurnIds = sent.map((entry) => (entry as { readonly turnId: string }).turnId);
      expect(recoveredTurnIds).toContain(persistentTurnId);
      expect(recoveredTurnIds).toContain(expiredTurnId);

      for (const messageBody of sent) {
        const delivery = new QueueDelivery(messageBody);
        await cloudAsyncRuntime.queue(
          { queue: env.EMBER_TURN_DISPATCH_QUEUE_NAME, messages: [delivery] },
          env,
        );
        expect(delivery.ackCount).toBe(1);
      }

      expect(
        (
          await turns.getTurn({
            tenantId: fixture.tenantId,
            conversationId: fixture.conversationId,
            turnId: persistentTurnId,
          })
        )?.status,
      ).toBe('completed');
      expect(
        (
          await turns.getTurn({
            tenantId: fixture.tenantId,
            conversationId: fixture.conversationId,
            turnId: expiredTurnId,
          })
        )?.status,
      ).toBe('failed');

      const assistantMessages = await readAssistantMessages(fixture);
      expect(assistantMessages).toHaveLength(3);
      expect(
        assistantMessages.filter((message) => message.text.startsWith(FAKE_REPLY_PREFIX)),
      ).toHaveLength(2);
      const expiredTurn = await turns.getTurn({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        turnId: expiredTurnId,
      });
      expect(expiredTurn).toMatchObject({
        status: 'failed',
      });
    } finally {
      for (const turnId of [fixture.turnId, transientTurnId, persistentTurnId, expiredTurnId]) {
        await turns
          .cancelTurn({
            tenantId: fixture.tenantId,
            conversationId: fixture.conversationId,
            turnId,
          })
          .catch(() => undefined);
        await outbox.markCompleted(turnId).catch(() => undefined);
      }
    }
  });
});
