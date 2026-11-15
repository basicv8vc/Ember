import type { RunExecutionContext } from '@ember/contracts';
import {
  DeterministicExecutionRouter,
  SENTINEL_POLICY_VERSION,
  createDefaultSentinelPolicy,
  type SentinelPolicy,
} from '@ember/execution';
import { MODEL_LIMITS, createModelGateway, type ModelGateway } from '@ember/model-gateway';
import {
  PostgresB1TurnDispatchOutboxRepository,
  PostgresLeaseQueue,
  PostgresModelTurnExecutionRepository,
  PostgresNotesTaskExecutionRepository,
  PostgresRunExecutionContextReader,
  systemClock,
  type B1TaskDispatchTarget,
  type B1TurnDispatchEvent,
} from '@ember/postgres/b2-worker';
import { createModelTurnResponder } from '@ember/worker/b1/model-turn-responder';
import { createNotesTaskHandler } from '@ember/worker/notes-task-handler';
import type pg from 'pg';
import {
  isAuthorizedCloudModelTurn,
  isCloudModelConversationAuthorized,
  isCloudModelTenantAuthorized,
  type CloudRuntimeModelConfig,
} from './config.js';
import {
  taskDispatchEnvelope,
  type TaskDispatchHandlerPort,
  type TurnExecutionPort,
} from './dispatch.js';
import type { TurnDispatchQueuePort } from './relay.js';

export function createTurnDispatchOutbox(pool: pg.Pool): PostgresB1TurnDispatchOutboxRepository {
  return new PostgresB1TurnDispatchOutboxRepository(pool);
}

/**
 * Construct a `PostgresLeaseQueue` scoped exclusively to `notes.action_items` using the configured
 * Cloud runtime lease duration.
 */
export function createNotesTaskLeaseQueue(
  pool: pg.Pool,
  model?: CloudRuntimeModelConfig,
): PostgresLeaseQueue {
  return new PostgresLeaseQueue(pool, {
    clock: systemClock,
    ...(model !== undefined && model.kind === 'enabled'
      ? { leaseDurationMs: model.resolution.settings.leaseMs }
      : {}),
    claimableKinds: ['notes.action_items'],
  });
}

export function createTurnExecutor(input: {
  readonly pool: pg.Pool;
  readonly model: CloudRuntimeModelConfig;
  readonly event: B1TurnDispatchEvent;
  readonly workerId: string;
  readonly queue?: TurnDispatchQueuePort;
  /** Test seam; production callers always construct the approved gateway from its resolution. */
  readonly gateway?: ModelGateway;
}): Promise<TurnExecutionPort | null> {
  if (
    input.model.kind !== 'enabled' ||
    !isCloudModelConversationAuthorized(input.model, input.event)
  ) {
    return Promise.resolve(null);
  }

  if (!isAuthorizedCloudModelTurn(input.model, input.event)) {
    return Promise.resolve(null);
  }

  const { mode, resolution } = input.model;
  const repository = new PostgresModelTurnExecutionRepository(input.pool);
  const delegatedTasks: B1TaskDispatchTarget[] = [];
  const responder = createModelTurnResponder({
    mode,
    repository,
    gateway: input.gateway ?? createModelGateway(resolution),
    workerId: input.workerId,
    leaseMs: resolution.settings.leaseMs,
    ceilings: resolution.settings.ceilings,
    maxAttempts: resolution.settings.maxAttempts,
    attemptTimeoutMs: resolution.settings.attemptTimeoutMs,
    rate: mode === 'real' ? resolution.rate : null,
    onlyTurn: {
      tenantId: input.event.tenantId,
      conversationId: input.event.conversationId,
      turnId: input.event.turnId,
    },
    batchSize: 1,
    onTaskDelegated: (delegation) => {
      delegatedTasks.push({ tenantId: delegation.tenantId, taskId: delegation.taskId });
    },
    logger: {
      warn(message, context) {
        console.warn(message, context ?? {});
      },
    },
  });

  return Promise.resolve({
    expireTurnIfDue: (turn) => repository.expireTurnIfDue(turn),
    processTurn: async () => {
      const summary = await responder.processOnce();
      for (const target of delegatedTasks) {
        if (input.queue === undefined) {
          continue;
        }
        try {
          await input.queue.send(taskDispatchEnvelope(target));
        } catch {
          // Turn completion and the queued Task are already durably committed; Cron safety net replays.
          console.warn('Notes Task immediate queue dispatch failed; cron relay will recover', {
            category: 'queue_unavailable',
            taskId: target.taskId,
          });
        }
      }
      return summary;
    },
  });
}

/**
 * Construct the durable `notes.action_items` handler for one Cloud Queue delivery when model
 * execution is enabled and the target tenant is authorized.
 */
export function createNotesTaskExecutor(input: {
  readonly pool: pg.Pool;
  readonly model: CloudRuntimeModelConfig;
  readonly tenantId: string;
  readonly leaseQueue: PostgresLeaseQueue;
  /** Test seam; production callers always construct the approved gateway from its resolution. */
  readonly gateway?: ModelGateway;
}): Promise<TaskDispatchHandlerPort | null> {
  if (
    input.model.kind !== 'enabled' ||
    !isCloudModelTenantAuthorized(input.model, input.tenantId)
  ) {
    return Promise.resolve(null);
  }

  const { mode, resolution } = input.model;
  const sentinelPolicy = (context: RunExecutionContext): SentinelPolicy =>
    createDefaultSentinelPolicy({
      policyId: 'sentinel-policy-default',
      policyVersion: SENTINEL_POLICY_VERSION,
      tenantId: context.tenantId,
      allowedActions: ['mock.read', 'mock.compute'],
    });

  const handler = createNotesTaskHandler({
    mode,
    contextReader: new PostgresRunExecutionContextReader(input.pool, systemClock),
    router: new DeterministicExecutionRouter(),
    repository: new PostgresNotesTaskExecutionRepository(input.pool),
    gateway: input.gateway ?? createModelGateway(resolution),
    policy: input.leaseQueue.configuration,
    ceilings: resolution.settings.ceilings,
    maxAttemptsPerTask: MODEL_LIMITS.maxModelAttemptsPerTask,
    maxTaskCostMicroUsd: MODEL_LIMITS.maxModelCostPerTaskMicroUsd,
    attemptTimeoutMs: resolution.settings.attemptTimeoutMs,
    rate: mode === 'real' ? resolution.rate : null,
    clock: systemClock,
    sentinelPolicy,
    logger: {
      debug() {},
      info(message, context) {
        console.info(message, context ?? {});
      },
      warn(message, context) {
        console.warn(message, context ?? {});
      },
      error(message, context) {
        console.error(message, context ?? {});
      },
    },
  });

  return Promise.resolve({
    handle: (run, signal) => handler.handle(run, signal),
  });
}
