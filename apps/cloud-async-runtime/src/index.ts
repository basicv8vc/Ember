import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  TURN_DISPATCH_DLQ_NAME,
  TURN_DISPATCH_QUEUE_NAME,
  TURN_OUTBOX_BATCH_SIZE,
  TURN_OUTBOX_PUBLISH_LEASE_MS,
  consumeTurnDispatchMessage,
  parseB1TurnDispatchEnvelope,
  recoverDeadLetter,
  type TurnDispatchLogger,
  type TurnDispatchQueueMessage,
} from './dispatch.js';
import { resolveCloudRuntimeModelConfig } from './config.js';
import { publishDueTurnDispatches, type TurnDispatchQueuePort } from './relay.js';
import { createTurnDispatchOutbox, createTurnExecutor } from './runtime.js';

interface HyperdriveBinding {
  readonly connectionString: string;
}

type QueueBinding = TurnDispatchQueuePort;

interface RuntimeEnv {
  readonly HYPERDRIVE: HyperdriveBinding;
  readonly TURN_DISPATCH_QUEUE: QueueBinding;
  readonly EMBER_ENV?: string;
  readonly NODE_ENV?: string;
  readonly EMBER_MODEL_EXECUTION?: string;
  readonly EMBER_MODEL_PROVIDER?: string;
  readonly EMBER_MODEL_ID?: string;
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

  try {
    if (batch.queue === TURN_DISPATCH_DLQ_NAME) {
      for (const message of batch.messages) {
        try {
          await recoverDeadLetter(message, outbox, logger);
        } catch {
          logger.warn('Assistant Turn DLQ reconciliation failed', {
            category: 'database_unavailable',
          });
          message.retry({ delaySeconds: 30 });
        }
      }
      return;
    }

    if (batch.queue !== TURN_DISPATCH_QUEUE_NAME) {
      for (const message of batch.messages) {
        logger.warn('discarded Assistant Turn message from an unexpected Queue', {
          category: 'unexpected_queue',
        });
        message.ack();
      }
      return;
    }

    const model = resolveCloudRuntimeModelConfig(env);
    if (model.kind === 'refused') {
      logger.warn('Assistant Turn model execution refused by runtime configuration', {
        category: model.reason,
      });
    }

    for (const message of batch.messages) {
      try {
        // Resolve by the event ID in PostgreSQL before creating an executor. A queue body never
        // supplies transcript text, a provider URL, budget or authority-bearing conversation ID.
        const envelope = parseB1TurnDispatchEnvelope(message.body);
        if (envelope === null) {
          await consumeTurnDispatchMessage(message, { outbox, executor: null, logger });
          continue;
        }

        const event = await outbox.getEvent(envelope.eventId);
        const executor =
          event === null || event.status !== 'running'
            ? null
            : createTurnExecutor({
                pool,
                model,
                event,
                workerId: runtimeWorkerId(),
              });
        await consumeTurnDispatchMessage(message, { outbox, executor, logger });
      } catch {
        // Queue redelivery and the PostgreSQL outbox are both durable recovery paths. Do not ACK
        // an unexpected database/provider exception.
        logger.warn('Assistant Turn Queue delivery failed', {
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
  const model = resolveCloudRuntimeModelConfig(env);
  if (model.kind !== 'enabled') {
    if (model.kind === 'refused') {
      logger.warn('Assistant Turn outbox relay is paused by runtime configuration', {
        category: model.reason,
      });
    }
    // Do not turn a deliberate model-off state into minute-by-minute Queue churn. Outbox rows stay
    // due in PostgreSQL and the next Cron run publishes them after execution is enabled.
    return;
  }

  const pool = createPool(env);
  const outbox = createTurnDispatchOutbox(pool);

  try {
    const result = await publishDueTurnDispatches({
      outbox,
      queue: env.TURN_DISPATCH_QUEUE,
      workerId: runtimeWorkerId(),
      logger,
      limit: TURN_OUTBOX_BATCH_SIZE,
      leaseMs: TURN_OUTBOX_PUBLISH_LEASE_MS,
    });
    if (result.failed > 0) {
      console.warn('Assistant Turn outbox relay had publication failures', {
        claimed: result.claimed,
        failed: result.failed,
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
