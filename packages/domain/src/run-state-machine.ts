import { InvalidStateTransitionError } from './errors.js';
import { RUN_TERMINAL_STATUSES, type RunStatus, type RunTerminalStatus } from './types.js';

/**
 * The complete Run transition graph.
 *
 * A Run is one execution attempt, not a Task. `failed_retryable` and `lease_expired` are
 * terminal for this attempt; the Task may later receive a new Run.
 *
 * Same-state assignment is rejected (not an implicit no-op). `lease_expired` can never
 * become `succeeded`, because a late worker must not overwrite a newer attempt's result.
 */
export const RUN_TRANSITION_TABLE = Object.freeze({
  created: Object.freeze(['running'] as const),
  running: Object.freeze([
    'succeeded',
    'failed_retryable',
    'failed_terminal',
    'lease_expired',
    'cancelled',
  ] as const),
  succeeded: Object.freeze([] as const),
  failed_retryable: Object.freeze([] as const),
  failed_terminal: Object.freeze([] as const),
  lease_expired: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
}) satisfies Readonly<Record<RunStatus, readonly RunStatus[]>>;

const TERMINAL_RUN_STATUS_SET: ReadonlySet<RunStatus> = new Set(RUN_TERMINAL_STATUSES);

/** Pure predicate. Never touches a database, clock, network or global mutable state. */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  const allowed: readonly RunStatus[] | undefined = RUN_TRANSITION_TABLE[from];
  return allowed?.includes(to) ?? false;
}

/**
 * Validate a Run transition.
 *
 * @returns `to` when the edge is legal.
 * @throws {InvalidStateTransitionError} with code `INVALID_STATE_TRANSITION` otherwise.
 */
export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransitionRun(from, to)) {
    throw new InvalidStateTransitionError('run', from, to);
  }

  return to;
}

/** Every status except `created` and `running` is terminal for that Run. */
export function isTerminalRunStatus(status: RunStatus): status is RunTerminalStatus {
  return TERMINAL_RUN_STATUS_SET.has(status);
}

export { RUN_TERMINAL_STATUSES };
