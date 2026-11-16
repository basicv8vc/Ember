import type { B1TaskDispatchTarget, B1TurnDispatchEvent } from '@ember/postgres/b2-worker';
import type { B3TaskDispatchEvent } from '@ember/postgres/b3-worker';
import {
  AGENT_OUTBOX_BATCH_SIZE,
  AGENT_OUTBOX_PUBLISH_LEASE_MS,
  AGENT_OUTBOX_REENQUEUE_MS,
  agentTaskEnvelope,
} from './agent-dispatch.js';
import {
  TURN_OUTBOX_BATCH_SIZE,
  TURN_OUTBOX_PUBLISH_LEASE_MS,
  TURN_OUTBOX_REENQUEUE_MS,
  taskDispatchEnvelope,
  turnDispatchEnvelope,
  type TurnDispatchLogger,
} from './dispatch.js';

export interface TurnDispatchQueuePort {
  send(message: unknown): Promise<void>;
}

export interface OutboxRelayPort<TEvent extends { readonly eventId: string }> {
  claimDue(input: {
    readonly limit: number;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<readonly TEvent[]>;
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

export type TurnDispatchRelayOutboxPort = OutboxRelayPort<B1TurnDispatchEvent>;
export type AgentDispatchRelayOutboxPort = OutboxRelayPort<B3TaskDispatchEvent>;

export interface TurnDispatchRelayResult {
  readonly claimed: number;
  readonly enqueued: number;
  readonly failed: number;
}

export interface NotesTaskDispatchRelayPort {
  reapExpired(now: Date): Promise<number>;
  listDueNotesTasks(limit: number): Promise<readonly B1TaskDispatchTarget[]>;
}

export interface NotesTaskRelayResult {
  readonly reaped: number;
  readonly examined: number;
  readonly enqueued: number;
  readonly failed: number;
}

async function publishDueOutbox<TEvent extends { readonly eventId: string }>(input: {
  readonly outbox: OutboxRelayPort<TEvent>;
  readonly queue: TurnDispatchQueuePort;
  readonly workerId: string;
  readonly toEnvelope: (event: TEvent) => unknown;
  readonly failureMessage: string;
  readonly logger?: TurnDispatchLogger;
  readonly limit: number;
  readonly leaseMs: number;
  readonly reenqueueAfterMs: number;
}): Promise<TurnDispatchRelayResult> {
  const workerId = input.workerId;
  const events = await input.outbox.claimDue({
    limit: input.limit,
    workerId,
    leaseMs: input.leaseMs,
  });
  let enqueued = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await input.queue.send(input.toEnvelope(event));
      await input.outbox.markEnqueued({
        eventId: event.eventId,
        workerId,
        reenqueueAfterMs: input.reenqueueAfterMs,
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
      input.logger?.warn(input.failureMessage, {
        category: 'queue_unavailable',
        eventId: event.eventId,
      });
    }
  }

  return Object.freeze({ claimed: events.length, enqueued, failed });
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
  return publishDueOutbox({
    outbox: input.outbox,
    queue: input.queue,
    workerId: input.workerId,
    toEnvelope: turnDispatchEnvelope,
    failureMessage: 'Assistant Turn outbox publication failed',
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    limit: input.limit ?? TURN_OUTBOX_BATCH_SIZE,
    leaseMs: input.leaseMs ?? TURN_OUTBOX_PUBLISH_LEASE_MS,
    reenqueueAfterMs: input.reenqueueAfterMs ?? TURN_OUTBOX_REENQUEUE_MS,
  });
}

/**
 * Publish due PostgreSQL outbox rows for `python.agent` Tasks as prompt-free Queue wakeups.
 */
export async function publishDueAgentDispatches(input: {
  readonly outbox: AgentDispatchRelayOutboxPort;
  readonly queue: TurnDispatchQueuePort;
  readonly workerId: string;
  readonly logger?: TurnDispatchLogger;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly reenqueueAfterMs?: number;
}): Promise<TurnDispatchRelayResult> {
  return publishDueOutbox({
    outbox: input.outbox,
    queue: input.queue,
    workerId: input.workerId,
    toEnvelope: agentTaskEnvelope,
    failureMessage: 'Agent Task outbox publication failed',
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    limit: input.limit ?? AGENT_OUTBOX_BATCH_SIZE,
    leaseMs: input.leaseMs ?? AGENT_OUTBOX_PUBLISH_LEASE_MS,
    reenqueueAfterMs: input.reenqueueAfterMs ?? AGENT_OUTBOX_REENQUEUE_MS,
  });
}

/**
 * Reap expired Task leases/deadlines and enqueue any due open `notes.action_items` Tasks as
 * idempotent Queue wakeups (reconciliation safety net alongside immediate delegation send).
 */
export async function publishDueNotesTaskDispatches(input: {
  readonly relay: NotesTaskDispatchRelayPort;
  readonly queue: TurnDispatchQueuePort;
  readonly isAuthorizedTenant?: (tenantId: string) => boolean;
  readonly logger?: TurnDispatchLogger;
  readonly limit?: number;
  readonly now?: () => Date;
}): Promise<NotesTaskRelayResult> {
  const now = input.now ?? (() => new Date());
  const reaped = await input.relay.reapExpired(now());
  const due = await input.relay.listDueNotesTasks(input.limit ?? TURN_OUTBOX_BATCH_SIZE);
  const targets =
    input.isAuthorizedTenant === undefined
      ? due
      : due.filter((target) => input.isAuthorizedTenant!(target.tenantId));

  let enqueued = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      await input.queue.send(taskDispatchEnvelope(target));
      enqueued += 1;
    } catch {
      failed += 1;
      input.logger?.warn('Notes Task reconciliation enqueue failed', {
        category: 'queue_unavailable',
        taskId: target.taskId,
      });
    }
  }

  return Object.freeze({
    reaped,
    examined: targets.length,
    enqueued,
    failed,
  });
}
