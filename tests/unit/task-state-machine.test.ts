import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  TASK_TRANSITION_TABLE,
  canTransitionTask,
  isTerminalTaskStatus,
  transitionTask,
  DomainError,
  InvalidStateTransitionError,
} from '@ember/domain';
import type { TaskStatus } from '@ember/domain';

/**
 * Independent copy of the approved P0-B graph. Keeping it here (rather than deriving it
 * from the implementation table) means an accidental table edit fails the test suite.
 */
const APPROVED_TASK_TRANSITIONS = [
  ['queued', 'running'],
  ['queued', 'cancelled'],
  ['running', 'completed'],
  ['running', 'waiting_approval'],
  ['running', 'retryable_failed'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['waiting_approval', 'queued'],
  ['waiting_approval', 'failed'],
  ['waiting_approval', 'cancelled'],
  ['retryable_failed', 'queued'],
  ['retryable_failed', 'failed'],
] as const satisfies readonly (readonly [TaskStatus, TaskStatus])[];

const approvedKeys = new Set(APPROVED_TASK_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

const ALL_TASK_PAIRS = TASK_STATUSES.flatMap((from) =>
  TASK_STATUSES.map((to) => [from, to] as const),
);

const DISALLOWED_TASK_PAIRS = ALL_TASK_PAIRS.filter(
  ([from, to]) => !approvedKeys.has(`${from}->${to}`),
);

function captureTransitionError(from: TaskStatus, to: TaskStatus): InvalidStateTransitionError {
  try {
    transitionTask(from, to);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidStateTransitionError);
    return error as InvalidStateTransitionError;
  }

  throw new Error(`expected transitionTask('${from}', '${to}') to throw`);
}

describe('Task state machine — legal transitions', () => {
  it.each(APPROVED_TASK_TRANSITIONS)('allows %s → %s', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
    expect(transitionTask(from, to)).toBe(to);
  });

  it('matches the published transition table exactly', () => {
    const actualEdges = TASK_STATUSES.flatMap((from) =>
      TASK_TRANSITION_TABLE[from].map((to) => `${from}->${to}`),
    ).sort();

    expect(actualEdges).toEqual([...approvedKeys].sort());
  });

  it('supports the documented approval and retry semantics', () => {
    expect(transitionTask('waiting_approval', 'queued')).toBe('queued');
    expect(transitionTask('waiting_approval', 'failed')).toBe('failed');
    expect(transitionTask('retryable_failed', 'queued')).toBe('queued');
    expect(transitionTask('retryable_failed', 'failed')).toBe('failed');
    expect(transitionTask('running', 'retryable_failed')).toBe('retryable_failed');
    expect(transitionTask('running', 'cancelled')).toBe('cancelled');
  });

  it('does not add undocumented edges (for example retryable_failed → cancelled)', () => {
    expect(canTransitionTask('retryable_failed', 'cancelled')).toBe(false);
    expect(canTransitionTask('waiting_approval', 'running')).toBe(false);
    expect(canTransitionTask('created' as TaskStatus, 'running')).toBe(false);
  });
});

describe('Task state machine — illegal transitions', () => {
  it.each(DISALLOWED_TASK_PAIRS)('rejects %s → %s', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(false);
    const error = captureTransitionError(from, to);

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
    expect(error.retryable).toBe('not_retryable');
    expect(error.entity).toBe('task');
    expect(error.from).toBe(from);
    expect(error.to).toBe(to);
  });

  it.each([
    ['queued', 'completed'],
    ['waiting_approval', 'completed'],
    ['retryable_failed', 'completed'],
    ['queued', 'retryable_failed'],
    ['waiting_approval', 'running'],
    ['retryable_failed', 'running'],
  ] as const)('does not allow %s → %s shortcut', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(false);
    expect(() => transitionTask(from, to)).toThrowError(InvalidStateTransitionError);
  });

  it.each(TASK_STATUSES)('rejects same-state assignment %s → %s as an implicit no-op', (status) => {
    expect(canTransitionTask(status, status)).toBe(false);
    const error = captureTransitionError(status, status);
    expect(error.from).toBe(status);
    expect(error.to).toBe(status);
  });

  it('uses one stable error code for every illegal transition', () => {
    const codes = new Set(
      DISALLOWED_TASK_PAIRS.map(([from, to]) => {
        try {
          transitionTask(from, to);
        } catch (error) {
          return (error as DomainError).code;
        }
        throw new Error('expected an error');
      }),
    );

    expect([...codes]).toEqual(['INVALID_STATE_TRANSITION']);
  });
});

describe('Task terminal states', () => {
  it('classifies exactly completed, failed and cancelled as terminal', () => {
    expect(TASK_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'cancelled']);

    for (const status of TASK_STATUSES) {
      expect(isTerminalTaskStatus(status)).toBe(
        status === 'completed' || status === 'failed' || status === 'cancelled',
      );
    }
  });

  it.each(TASK_TERMINAL_STATUSES)('never leaves terminal state %s', (terminal) => {
    expect(TASK_TRANSITION_TABLE[terminal]).toEqual([]);

    for (const to of TASK_STATUSES) {
      expect(canTransitionTask(terminal, to)).toBe(false);
      expect(() => transitionTask(terminal, to)).toThrowError(InvalidStateTransitionError);
    }
  });

  it('cannot restart, complete over cancellation, or cancel completion', () => {
    expect(canTransitionTask('completed', 'running')).toBe(false);
    expect(canTransitionTask('failed', 'running')).toBe(false);
    expect(canTransitionTask('cancelled', 'completed')).toBe(false);
    expect(canTransitionTask('completed', 'cancelled')).toBe(false);
  });
});

describe('Task state machine purity', () => {
  it('exposes a frozen table so callers cannot mutate transition policy', () => {
    expect(Object.isFrozen(TASK_TRANSITION_TABLE)).toBe(true);

    for (const status of TASK_STATUSES) {
      expect(Object.isFrozen(TASK_TRANSITION_TABLE[status])).toBe(true);
    }
  });

  it('is deterministic across repeated calls', () => {
    const first = TASK_STATUSES.map((from) =>
      TASK_STATUSES.map((to) => canTransitionTask(from, to)),
    );
    const second = TASK_STATUSES.map((from) =>
      TASK_STATUSES.map((to) => canTransitionTask(from, to)),
    );

    expect(second).toEqual(first);
  });
});
