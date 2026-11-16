import type { B3TaskDispatchEnvelope, B3TaskDispatchEvent } from '@ember/postgres/b3-worker';
import { parseB3TaskDispatchEnvelope } from '@ember/postgres/b3-worker';
import {
  leaseRetryDelaySeconds,
  queueRetryDelaySeconds,
  type TurnDispatchLogger,
  type TurnDispatchQueueMessage,
} from './dispatch.js';

export const AGENT_TASK_QUEUE_NAME = 'ember-agent-tasks';
export const AGENT_TASK_DLQ_NAME = 'ember-agent-tasks-dlq';
export const AGENT_OUTBOX_REENQUEUE_MS = 120_000;
export const AGENT_OUTBOX_PUBLISH_LEASE_MS = 30_000;
export const AGENT_OUTBOX_BATCH_SIZE = 10;

export { parseB3TaskDispatchEnvelope };
export type { B3TaskDispatchEnvelope, B3TaskDispatchEvent };

export function agentTaskEnvelope(event: {
  readonly tenantId: string;
  readonly taskId: string;
  readonly eventId?: string;
}): B3TaskDispatchEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    eventId: event.eventId ?? event.taskId,
    tenantId: event.tenantId,
    taskId: event.taskId,
  });
}

export interface AgentTaskOutboxPort {
  getEvent(eventId: string): Promise<B3TaskDispatchEvent | null>;
  deferNextDispatch(eventId: string, delayMs: number): Promise<boolean>;
  markCompleted(eventId: string): Promise<boolean>;
  makeDue(eventId: string, retryAfterMs: number): Promise<boolean>;
}

export type AgentTaskExecutionOutcome =
  | { readonly outcome: 'not_claimed' }
  | {
      readonly outcome:
        | 'succeeded'
        | 'failed_retryable'
        | 'failed_terminal'
        | 'cancelled'
        | 'deadline_exceeded'
        | 'lease_lost';
    };

export interface AgentTaskExecutionPort {
  processTask(event: B3TaskDispatchEvent): Promise<AgentTaskExecutionOutcome>;
}

export interface AgentDispatchConsumerOptions {
  readonly outbox: AgentTaskOutboxPort;
  /** Null means agent execution is disabled/unconfigured in this environment. */
  readonly executor: AgentTaskExecutionPort | null;
  readonly logger?: TurnDispatchLogger;
  readonly now?: () => number;
}

function isRunnableStatus(status: B3TaskDispatchEvent['status']): boolean {
  return status === 'queued' || status === 'retryable_failed' || status === 'running';
}

function retry(message: TurnDispatchQueueMessage, delaySeconds?: number): void {
  message.retry(delaySeconds === undefined ? {} : { delaySeconds });
}

function nextRunRetryDelaySeconds(nextRunAt: string | null, nowMs: number): number | null {
  if (nextRunAt === null) {
    return null;
  }
  const targetMs = Date.parse(nextRunAt);
  if (!Number.isFinite(targetMs) || targetMs <= nowMs) {
    return null;
  }
  return Math.max(1, Math.min(300, Math.ceil((targetMs - nowMs) / 1_000)));
}

function scheduleRetryForState(
  message: TurnDispatchQueueMessage,
  event: B3TaskDispatchEvent,
  nowMs: number,
): void {
  if (event.status === 'running' && event.leaseRemainingMs > 0) {
    retry(message, leaseRetryDelaySeconds(event.leaseRemainingMs));
    return;
  }
  if (event.status === 'retryable_failed') {
    const backoffSeconds = nextRunRetryDelaySeconds(event.nextRunAt, nowMs);
    if (backoffSeconds !== null) {
      retry(message, backoffSeconds);
      return;
    }
  }
  retry(message, queueRetryDelaySeconds(Math.max(1, message.attempts)));
}

/**
 * Consume one `python.agent` Queue wakeup message using PostgreSQL outbox and Tasks as truth.
 */
export async function consumeAgentDispatchMessage(
  message: TurnDispatchQueueMessage,
  options: AgentDispatchConsumerOptions,
): Promise<void> {
  const nowMs = options.now ?? (() => Date.now());
  const envelope = parseB3TaskDispatchEnvelope(message.body);
  if (envelope === null) {
    options.logger?.warn('discarded malformed Agent Task dispatch envelope', {
      category: 'invalid_envelope',
    });
    message.ack();
    return;
  }

  const event = await options.outbox.getEvent(envelope.eventId);
  if (
    event === null ||
    event.eventId !== envelope.eventId ||
    event.taskId !== envelope.taskId ||
    event.tenantId !== envelope.tenantId
  ) {
    options.logger?.warn('discarded unverified Agent Task dispatch envelope', {
      eventId: envelope.eventId,
      category: 'outbox_mismatch',
    });
    message.ack();
    return;
  }

  if (!isRunnableStatus(event.status)) {
    await options.outbox.markCompleted(event.eventId);
    message.ack();
    return;
  }

  await options.outbox.deferNextDispatch(event.eventId, AGENT_OUTBOX_REENQUEUE_MS);

  if (options.executor === null) {
    message.ack();
    return;
  }

  if (event.status === 'running' && event.leaseRemainingMs > 0) {
    retry(message, leaseRetryDelaySeconds(event.leaseRemainingMs));
    return;
  }

  if (event.status === 'retryable_failed') {
    const backoffSeconds = nextRunRetryDelaySeconds(event.nextRunAt, nowMs());
    if (backoffSeconds !== null) {
      retry(message, backoffSeconds);
      return;
    }
  }

  const result = await options.executor.processTask(event);
  if (
    result.outcome === 'succeeded' ||
    result.outcome === 'failed_terminal' ||
    result.outcome === 'cancelled' ||
    result.outcome === 'deadline_exceeded'
  ) {
    await options.outbox.markCompleted(event.eventId);
    message.ack();
    return;
  }

  const after = await options.outbox.getEvent(event.eventId);
  if (after === null || !isRunnableStatus(after.status)) {
    await options.outbox.markCompleted(event.eventId);
    message.ack();
    return;
  }

  scheduleRetryForState(message, after, nowMs());
}

export async function recoverAgentDeadLetter(
  message: TurnDispatchQueueMessage,
  outbox: AgentTaskOutboxPort,
  logger?: TurnDispatchLogger,
): Promise<void> {
  const envelope = parseB3TaskDispatchEnvelope(message.body);
  if (envelope === null) {
    logger?.warn('discarded malformed Agent Task DLQ envelope', {
      category: 'invalid_envelope',
    });
    message.ack();
    return;
  }

  const event = await outbox.getEvent(envelope.eventId);
  if (
    event === null ||
    event.eventId !== envelope.eventId ||
    event.taskId !== envelope.taskId ||
    event.tenantId !== envelope.tenantId
  ) {
    logger?.warn('discarded unverified Agent Task DLQ envelope', {
      eventId: envelope.eventId,
      category: 'outbox_mismatch',
    });
    message.ack();
    return;
  }

  if (!isRunnableStatus(event.status)) {
    await outbox.markCompleted(event.eventId);
  } else if (await outbox.makeDue(envelope.eventId, AGENT_OUTBOX_REENQUEUE_MS)) {
    logger?.warn('returned Agent Task DLQ delivery to PostgreSQL outbox', {
      eventId: envelope.eventId,
      category: 'queue_dlq',
    });
  }

  message.ack();
}
