import { randomUUID } from 'node:crypto';
import { getOpenNotesTaskStatus, listDueNotesTaskDispatches } from '@ember/postgres/b2-worker';
import {
  PostgresB3StagedUploadRepository,
  PostgresByteaBlobStore,
} from '@ember/postgres/b3-worker';
import { Pool } from 'pg';
import {
  AGENT_OUTBOX_BATCH_SIZE,
  AGENT_OUTBOX_PUBLISH_LEASE_MS,
  AGENT_TASK_DLQ_NAME,
  AGENT_TASK_QUEUE_NAME,
  consumeAgentDispatchMessage,
  parseB3TaskDispatchEnvelope,
  recoverAgentDeadLetter,
} from './agent-dispatch.js';
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
import {
  isCloudModelTenantAuthorized,
  resolveCloudDaytonaConfig,
  resolveCloudRuntimeModelConfig,
} from './config.js';
import {
  publishDueAgentDispatches,
  publishDueNotesTaskDispatches,
  publishDueTurnDispatches,
  type TurnDispatchQueuePort,
} from './relay.js';
import {
  createAgentDispatchOutbox,
  createNotesTaskExecutor,
  createNotesTaskLeaseQueue,
  createPythonAgentExecutor,
  createTurnDispatchOutbox,
  createTurnExecutor,
} from './runtime.js';

const BLOB_GC_MAX_AGE_MS = 60 * 60 * 1_000;
export const TURN_RECOVERY_CRON = '* * * * *';
export const TASK_RECOVERY_CRON = '*/30 * * * *';
export const MAINTENANCE_GC_CRON = '0 */6 * * *';

interface HyperdriveBinding {
  readonly connectionString: string;
}

type QueueBinding = TurnDispatchQueuePort;

interface RuntimeEnv {
  readonly HYPERDRIVE: HyperdriveBinding;
  readonly TURN_DISPATCH_QUEUE: QueueBinding;
  readonly AGENT_TASK_QUEUE?: QueueBinding;
  /** Optional names for isolated environments that bind a dedicated Queue/DLQ pair. */
  readonly EMBER_TURN_DISPATCH_QUEUE_NAME?: string;
  readonly EMBER_TURN_DISPATCH_DLQ_NAME?: string;
  readonly EMBER_AGENT_TASK_QUEUE_NAME?: string;
  readonly EMBER_AGENT_TASK_DLQ_NAME?: string;
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
  readonly DAYTONA_API_KEY?: string;
  readonly DAYTONA_API_URL?: string;
  readonly DAYTONA_TARGET?: string;
  readonly EMBER_SANDBOX_OWNER?: string;
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

type RuntimePoolFactory = (env: RuntimeEnv) => Pool;

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

async function runQueueBatch(
  batch: QueueBatch,
  env: RuntimeEnv,
  makePool: RuntimePoolFactory,
): Promise<void> {
  if (batch.messages.length === 0) {
    return;
  }

  const dispatchQueueName = env.EMBER_TURN_DISPATCH_QUEUE_NAME?.trim() || TURN_DISPATCH_QUEUE_NAME;
  const dispatchDlqName = env.EMBER_TURN_DISPATCH_DLQ_NAME?.trim() || TURN_DISPATCH_DLQ_NAME;
  const agentQueueName = env.EMBER_AGENT_TASK_QUEUE_NAME?.trim() || AGENT_TASK_QUEUE_NAME;
  const agentDlqName = env.EMBER_AGENT_TASK_DLQ_NAME?.trim() || AGENT_TASK_DLQ_NAME;

  if (
    batch.queue !== dispatchQueueName &&
    batch.queue !== dispatchDlqName &&
    batch.queue !== agentQueueName &&
    batch.queue !== agentDlqName
  ) {
    for (const message of batch.messages) {
      logger.warn('discarded dispatch message from an unexpected Queue', {
        category: 'unexpected_queue',
      });
      message.ack();
    }
    return;
  }

  const pool = makePool(env);

  try {
    if (batch.queue === dispatchDlqName) {
      const outbox = createTurnDispatchOutbox(pool);
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

    if (batch.queue === agentDlqName) {
      const agentOutbox = createAgentDispatchOutbox(pool);
      for (const message of batch.messages) {
        try {
          await recoverAgentDeadLetter(message, agentOutbox, logger);
        } catch {
          logger.warn('Agent Task DLQ reconciliation failed', {
            category: 'database_unavailable',
          });
          message.retry({ delaySeconds: 30 });
        }
      }
      return;
    }

    if (batch.queue === agentQueueName) {
      const model = resolveCloudRuntimeModelConfig(env, 'staging_alpha');
      if (model.kind === 'refused') {
        logger.warn('Agent Task model execution refused by runtime configuration', {
          category: model.reason,
        });
      }
      const daytona = resolveCloudDaytonaConfig(env);
      if (daytona.kind === 'disabled') {
        logger.warn('Agent Task sandbox execution is disabled (DAYTONA_API_KEY missing)', {
          category: 'daytona_disabled',
        });
      }
      const agentOutbox = createAgentDispatchOutbox(pool);

      for (const message of batch.messages) {
        try {
          const envelope = parseB3TaskDispatchEnvelope(message.body);
          if (envelope === null) {
            await consumeAgentDispatchMessage(message, {
              outbox: agentOutbox,
              executor: null,
              logger,
            });
            continue;
          }

          const event = await agentOutbox.getEvent(envelope.eventId);
          const executor =
            event === null ||
            (event.status !== 'queued' &&
              event.status !== 'retryable_failed' &&
              event.status !== 'running')
              ? null
              : await createPythonAgentExecutor({
                  pool,
                  model,
                  daytona,
                  event,
                  workerId: runtimeWorkerId(),
                });
          await consumeAgentDispatchMessage(message, { outbox: agentOutbox, executor, logger });
        } catch {
          logger.warn('Agent Task Queue delivery failed', {
            category: 'runtime_failure',
          });
          message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
        }
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
    const outbox = createTurnDispatchOutbox(pool);
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
                  ...(env.AGENT_TASK_QUEUE === undefined
                    ? {}
                    : { agentQueue: env.AGENT_TASK_QUEUE }),
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
            heartbeatIntervalMs: leaseQueue.configuration.heartbeatIntervalMs,
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

function resolveEnabledModelConfig(env: RuntimeEnv) {
  // Recovery relays share code-owned Alpha authorization; paused environments must not wake Neon.
  const model = resolveCloudRuntimeModelConfig(env, 'staging_alpha');
  if (model.kind !== 'enabled') {
    if (model.kind === 'refused') {
      logger.warn('Cloud runtime relay is paused by runtime configuration', {
        category: model.reason,
      });
    }
    return null;
  }

  return model;
}

async function runTurnRecoveryRelay(env: RuntimeEnv, makePool: RuntimePoolFactory): Promise<void> {
  const model = resolveEnabledModelConfig(env);
  if (model === null) {
    return;
  }

  const pool = makePool(env);
  const workerId = runtimeWorkerId();

  try {
    const turnOutbox = createTurnDispatchOutbox(pool);
    const turnResult = await publishDueTurnDispatches({
      outbox: turnOutbox,
      queue: env.TURN_DISPATCH_QUEUE,
      workerId,
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
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function runTaskRecoveryRelay(env: RuntimeEnv, makePool: RuntimePoolFactory): Promise<void> {
  const model = resolveEnabledModelConfig(env);
  if (model === null) {
    return;
  }

  const daytona = resolveCloudDaytonaConfig(env);
  const pool = makePool(env);
  const workerId = runtimeWorkerId();

  try {
    const leaseQueue = createNotesTaskLeaseQueue(pool, model);
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

    if (daytona.kind === 'enabled' && env.AGENT_TASK_QUEUE !== undefined) {
      const agentOutbox = createAgentDispatchOutbox(pool);
      const agentResult = await publishDueAgentDispatches({
        outbox: agentOutbox,
        queue: env.AGENT_TASK_QUEUE,
        workerId,
        logger,
        limit: AGENT_OUTBOX_BATCH_SIZE,
        leaseMs: AGENT_OUTBOX_PUBLISH_LEASE_MS,
      });
      if (agentResult.failed > 0) {
        console.warn('Agent Task outbox relay had publication failures', {
          claimed: agentResult.claimed,
          failed: agentResult.failed,
        });
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function runMaintenanceGc(env: RuntimeEnv, makePool: RuntimePoolFactory): Promise<void> {
  const pool = makePool(env);

  try {
    await new PostgresB3StagedUploadRepository(pool).sweepExpiredUnboundUploads().catch(() => {
      logger.warn('expired upload GC sweep failed', { category: 'database_unavailable' });
    });

    await new PostgresByteaBlobStore(pool)
      .sweepOrphans(new Date(), { retentionMs: BLOB_GC_MAX_AGE_MS })
      .catch(() => {
        logger.warn('bytea blob GC sweep failed', { category: 'database_unavailable' });
      });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export function createCloudAsyncRuntime(deps: { readonly createPool?: RuntimePoolFactory } = {}) {
  const makePool = deps.createPool ?? createPool;
  return {
    queue(batch: QueueBatch, env: RuntimeEnv): Promise<void> {
      return runQueueBatch(batch, env, makePool);
    },

    scheduled(
      controller: ScheduledController,
      env: RuntimeEnv,
      context: WorkerExecutionContext,
    ): void {
      if (controller.cron === MAINTENANCE_GC_CRON) {
        context.waitUntil(runMaintenanceGc(env, makePool));
        return;
      }

      if (controller.cron === TASK_RECOVERY_CRON) {
        context.waitUntil(runTaskRecoveryRelay(env, makePool));
        return;
      }

      context.waitUntil(runTurnRecoveryRelay(env, makePool));
    },
  };
}

export default createCloudAsyncRuntime();
