import { InvalidStateTransitionError } from './errors.js';
import { TASK_TERMINAL_STATUSES, type TaskStatus, type TaskTerminalStatus } from './types.js';

/**
 * The complete, approved P0-B Task transition graph.
 *
 * Only these edges are legal. Same-state assignment is *not* a no-op: it is rejected like
 * any other unlisted transition so callers cannot silently bypass state validation.
 *
 * The table intentionally does NOT include:
 * - `waiting_external` (reserved by the RFC, outside P0-B);
 * - cancelling a `retryable_failed` task (not covered by the approved graph; see
 *   `docs/P0B-02-IMPLEMENTATION.md`, open question OQ-1).
 */
export const TASK_TRANSITION_TABLE = Object.freeze({
  queued: Object.freeze(['running', 'cancelled'] as const),
  running: Object.freeze([
    'completed',
    'waiting_approval',
    'retryable_failed',
    'failed',
    'cancelled',
  ] as const),
  waiting_approval: Object.freeze(['queued', 'failed', 'cancelled'] as const),
  retryable_failed: Object.freeze(['queued', 'failed'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
}) satisfies Readonly<Record<TaskStatus, readonly TaskStatus[]>>;

const TERMINAL_TASK_STATUS_SET: ReadonlySet<TaskStatus> = new Set(TASK_TERMINAL_STATUSES);

/** Pure predicate. Never touches a database, clock, network or global mutable state. */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  const allowed: readonly TaskStatus[] | undefined = TASK_TRANSITION_TABLE[from];
  return allowed?.includes(to) ?? false;
}

/**
 * Validate a Task transition.
 *
 * @returns `to` when the edge is legal.
 * @throws {InvalidStateTransitionError} with code `INVALID_STATE_TRANSITION` otherwise.
 */
export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransitionTask(from, to)) {
    throw new InvalidStateTransitionError('task', from, to);
  }

  return to;
}

/**
 * Terminal task statuses are `completed`, `failed` and `cancelled`. No edge leaves them,
 * so a late worker cannot rewrite a finished task.
 */
export function isTerminalTaskStatus(status: TaskStatus): status is TaskTerminalStatus {
  return TERMINAL_TASK_STATUS_SET.has(status);
}

export { TASK_TERMINAL_STATUSES };
