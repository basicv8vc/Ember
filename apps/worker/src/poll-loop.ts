import type { LeaseQueue } from '@ember/contracts';
import { isDomainError, InvalidArgumentError, type DomainErrorCode } from '@ember/domain';
import type { LeasedRun, RunTerminalStatus } from '@ember/domain';
import type { Sleeper } from '@ember/execution';
import type { Clock } from '@ember/postgres';
import { sleep } from './reaper-loop.js';
import type { WorkerLogger } from './logger.js';
import type { RunHandler } from './run-handler.js';

export interface PollLoopOptions {
  /** Only the three fenced operations the loop is allowed to use. */
  readonly queue: Pick<LeaseQueue, 'claimNext' | 'heartbeat' | 'finish'>;
  readonly handler: RunHandler;
  readonly clock: Clock;
  readonly workerId: string;
  /** Maximum number of concurrent in-flight executions. */
  readonly concurrency: number;
  readonly heartbeatIntervalMs: number;
  /** Bounded wait when the queue is empty. */
  readonly idleIntervalMs: number;
  readonly errorBackoffMs: number;
  readonly logger: WorkerLogger;
  readonly signal: AbortSignal;
  /** Injectable wait (tests pass a deterministic implementation). */
  readonly sleep?: Sleeper;
}

/** Observable counters; the loop itself owns no durable state. */
export interface PollLoopSummary {
  readonly claimed: number;
  readonly finished: number;
  /** Executions whose `finish()` returned `false` (lease lost / fenced). */
  readonly rejectedFinishes: number;
  /** Executions stopped by shutdown, lease loss, cancellation or a stale context. */
  readonly abandoned: number;
}

function codeOf(error: unknown): DomainErrorCode | 'UNEXPECTED' {
  return isDomainError(error) ? error.code : 'UNEXPECTED';
}

/** Resolve when `promise` settles or the signal aborts, whichever happens first. */
function raceWithAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;

    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', done);
      resolve();
    };

    signal.addEventListener('abort', done, { once: true });
    void promise.then(done, done);
  });
}

/**
 * Bounded, stop-aware claim/execute loop.
 *
 * Lifecycle per claimed Run:
 *
 * ```text
 * claimNext() ──▶ read context ──▶ route ──▶ execute ──▶ finish()
 *      │                                          ▲
 *      └── Heartbeat (heartbeatIntervalMs) ────────┘
 * ```
 *
 * The loop never writes Task/Run rows itself: `finish()` is the only terminal writer, so
 * Fencing, retry scheduling and cancellation convergence remain P0B-04's responsibility.
 *
 * Safety rules:
 * - `heartbeat() === false` aborts the execution and **skips** `finish()`; it is never treated
 *   as an execution failure, and the database state plus the Reaper decide what happens next;
 * - `finish() === false` is logged once and never retried, so a late result can never overwrite
 *   a newer Run;
 * - an aborted execution (shutdown, lease loss, cancellation) never submits a result, so a
 *   worker cannot fabricate a terminal status from work that was cut short.
 */
export async function runPollLoop(options: PollLoopOptions): Promise<PollLoopSummary> {
  const { queue, handler, clock, workerId, concurrency, heartbeatIntervalMs, idleIntervalMs } =
    options;
  const { errorBackoffMs, logger, signal } = options;
  const wait = options.sleep ?? sleep;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new InvalidArgumentError([{ path: 'concurrency', code: 'invalid_value' }]);
  }

  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new InvalidArgumentError([{ path: 'heartbeatIntervalMs', code: 'invalid_value' }]);
  }

  const inFlight = new Set<Promise<void>>();
  const counters = { claimed: 0, finished: 0, rejectedFinishes: 0, abandoned: 0 };

  const executeOne = async (run: LeasedRun): Promise<void> => {
    const startedAtHr = performance.now();
    const execution = new AbortController();
    const heartbeatStop = new AbortController();
    const base = {
      taskId: run.taskId,
      runId: run.runId,
      attempt: run.attempt,
      leaseEpoch: run.leaseEpoch,
    } as const;

    let leaseLost = false;
    let completed = false;

    const onStop = (): void => {
      execution.abort();
    };

    if (signal.aborted) {
      execution.abort();
    } else {
      signal.addEventListener('abort', onStop, { once: true });
    }

    const heartbeatLoop = (async (): Promise<void> => {
      while (!execution.signal.aborted && !heartbeatStop.signal.aborted) {
        await wait(heartbeatIntervalMs, execution.signal);

        if (execution.signal.aborted || heartbeatStop.signal.aborted) {
          return;
        }

        let renewed = false;

        try {
          renewed = await queue.heartbeat(run, clock.now());
        } catch (error) {
          logger.warn('lease heartbeat failed', { ...base, code: codeOf(error) });
          renewed = false;
        }

        if (!renewed) {
          if (completed) {
            return;
          }
          // Not a Task failure: this worker simply no longer owns the execution right.
          leaseLost = true;
          execution.abort();
          return;
        }

        logger.debug('lease renewed', base);
      }
    })();

    try {
      if (execution.signal.aborted) {
        counters.abandoned += 1;
        return;
      }

      let outcome: RunTerminalStatus;

      try {
        outcome = await handler.handle(run, execution.signal);
      } catch (error) {
        // A stale/foreign context means nothing may be submitted; anything else is a
        // programming fault and must not fabricate a terminal state either.
        logger.warn('run execution abandoned', {
          ...base,
          code: codeOf(error),
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        counters.abandoned += 1;
        return;
      }

      if (execution.signal.aborted || leaseLost) {
        logger.warn('execution aborted; result discarded', {
          ...base,
          leaseLost,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        counters.abandoned += 1;
        return;
      }

      let finished = false;

      try {
        finished = await queue.finish(run, outcome);
      } catch (error) {
        logger.error('finish failed', {
          ...base,
          code: codeOf(error),
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        counters.rejectedFinishes += 1;
        return;
      } finally {
        completed = true;
      }

      if (!finished) {
        // Never retry a rejected finish: the lease belongs to someone else now.
        logger.warn('finish rejected; lease no longer valid', {
          ...base,
          outcome,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        counters.rejectedFinishes += 1;
        return;
      }

      counters.finished += 1;
      logger.info('run finished', {
        ...base,
        outcome,
        durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
      });
    } finally {
      heartbeatStop.abort();
      signal.removeEventListener('abort', onStop);
      await heartbeatLoop;
    }
  };

  while (!signal.aborted) {
    if (inFlight.size >= concurrency) {
      await raceWithAbort(Promise.race(inFlight), signal);
      continue;
    }

    let claimed: LeasedRun | null;

    try {
      claimed = await queue.claimNext(workerId, clock.now());
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      logger.error('claim failed', { code: codeOf(error) });
      await wait(errorBackoffMs, signal);
      continue;
    }

    if (claimed === null) {
      if (inFlight.size > 0) {
        // Do not busy-loop while executions are still in flight.
        await raceWithAbort(Promise.race(inFlight), signal);
      } else {
        await wait(idleIntervalMs, signal);
      }
      continue;
    }

    counters.claimed += 1;
    const run = claimed;
    const task = executeOne(run);
    inFlight.add(task);
    void task.then(
      () => {
        inFlight.delete(task);
      },
      () => {
        inFlight.delete(task);
      },
    );
  }

  // Graceful stop: wait for the in-flight executions, which observe the abort signal.
  await Promise.allSettled([...inFlight]);

  return Object.freeze({ ...counters });
}
