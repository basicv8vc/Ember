import { randomUUID } from 'node:crypto';
import { getOpenNotesTaskStatus, listDueNotesTaskDispatches } from '@ember/postgres/b2-worker';
import { Pool } from 'pg';
import {
  TURN_DISPATCH_DLQ_NAME,
  TURN_DISPATCH_QUEUE_NAME,
  TURN_OUTBOX_BATCH_SIZE,
  TURN_OUTBOX_PUBLISH_LEASE_MS,
  consumeTaskDispatchMessage,
  consumeTurnDispatchMessage,
  parseB1TaskDispatchEnvelope,
  parseB1TurnDispatchEnvelope,
  recoverDeadLetter,
  recoverTaskDeadLetter,
  type TurnDispatchLogger,
  type TurnDispatchQueueMessage,
} from './dispatch.js';
import { isCloudModelTenantAuthorized, resolveCloudRuntimeModelConfig } from './config.js';
import {
  publishDueNotesTaskDispatches,
  publishDueTurnDispatches,
  type TurnDispatchQueuePort,
} from './relay.js';
import {
  createNotesTaskExecutor,
  createNotesTaskLeaseQueue,
  createTurnDispatchOutbox,
  createTurnExecutor,
} from './runtime.js';

interface HyperdriveBinding {
  readonly connectionString: string;
}

type QueueBinding = TurnDispatchQueuePort;

interface RuntimeEnv {
  readonly HYPERDRIVE: HyperdriveBinding;
  readonly TURN_DISPATCH_QUEUE: QueueBinding;
  /** Optional names for isolated environments that bind a dedicated Queue/DLQ pair. */
  readonly EMBER_TURN_DISPATCH_QUEUE_NAME?: string;
  readonly EMBER_TURN_DISPATCH_DLQ_NAME?: string;
  readonly EMBER_ENV?: string;
  readonly NODE_ENV?: string;
  readonly EMBER_MODEL_EXECUTION?: string;
  readonly EMBER_MODEL_PROVIDER?: string;
  readonly EMBER_MODEL_ID?: string;
  readonly EMBER_MODEL_ALPHA_SCOPE?: string;
  readonly EMBER_MODEL_ALPHA_TENANT_IDS?: string;
  readonly EMBER_MODEL_API_KEY?: string;
  readonly EMBER_MODEL_TURN_LEASE_MS?: string;
  readonly EMBER_MODEL_ATTEMPT_TIMEOUT_MS?: string;
  readonly EMBER_MODEL_MAX_ATTEMPTS?: string;
  readonly EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD?: string;
  readonly EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD?: string;
  readonly EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD?: string;
  readonly EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD?: string;
  readonly EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS?: string;
}

type QueueMessage = TurnDispatchQueueMessage;

interface QueueBatch {
  readonly queue: string;
  readonly messages: readonly QueueMessage[];
}

interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const logger: TurnDispatchLogger = {
  warn(message, context) {
    console.warn(message, context ?? {});
  },
};

function createPool(env: RuntimeEnv): Pool {
  return new Pool({
    connectionString: env.HYPERDRIVE.connectionString,
    // Hyperdrive already pools at the edge; one short-lived client per invocation keeps the
    // application bundle from multiplying local pools across queue batches.
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    application_name: 'ember-cloud-turn-runtime',
  });
}

function runtimeWorkerId(): string {
  return `cf-turn-${randomUUID()}`;
}

async function runQueueBatch(batch: QueueBatch, env: RuntimeEnv): Promise<void> {
  const pool = createPool(env);
  const outbox = createTurnDispatchOutbox(pool);
  const dispatchQueueName = env.EMBER_TURN_DISPATCH_QUEUE_NAME?.trim() || TURN_DISPATCH_QUEUE_NAME;
  const dispatchDlqName = env.EMBER_TURN_DISPATCH_DLQ_NAME?.trim() || TURN_DISPATCH_DLQ_NAME;

  try {
    if (batch.queue === dispatchDlqName) {
      for (const message of batch.messages) {
        try {
          if (parseB1TaskDispatchEnvelope(message.body) !== null) {
            await recoverTaskDeadLetter(
              message,
              (tenantId, taskId) => getOpenNotesTaskStatus(pool, tenantId, taskId),
              logger,
            );
          } else {
            await recoverDeadLetter(message, outbox, logger);
          }
        } catch {
          logger.warn('Cloud runtime DLQ reconciliation failed', {
            category: 'database_unavailable',
          });
          message.retry({ delaySeconds: 30 });
        }
      }
      return;
    }

    if (batch.queue !== dispatchQueueName) {
      for (const message of batch.messages) {
        logger.warn('discarded dispatch message from an unexpected Queue', {
          category: 'unexpected_queue',
        });
        message.ack();
      }
      return;
    }

    // This purpose is selected by the trusted Cloud Runtime callsite, never by Worker env or Queue data.
    const model = resolveCloudRuntimeModelConfig(env, 'staging_alpha');
    if (model.kind === 'refused') {
      logger.warn('Cloud runtime model execution refused by runtime configuration', {
        category: model.reason,
      });
    }

    const leaseQueue = createNotesTaskLeaseQueue(pool, model);

    for (const message of batch.messages) {
      try {
        // Resolve by PostgreSQL state before creating an executor. A queue body never supplies
        // transcript text, notes text, provider URLs, budget or authority-bearing fields.
        const turnEnvelope = parseB1TurnDispatchEnvelope(message.body);
        if (turnEnvelope !== null) {
          const event = await outbox.getEvent(turnEnvelope.eventId);
          const executor =
            event === null || event.status !== 'running'
              ? null
              : await createTurnExecutor({
                  pool,
                  model,
                  event,
                  workerId: runtimeWorkerId(),
                  queue: env.TURN_DISPATCH_QUEUE,
                });
          await consumeTurnDispatchMessage(message, { outbox, executor, logger });
          continue;
        }

        const taskEnvelope = parseB1TaskDispatchEnvelope(message.body);
        if (taskEnvelope !== null) {
          const handler = await createNotesTaskExecutor({
            pool,
            model,
            tenantId: taskEnvelope.tenantId,
            leaseQueue,
          });
          await consumeTaskDispatchMessage(message, {
            leaseQueue,
            workerId: runtimeWorkerId(),
            handler,
            logger,
          });
          continue;
        }

        await consumeTurnDispatchMessage(message, { outbox, executor: null, logger });
      } catch {
        // Queue redelivery and PostgreSQL reconciliation are both durable recovery paths. Do not ACK
        // an unexpected database/provider exception.
        logger.warn('Cloud runtime Queue delivery failed', {
          category: 'runtime_failure',
        });
        message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function runOutboxRelay(env: RuntimeEnv): Promise<void> {
  // The Cron relay shares the same code-owned Alpha authorization and remains off by default.
  const model = resolveCloudRuntimeModelConfig(env, 'staging_alpha');
  if (model.kind !== 'enabled') {
    if (model.kind === 'refused') {
      logger.warn('Cloud runtime relay is paused by runtime configuration', {
        category: model.reason,
      });
    }
    // Do not turn a deliberate model-off state into minute-by-minute Queue churn. Outbox rows stay
    // due in PostgreSQL and the next Cron run publishes them after execution is enabled.
    return;
  }

  const pool = createPool(env);
  const outbox = createTurnDispatchOutbox(pool);
  const leaseQueue = createNotesTaskLeaseQueue(pool, model);

  try {
    const turnResult = await publishDueTurnDispatches({
      outbox,
      queue: env.TURN_DISPATCH_QUEUE,
      workerId: runtimeWorkerId(),
      logger,
      limit: TURN_OUTBOX_BATCH_SIZE,
      leaseMs: TURN_OUTBOX_PUBLISH_LEASE_MS,
    });
    if (turnResult.failed > 0) {
      console.warn('Assistant Turn outbox relay had publication failures', {
        claimed: turnResult.claimed,
        failed: turnResult.failed,
      });
    }

    const notesResult = await publishDueNotesTaskDispatches({
      relay: {
        reapExpired: (now) => leaseQueue.reapExpired(now),
        listDueNotesTasks: (limit) => listDueNotesTaskDispatches(pool, limit),
      },
      queue: env.TURN_DISPATCH_QUEUE,
      isAuthorizedTenant: (tenantId) => isCloudModelTenantAuthorized(model, tenantId),
      logger,
      limit: TURN_OUTBOX_BATCH_SIZE,
    });
    if (notesResult.failed > 0) {
      console.warn('Notes Task reconciliation relay had publication failures', {
        examined: notesResult.examined,
        failed: notesResult.failed,
      });
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export default {
  queue(batch: QueueBatch, env: RuntimeEnv): Promise<void> {
    return runQueueBatch(batch, env);
  },

  scheduled(
    _controller: ScheduledController,
    env: RuntimeEnv,
    context: WorkerExecutionContext,
  ): void {
    context.waitUntil(runOutboxRelay(env));
  },
};
