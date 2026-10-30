import { toTaskEventDto, type TaskEventDto } from '@ember/contracts';
import {
  DomainError,
  isTerminalTaskStatus,
  type AuthContext,
  type Id,
  type TaskEvent,
  type TaskStatus,
} from '@ember/domain';
import type { TaskStore } from './task-store.js';
import { MAX_EVENTS_PER_PAGE } from './constants.js';

export const DEFAULT_STREAM_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

export interface TaskEventStreamOptions {
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  /** Monotonic clock seam used by deterministic tests. */
  readonly now?: () => number;
  /** Abortable delay seam used by deterministic tests. */
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type TaskEventStreamConfiguration = Required<TaskEventStreamOptions>;

export function resolveTaskEventStreamOptions(
  options: TaskEventStreamOptions = {},
): TaskEventStreamConfiguration {
  const resolved: TaskEventStreamConfiguration = {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_STREAM_POLL_INTERVAL_MS,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS,
    now: options.now ?? (() => performance.now()),
    wait: options.wait ?? abortableDelay,
  };

  if (
    !Number.isSafeInteger(resolved.pollIntervalMs) ||
    resolved.pollIntervalMs < 1 ||
    !Number.isSafeInteger(resolved.heartbeatIntervalMs) ||
    resolved.heartbeatIntervalMs < 1
  ) {
    throw new RangeError('task event stream intervals must be positive safe integers');
  }

  return resolved;
}

/**
 * Tracks live stream loops so process shutdown can stop their polling before closing the
 * PostgreSQL pool. Each route instance can receive its own registry in tests.
 */
export class TaskEventStreamRegistry {
  private readonly controllers = new Set<AbortController>();
  private readonly idleWaiters = new Set<() => void>();
  private closed = false;

  get activeCount(): number {
    return this.controllers.size;
  }

  whenIdle(): Promise<void> {
    if (this.controllers.size === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  register(controller: AbortController): (() => void) | null {
    if (this.closed) {
      controller.abort();
      return null;
    }

    this.controllers.add(controller);
    return () => {
      this.controllers.delete(controller);
      this.resolveIdleWaiters();
    };
  }

  closeAll(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const controller of this.controllers) {
      controller.abort();
    }
  }

  private resolveIdleWaiters(): void {
    if (this.controllers.size > 0) {
      return;
    }

    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}

export const taskEventStreamRegistry = new TaskEventStreamRegistry();

export function shutdownTaskEventStreams(): void {
  taskEventStreamRegistry.closeAll();
}

export function mapTaskEventPage(
  events: readonly TaskEvent[],
  taskId: Id,
  after: number,
): readonly TaskEventDto[] {
  if (events.length > MAX_EVENTS_PER_PAGE) {
    throw persistedEventFault();
  }

  let previousSequence = after;
  const mapped: TaskEventDto[] = [];

  for (const event of events) {
    if (
      event.taskId !== taskId ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= previousSequence
    ) {
      throw persistedEventFault();
    }

    try {
      mapped.push(toTaskEventDto(event));
    } catch {
      throw persistedEventFault();
    }

    previousSequence = event.sequence;
  }

  return mapped;
}

export interface TaskEventStreamInput {
  readonly store: TaskStore;
  readonly auth: AuthContext;
  readonly taskId: Id;
  readonly after: number;
  readonly initialStatus: TaskStatus;
  readonly initialEvents: readonly TaskEvent[];
  readonly signal: AbortSignal;
  readonly options: TaskEventStreamConfiguration;
}

/**
 * Durable event replay followed by PostgreSQL polling. Every read is exclusive on the last
 * emitted persisted sequence, and a full page is drained immediately before the poll delay.
 */
export async function* streamTaskEvents(input: TaskEventStreamInput): AsyncGenerator<string> {
  const { store, auth, taskId, signal, options } = input;
  let cursor = input.after;
  let status = input.initialStatus;
  let page = input.initialEvents;
  let now = options.now();
  let nextPollAt = now + options.pollIntervalMs;
  let nextHeartbeatAt = now + options.heartbeatIntervalMs;

  while (!signal.aborted) {
    const mapped = mapTaskEventPage(page, taskId, cursor);

    for (const event of mapped) {
      if (signal.aborted) {
        return;
      }

      cursor = event.sequence;
      yield `id: ${event.sequence}\nevent: task\ndata: ${JSON.stringify(event)}\n\n`;
    }

    if (page.length === MAX_EVENTS_PER_PAGE) {
      page = await store.listEvents(auth, taskId, { after: cursor, limit: MAX_EVENTS_PER_PAGE });
      continue;
    }

    if (isTerminalTaskStatus(status)) {
      return;
    }

    // Poll and heartbeat clocks are separate: a heartbeat is a comment only and cannot
    // advance the persisted event cursor or cause a database read.
    while (!signal.aborted && options.now() < nextPollAt) {
      now = options.now();
      await options.wait(Math.max(1, Math.min(nextPollAt, nextHeartbeatAt) - now), signal);

      if (signal.aborted) {
        return;
      }

      now = options.now();
      if (now >= nextHeartbeatAt) {
        nextHeartbeatAt = now + options.heartbeatIntervalMs;
        yield ': keep-alive\n\n';
      }
    }

    if (signal.aborted) {
      return;
    }

    now = options.now();
    nextPollAt = now + options.pollIntervalMs;
    const view = await store.get(auth, taskId);

    if (signal.aborted || view === null) {
      return;
    }

    status = view.status;
    page = await store.listEvents(auth, taskId, { after: cursor, limit: MAX_EVENTS_PER_PAGE });
  }
}

export function encodeSseFrame(frame: string): Uint8Array {
  return new TextEncoder().encode(frame);
}

function persistedEventFault(): DomainError {
  return new DomainError('DB_UNAVAILABLE', 'persisted task event failed its contract');
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
