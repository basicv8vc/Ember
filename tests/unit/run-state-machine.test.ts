import { describe, expect, it } from 'vitest';
import {
  RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  RUN_TRANSITION_TABLE,
  DomainError,
  InvalidStateTransitionError,
  canTransitionRun,
  isTerminalRunStatus,
  transitionRun,
} from '@ember/domain';
import type { RunStatus } from '@ember/domain';

const APPROVED_RUN_TRANSITIONS = [
  ['created', 'running'],
  ['running', 'succeeded'],
  ['running', 'failed_retryable'],
  ['running', 'failed_terminal'],
  ['running', 'lease_expired'],
  ['running', 'cancelled'],
] as const satisfies readonly (readonly [RunStatus, RunStatus])[];

const approvedKeys = new Set(APPROVED_RUN_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

const ALL_RUN_PAIRS = RUN_STATUSES.flatMap((from) => RUN_STATUSES.map((to) => [from, to] as const));

const DISALLOWED_RUN_PAIRS = ALL_RUN_PAIRS.filter(
  ([from, to]) => !approvedKeys.has(`${from}->${to}`),
);

function captureTransitionError(from: RunStatus, to: RunStatus): InvalidStateTransitionError {
  try {
    transitionRun(from, to);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidStateTransitionError);
    return error as InvalidStateTransitionError;
  }

  throw new Error(`expected transitionRun('${from}', '${to}') to throw`);
}

describe('Run state machine — legal transitions', () => {
  it('publishes exactly the approved run status set', () => {
    expect(RUN_STATUSES).toEqual([
      'created',
      'running',
      'succeeded',
      'failed_retryable',
      'failed_terminal',
      'lease_expired',
      'cancelled',
    ]);
  });

  it.each(APPROVED_RUN_TRANSITIONS)('allows %s → %s', (from, to) => {
    expect(canTransitionRun(from, to)).toBe(true);
    expect(transitionRun(from, to)).toBe(to);
  });

  it('matches the published transition table exactly', () => {
    const actualEdges = RUN_STATUSES.flatMap((from) =>
      RUN_TRANSITION_TABLE[from].map((to) => `${from}->${to}`),
    ).sort();

    expect(actualEdges).toEqual([...approvedKeys].sort());
  });

  it('requires created → running before any terminal outcome', () => {
    expect(canTransitionRun('created', 'succeeded')).toBe(false);
    expect(canTransitionRun('created', 'cancelled')).toBe(false);
    expect(canTransitionRun('created', 'failed_retryable')).toBe(false);
  });
});

describe('Run state machine — illegal transitions', () => {
  it.each(DISALLOWED_RUN_PAIRS)('rejects %s → %s', (from, to) => {
    expect(canTransitionRun(from, to)).toBe(false);
    const error = captureTransitionError(from, to);

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
    expect(error.retryable).toBe('not_retryable');
    expect(error.entity).toBe('run');
    expect(error.from).toBe(from);
    expect(error.to).toBe(to);
  });

  it('rejects lease_expired → succeeded explicitly', () => {
    expect(canTransitionRun('lease_expired', 'succeeded')).toBe(false);
    expect(() => transitionRun('lease_expired', 'succeeded')).toThrowError(
      InvalidStateTransitionError,
    );
  });

  it.each(RUN_STATUSES)('rejects same-state assignment %s → %s as an implicit no-op', (status) => {
    expect(canTransitionRun(status, status)).toBe(false);
    const error = captureTransitionError(status, status);
    expect(error.from).toBe(status);
    expect(error.to).toBe(status);
  });

  it('uses one stable error code for every illegal transition', () => {
    const codes = new Set(
      DISALLOWED_RUN_PAIRS.map(([from, to]) => {
        try {
          transitionRun(from, to);
        } catch (error) {
          return (error as DomainError).code;
        }
        throw new Error('expected an error');
      }),
    );

    expect([...codes]).toEqual(['INVALID_STATE_TRANSITION']);
  });
});

describe('Run terminal states', () => {
  it('classifies every outcome except created/running as terminal', () => {
    expect(RUN_TERMINAL_STATUSES).toEqual([
      'succeeded',
      'failed_retryable',
      'failed_terminal',
      'lease_expired',
      'cancelled',
    ]);

    for (const status of RUN_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(status !== 'created' && status !== 'running');
    }
  });

  it.each(RUN_TERMINAL_STATUSES)('never restarts terminal run %s', (terminal) => {
    expect(RUN_TRANSITION_TABLE[terminal]).toEqual([]);

    for (const to of RUN_STATUSES) {
      expect(canTransitionRun(terminal, to)).toBe(false);
      expect(() => transitionRun(terminal, to)).toThrowError(InvalidStateTransitionError);
    }
  });

  it('keeps a failed retryable run terminal for that attempt', () => {
    // The *task* may be requeued, but this run cannot become running again.
    expect(canTransitionRun('failed_retryable', 'running')).toBe(false);
    expect(canTransitionRun('failed_retryable', 'succeeded')).toBe(false);
  });
});

describe('Run state machine purity', () => {
  it('exposes a frozen table so callers cannot mutate transition policy', () => {
    expect(Object.isFrozen(RUN_TRANSITION_TABLE)).toBe(true);

    for (const status of RUN_STATUSES) {
      expect(Object.isFrozen(RUN_TRANSITION_TABLE[status])).toBe(true);
    }
  });

  it('is deterministic across repeated calls', () => {
    const first = RUN_STATUSES.map((from) => RUN_STATUSES.map((to) => canTransitionRun(from, to)));
    const second = RUN_STATUSES.map((from) => RUN_STATUSES.map((to) => canTransitionRun(from, to)));

    expect(second).toEqual(first);
  });
});
