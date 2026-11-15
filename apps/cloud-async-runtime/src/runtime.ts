import { createModelGateway, type ModelGateway } from '@ember/model-gateway';
import {
  PostgresB1TurnDispatchOutboxRepository,
  PostgresModelTurnExecutionRepository,
  type B1TurnDispatchEvent,
} from '@ember/postgres/b2-worker';
import { createModelTurnResponder } from '@ember/worker/b1/model-turn-responder';
import type pg from 'pg';
import {
  isAuthorizedCloudModelTurn,
  isCloudModelConversationAuthorized,
  type CloudRuntimeModelConfig,
} from './config.js';
import type { TurnExecutionPort } from './dispatch.js';

export function createTurnDispatchOutbox(pool: pg.Pool): PostgresB1TurnDispatchOutboxRepository {
  return new PostgresB1TurnDispatchOutboxRepository(pool);
}

export function createTurnExecutor(input: {
  readonly pool: pg.Pool;
  readonly model: CloudRuntimeModelConfig;
  readonly event: B1TurnDispatchEvent;
  readonly workerId: string;
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
    logger: {
      warn(message, context) {
        console.warn(message, context ?? {});
      },
    },
  });

  return Promise.resolve({
    expireTurnIfDue: (turn) => repository.expireTurnIfDue(turn),
    processTurn: () => responder.processOnce(),
  });
}
