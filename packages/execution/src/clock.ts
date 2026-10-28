import { DomainError, InvalidArgumentError } from '@ember/domain';

/**
 * Minimal clock seam for deterministic execution.
 *
 * It is structurally compatible with the `@ember/postgres` `Clock`, so the worker can pass a
 * single clock to leasing and execution without this package depending on the database
 * layer. `@ember/execution` never reads `Date.now()` directly.
 */
export interface ExecutionClock {
  now(): Date;
}

export const systemExecutionClock: ExecutionClock = Object.freeze({
  now: (): Date => new Date(),
});

/**
 * Injected asynchronous wait.
 *
 * Deterministic tests replace this with an implementation that records the requested delay
 * and resolves immediately, so no test ever depends on wall-clock sleeping.
 */
export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

const MAX_CLOCK_YEAR = 9_999;

/** Real timer-based wait that resolves early (never rejects) when the signal aborts. */
export const realSleeper: Sleeper = (ms, signal) => {
  if (signal?.aborted === true || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
};

/**
 * Validate and copy a caller-supplied timestamp.
 *
 * Rejects invalid `Date` values and dates outside the PostgreSQL `timestamptz` range so a
 * simulated planner never compares against an impossible instant.
 */
export function parseExecutionNow(value: Date, field = 'now'): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidArgumentError([{ path: field, code: 'invalid_date' }]);
  }

  const year = value.getUTCFullYear();

  if (year < 1 || year > MAX_CLOCK_YEAR) {
    throw new InvalidArgumentError([{ path: field, code: 'date_out_of_range' }]);
  }

  return new Date(value.getTime());
}

/** Fail closed when a caller has already cancelled the simulated work. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DomainError('CANCELLED', 'simulated execution was aborted by its caller');
  }
}

/**
 * Validate an optional bounded delay.
 *
 * Simulated latency is always a value the process itself chose, never client input, but it
 * is still bounded so a misconfiguration cannot turn a request into an unbounded wait.
 */
export function parseDelayMs(value: unknown, field: string, maxMs: number, fallback = 0): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maxMs) {
    throw new InvalidArgumentError([{ path: field, code: 'delay_out_of_range' }]);
  }

  return value;
}

/** Validate a simulated timeout: a finite integer in `[1, maxMs]`. */
export function parseBoundedTimeoutMs(value: unknown, field: string, maxMs: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maxMs) {
    throw new InvalidArgumentError([{ path: field, code: 'timeout_out_of_range' }]);
  }

  return value;
}

export interface AbortLink {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Combine several abort signals into one without relying on `AbortSignal.any`.
 *
 * The returned link must be disposed by its owner; otherwise the source signals keep a
 * listener for the lifetime of the process.
 */
export function linkAbortSignals(...sources: readonly (AbortSignal | undefined)[]): AbortLink {
  const controller = new AbortController();
  const detach: (() => void)[] = [];

  for (const source of sources) {
    if (source === undefined) {
      continue;
    }

    if (source.aborted) {
      controller.abort();
      break;
    }

    const onAbort = (): void => {
      controller.abort();
    };

    source.addEventListener('abort', onAbort, { once: true });
    detach.push(() => {
      source.removeEventListener('abort', onAbort);
    });
  }

  return {
    signal: controller.signal,
    dispose: (): void => {
      for (const remove of detach) {
        remove();
      }
      detach.length = 0;
    },
  };
}
