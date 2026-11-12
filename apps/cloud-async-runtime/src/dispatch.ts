import type { B1TurnDispatchEnvelope, B1TurnDispatchEvent } from '@ember/postgres/b2-worker';
import { parseB1TurnDispatchEnvelope } from '@ember/postgres/b2-worker';

export const TURN_DISPATCH_QUEUE_NAME = 'ember-assistant-turns';
export const TURN_DISPATCH_DLQ_NAME = 'ember-assistant-turns-dlq';
export const TURN_OUTBOX_REENQUEUE_MS = 60_000;
export const TURN_OUTBOX_PUBLISH_LEASE_MS = 30_000;
export const TURN_OUTBOX_BATCH_SIZE = 10;

export { parseB1TurnDispatchEnvelope };
export type { B1TurnDispatchEnvelope, B1TurnDispatchEvent };

export function turnDispatchEnvelope(event: B1TurnDispatchEvent): B1TurnDispatchEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    eventId: event.eventId,
    tenantId: event.tenantId,
    turnId: event.turnId,
  });
}

export function queueRetryDelaySeconds(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError('attempts must be a positive safe integer');
  }

  return Math.min(300, 2 ** Math.min(attempts - 1, 30));
}

export function leaseRetryDelaySeconds(leaseRemainingMs: number): number {
  if (!Number.isSafeInteger(leaseRemainingMs) || leaseRemainingMs < 0) {
    throw new TypeError('leaseRemainingMs must be a non-negative safe integer');
  }

  return Math.max(1, Math.min(300, Math.ceil(leaseRemainingMs / 1_000)));
}

export interface TurnDispatchQueueMessage {
  readonly id?: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface TurnDispatchOutboxPort {
  getEvent(eventId: string): Promise<B1TurnDispatchEvent | null>;
  deferNextDispatch(eventId: string, delayMs: number): Promise<boolean>;
  markCompleted(eventId: string): Promise<boolean>;
  makeDue(eventId: string, retryAfterMs: number): Promise<boolean>;
}

export interface TurnExecutionPort {
  expireTurnIfDue(turn: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly turnId: string;
  }): Promise<unknown>;
  processTurn(event: B1TurnDispatchEvent): Promise<unknown>;
}

export interface TurnDispatchLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface TurnDispatchConsumerOptions {
  readonly outbox: TurnDispatchOutboxPort;
  /** Null means model execution is deliberately disabled or refused; it never means Fake Model. */
  readonly executor: TurnExecutionPort | null;
  readonly logger?: TurnDispatchLogger;
}

function retry(message: TurnDispatchQueueMessage, delaySeconds?: number): void {
  message.retry(delaySeconds === undefined ? {} : { delaySeconds });
}

function terminal(event: B1TurnDispatchEvent): boolean {
  return event.status !== 'running';
}

/**
 * Handle one Queue delivery without trusting the envelope as tenant authority. PostgreSQL lookup
 * supplies the conversation, status, deadline and lease; the existing B2 responder owns claims,
 * budget reservations, provider retries, cancellation fencing and result publication.
 */
export async function consumeTurnDispatchMessage(
  message: TurnDispatchQueueMessage,
  options: TurnDispatchConsumerOptions,
): Promise<void> {
  const envelope = parseB1TurnDispatchEnvelope(message.body);
  if (envelope === null) {
    options.logger?.warn('discarded malformed Assistant Turn dispatch envelope', {
      category: 'invalid_envelope',
    });
    message.ack();
    return;
  }

  const event = await options.outbox.getEvent(envelope.eventId);
  if (
    event === null ||
    event.eventId !== envelope.eventId ||
    event.turnId !== envelope.turnId ||
    event.tenantId !== envelope.tenantId
  ) {
    options.logger?.warn('discarded unverified Assistant Turn dispatch envelope', {
      eventId: envelope.eventId,
      category: 'outbox_mismatch',
    });
    message.ack();
    return;
  }

  if (terminal(event)) {
    await options.outbox.markCompleted(event.eventId);
    message.ack();
    return;
  }

  // A valid delivery is sufficient to postpone the reconciliation publish, including while model
  // execution is intentionally off. If Queue ACK is lost, duplicate delivery remains harmless.
  await options.outbox.deferNextDispatch(event.eventId, TURN_OUTBOX_REENQUEUE_MS);

  if (options.executor === null) {
    message.ack();
    return;
  }

  const identity = {
    tenantId: event.tenantId,
    conversationId: event.conversationId,
    turnId: event.turnId,
  };

  // This check uses PostgreSQL's clock. A stale or slow queue delivery can never reach a provider
  // after the B1 deadline; a simultaneous cancellation wins through the same row lock/fence.
  await options.executor.expireTurnIfDue(identity);
  const current = await options.outbox.getEvent(event.eventId);

  if (current === null || terminal(current)) {
    await options.outbox.markCompleted(event.eventId);
    message.ack();
    return;
  }

  if (current.leaseRemainingMs > 0) {
    retry(message, leaseRetryDelaySeconds(current.leaseRemainingMs));
    return;
  }

  await options.executor.processTurn(current);
  const after = await options.outbox.getEvent(event.eventId);

  if (after === null || terminal(after)) {
    await options.outbox.markCompleted(event.eventId);
    message.ack();
    return;
  }

  if (after.leaseRemainingMs > 0) {
    retry(message, leaseRetryDelaySeconds(after.leaseRemainingMs));
    return;
  }

  // The B2 pass may have been fenced or interrupted before it could claim. Retry the same stable
  // outbox event; this does not increment the PostgreSQL provider-attempt count by itself.
  retry(message, queueRetryDelaySeconds(Math.max(1, message.attempts)));
}

export async function recoverDeadLetter(
  message: TurnDispatchQueueMessage,
  outbox: TurnDispatchOutboxPort,
  logger?: TurnDispatchLogger,
): Promise<void> {
  const envelope = parseB1TurnDispatchEnvelope(message.body);
  if (envelope === null) {
    logger?.warn('discarded malformed Assistant Turn DLQ envelope', {
      category: 'invalid_envelope',
    });
    message.ack();
    return;
  }

  const event = await outbox.getEvent(envelope.eventId);
  if (
    event === null ||
    event.eventId !== envelope.eventId ||
    event.turnId !== envelope.turnId ||
    event.tenantId !== envelope.tenantId
  ) {
    logger?.warn('discarded unverified Assistant Turn DLQ envelope', {
      eventId: envelope.eventId,
      category: 'outbox_mismatch',
    });
    message.ack();
    return;
  }

  if (terminal(event)) {
    await outbox.markCompleted(event.eventId);
  } else if (await outbox.makeDue(envelope.eventId, TURN_OUTBOX_REENQUEUE_MS)) {
    logger?.warn('returned Assistant Turn DLQ delivery to PostgreSQL outbox', {
      eventId: envelope.eventId,
      category: 'queue_dlq',
    });
  }

  // The outbox will publish again after the delay. DLQ state is transport metadata only.
  message.ack();
}
