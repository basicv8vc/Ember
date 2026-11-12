import type { B1TurnDispatchEvent } from '@ember/postgres/b2-worker';
import {
  TURN_OUTBOX_BATCH_SIZE,
  TURN_OUTBOX_PUBLISH_LEASE_MS,
  TURN_OUTBOX_REENQUEUE_MS,
  turnDispatchEnvelope,
  type TurnDispatchLogger,
} from './dispatch.js';

export interface TurnDispatchQueuePort {
  send(message: unknown): Promise<void>;
}

export interface TurnDispatchRelayOutboxPort {
  claimDue(input: {
    readonly limit: number;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<readonly B1TurnDispatchEvent[]>;
  markEnqueued(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly reenqueueAfterMs: number;
  }): Promise<boolean>;
  release(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly retryAfterMs: number;
    readonly errorCode: 'queue_unavailable' | 'database_unavailable';
  }): Promise<boolean>;
}

export interface TurnDispatchRelayResult {
  readonly claimed: number;
  readonly enqueued: number;
  readonly failed: number;
}

/**
 * Publish due PostgreSQL outbox rows as prompt-free Queue wakeups. A crash after Queue send but
 * before markEnqueued may cause a duplicate delivery; the database Turn lease and fenced publish
 * make that duplicate safe.
 */
export async function publishDueTurnDispatches(input: {
  readonly outbox: TurnDispatchRelayOutboxPort;
  readonly queue: TurnDispatchQueuePort;
  readonly workerId: string;
  readonly logger?: TurnDispatchLogger;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly reenqueueAfterMs?: number;
}): Promise<TurnDispatchRelayResult> {
  const workerId = input.workerId;
  const events = await input.outbox.claimDue({
    limit: input.limit ?? TURN_OUTBOX_BATCH_SIZE,
    workerId,
    leaseMs: input.leaseMs ?? TURN_OUTBOX_PUBLISH_LEASE_MS,
  });
  let enqueued = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await input.queue.send(turnDispatchEnvelope(event));
      await input.outbox.markEnqueued({
        eventId: event.eventId,
        workerId,
        reenqueueAfterMs: input.reenqueueAfterMs ?? TURN_OUTBOX_REENQUEUE_MS,
      });
      enqueued += 1;
    } catch {
      failed += 1;
      try {
        await input.outbox.release({
          eventId: event.eventId,
          workerId,
          retryAfterMs: 5_000,
          errorCode: 'queue_unavailable',
        });
      } catch {
        // The publication lease expires in PostgreSQL, so a relay crash cannot strand the row.
      }
      input.logger?.warn('Assistant Turn outbox publication failed', {
        category: 'queue_unavailable',
        eventId: event.eventId,
      });
    }
  }

  return Object.freeze({ claimed: events.length, enqueued, failed });
}
