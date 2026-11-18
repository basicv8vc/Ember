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
import {
  LEASE_QUEUE_DEFAULTS,
  PostgresB3TaskDispatchOutboxRepository,
  PostgresByteaBlobStore,
  PostgresPythonAgentExecutionRepository,
  type B3TaskDispatchEvent,
  type R2BucketPort,
} from '@ember/postgres/b3-worker';
import { DaytonaSandboxProvider, DaytonaSdkSandboxClient } from '@ember/sandbox-daytona';
import { createModelTurnResponder } from '@ember/worker/b1/model-turn-responder';
import { createNotesTaskHandler } from '@ember/worker/notes-task-handler';
import {
  executePythonAgentRun,
  type PythonAgentSandboxFactory,
} from '@ember/worker/b3/python-agent-executor';
import type pg from 'pg';
import { agentTaskEnvelope, type AgentTaskExecutionPort } from './agent-dispatch.js';
import {
  isAuthorizedCloudModelTurn,
  isCloudModelConversationAuthorized,
  isCloudModelTenantAuthorized,
  type CloudDaytonaConfig,
  type CloudRuntimeModelConfig,
} from './config.js';
import {
  taskDispatchEnvelope,
  type TaskDispatchHandlerPort,
  type TurnExecutionPort,
} from './dispatch.js';
import type { TurnDispatchQueuePort } from './relay.js';

const runtimeLogger = {
  info(message: string, context?: Record<string, unknown>) {
    console.log(message, context ?? {});
  },
  warn(message: string, context?: Record<string, unknown>) {
    console.warn(message, context ?? {});
  },
};

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
  const leaseDurationMs =
    model !== undefined && model.kind === 'enabled' ? model.resolution.settings.leaseMs : undefined;
  return new PostgresLeaseQueue(pool, {
    clock: systemClock,
    ...(leaseDurationMs === undefined
      ? {}
      : {
          leaseDurationMs,
          heartbeatIntervalMs: Math.max(100, Math.floor(leaseDurationMs / 3)),
        }),
    claimableKinds: ['notes.action_items'],
  });
}

export function createAgentDispatchOutbox(pool: pg.Pool): PostgresB3TaskDispatchOutboxRepository {
  return new PostgresB3TaskDispatchOutboxRepository(pool);
}

export function createTurnExecutor(input: {
  readonly pool: pg.Pool;
  readonly model: CloudRuntimeModelConfig;
  readonly event: B1TurnDispatchEvent;
  readonly workerId: string;
  readonly r2Bucket?: R2BucketPort;
  readonly queue?: TurnDispatchQueuePort;
  readonly agentQueue?: TurnDispatchQueuePort;
  readonly onTaskDelegated?: (delegated: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly taskId: string;
    readonly toolName?: 'delegate_notes_action_items' | 'delegate_python_agent';
  }) => void;
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
  const repository = new PostgresModelTurnExecutionRepository(
    input.pool,
    input.r2Bucket === undefined ? {} : { r2Bucket: input.r2Bucket },
  );
  const delegatedTasks: Array<{
    readonly target: B1TaskDispatchTarget;
    readonly toolName: 'delegate_notes_action_items' | 'delegate_python_agent';
  }> = [];
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
      delegatedTasks.push({
        target: { tenantId: delegation.tenantId, taskId: delegation.taskId },
        toolName: delegation.toolName ?? 'delegate_notes_action_items',
      });
      input.onTaskDelegated?.(delegation);
    },
    logger: runtimeLogger,
  });

  return Promise.resolve({
    expireTurnIfDue: (turn) => repository.expireTurnIfDue(turn),
    processTurn: async () => {
      const summary = await responder.processOnce();
      for (const { target, toolName } of delegatedTasks) {
        if (toolName === 'delegate_python_agent') {
          if (input.agentQueue === undefined) {
            continue;
          }
          try {
            await input.agentQueue.send(agentTaskEnvelope(target));
          } catch {
            console.warn('Agent Task immediate queue dispatch failed; cron relay will recover', {
              category: 'queue_unavailable',
              taskId: target.taskId,
            });
          }
          continue;
        }
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

export function createPythonAgentExecutor(input: {
  readonly pool: pg.Pool;
  readonly model: CloudRuntimeModelConfig;
  readonly daytona: CloudDaytonaConfig;
  readonly event: B3TaskDispatchEvent;
  readonly workerId: string;
  readonly r2Bucket?: R2BucketPort;
  readonly gateway?: ModelGateway;
  readonly sandboxFactory?: PythonAgentSandboxFactory;
}): Promise<AgentTaskExecutionPort | null> {
  if (input.model.kind !== 'enabled' || input.daytona.kind !== 'enabled') {
    return Promise.resolve(null);
  }

  if (!isCloudModelTenantAuthorized(input.model, input.event.tenantId)) {
    return Promise.resolve(null);
  }

  const { mode, resolution } = input.model;
  const daytona = input.daytona;
  const leaseQueue = new PostgresLeaseQueue(input.pool, {
    leaseDurationMs: LEASE_QUEUE_DEFAULTS.leaseDurationMs,
    heartbeatIntervalMs: LEASE_QUEUE_DEFAULTS.heartbeatIntervalMs,
    claimableKinds: ['python.agent'],
  });
  const repository = new PostgresPythonAgentExecutionRepository(
    input.pool,
    input.r2Bucket === undefined ? {} : { r2Bucket: input.r2Bucket },
  );
  const gateway = input.gateway ?? createModelGateway(resolution);

  const createSandbox: PythonAgentSandboxFactory =
    input.sandboxFactory ??
    (({ tenantId, runId, owner, signal }) => {
      const client = new DaytonaSdkSandboxClient({
        apiKey: daytona.apiKey,
        ...(daytona.apiUrl === undefined ? {} : { apiUrl: daytona.apiUrl }),
        ...(daytona.target === undefined ? {} : { target: daytona.target }),
      });
      const provider = new DaytonaSandboxProvider({
        tenantId,
        runId,
        client,
        snapshot: 'daytona-small',
        sandboxClass: 'container',
        owner,
        signal,
      });
      return {
        provider,
        close: () => client.close(),
      };
    });

  return Promise.resolve({
    async processTask(event: B3TaskDispatchEvent) {
      const claimed = await leaseQueue.claimTaskForRun(
        event.tenantId,
        event.taskId,
        input.workerId,
        new Date(),
      );
      if (claimed === null) {
        return { outcome: 'not_claimed' as const };
      }

      const blobStore = new PostgresByteaBlobStore(input.pool, {
        ...(input.r2Bucket === undefined ? {} : { r2Bucket: input.r2Bucket }),
        ownership: {
          taskId: claimed.taskId,
          runId: claimed.runId,
          leaseEpoch: claimed.leaseEpoch,
        },
      });
      const result = await executePythonAgentRun(claimed, {
        mode,
        leaseQueue,
        repository,
        blobStore,
        gateway,
        createSandbox,
        sandboxOwner: daytona.owner,
        policy: {
          baseDelayMs: LEASE_QUEUE_DEFAULTS.baseDelayMs,
          capDelayMs: LEASE_QUEUE_DEFAULTS.capDelayMs,
        },
        ceilings: {
          perAttemptMicroUsd: resolution.settings.ceilings.perAttemptMicroUsd,
          principalDailyMicroUsd: resolution.settings.ceilings.principalDailyMicroUsd,
          tenantDailyMicroUsd: resolution.settings.ceilings.tenantDailyMicroUsd,
          globalDailyMicroUsd: resolution.settings.ceilings.globalDailyMicroUsd,
        },
        rate: mode === 'real' ? resolution.rate : null,
        leaseDurationMs: leaseQueue.configuration.leaseDurationMs,
        attemptTimeoutMs: resolution.settings.attemptTimeoutMs,
        logger: runtimeLogger,
      });

      return { outcome: result.outcome };
    },
  });
}
