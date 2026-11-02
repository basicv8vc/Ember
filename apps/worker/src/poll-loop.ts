import type { LeaseQueue } from '@ember/contracts';
import { isDomainError, InvalidArgumentError, type DomainErrorCode } from '@ember/domain';
import type { LeasedRun } from '@ember/domain';
import { linkAbortSignals, type Sleeper } from '@ember/execution';
import type { Clock } from '@ember/postgres';
import { sleep } from './reaper-loop.js';
import type { WorkerLogger } from './logger.js';
import type { RunHandler, RunHandlerCompletion } from './run-handler.js';

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
  /** Runs whose durable result was committed atomically (no separate finish call). */
  readonly committed: number;
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
 * - `heartbeat() === false` aborts the execution; non-cancelled outcomes and shutdown aborts
 *   skip `finish()`, while a cooperatively confirmed `cancelled` outcome converges the Run via
 *   `finish(run, 'cancelled')` so long as the worker's lease is still valid;
 * - `finish() === false` is logged once and never retried, so a late result can never overwrite
 *   a newer Run;
 * - an execution aborted by process shutdown or lease loss never submits a result, so a
 *   worker cannot fabricate a terminal status from work that was cut short.
 *
 * Liveness rules:
 * - a terminal hand-off aborts the pending heartbeat wait, so the concurrency slot is released
 *   with the Run instead of after one more `heartbeatIntervalMs`;
 * - an empty queue is re-polled every `idleIntervalMs` even while other executions are still in
 *   flight, so a newly arrived Task never waits for an unrelated long-running Run.
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
  const counters = { claimed: 0, finished: 0, rejectedFinishes: 0, abandoned: 0, committed: 0 };

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
    let heartbeatFailed = false;
    let completed = false;

    // The heartbeat wait listens to both stops, so `heartbeatStop.abort()` interrupts a
    // pending wait immediately instead of after `heartbeatIntervalMs`.
    const heartbeatWait = linkAbortSignals(execution.signal, heartbeatStop.signal);

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
        // Wakes on *either* stop: a terminal hand-off (`finish()`) aborts `heartbeatStop`
        // mid-wait, so a completed Run never holds its concurrency slot for another tick.
        await wait(heartbeatIntervalMs, heartbeatWait.signal);

        if (execution.signal.aborted || heartbeatStop.signal.aborted) {
          return;
        }

        let renewed = false;

        try {
          renewed = await queue.heartbeat(run, clock.now());
        } catch (error) {
          heartbeatFailed = true;
          logger.warn('lease heartbeat failed', { ...base, code: codeOf(error) });
          renewed = false;
        }

        if (!renewed) {
          if (completed) {
            return;
          }
          // Not a Task failure: either cancellation was requested or lease ownership moved.
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

      let completion: RunHandlerCompletion;

      try {
        completion = await handler.handle(run, execution.signal);
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

      if (completion.type === 'committed') {
        // The atomic committer already terminalized this Run inside its own transaction.
        // Calling `finish()` here would be a second terminal write, so it is skipped.
        completed = true;
        counters.committed += 1;
        logger.info('run result committed atomically', {
          ...base,
          workspaceVersion: completion.receipt.workspaceVersion,
          durationMs: Math.max(0, Math.round(performance.now() - startedAtHr)),
        });
        return;
      }

      const outcome = completion.outcome;

      // Process shutdown (`signal.aborted`), a throwing heartbeat, or a non-cancelled outcome
      // after heartbeat loss must never submit a finish. A cooperatively confirmed `cancelled`
      // outcome, however, converges the Task/Run immediately via the fenced `finish()` path.
      if (
        signal.aborted ||
        heartbeatFailed ||
        ((execution.signal.aborted || leaseLost) && outcome !== 'cancelled')
      ) {
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

      // Handlers that own non-Run state (a Commitment Occurrence) receive the authoritative
      // verdict of the fenced `finish()` and must only write when it was accepted.
      if (completion.finalize !== undefined) {
        try {
          await completion.finalize(finished);
        } catch (error) {
          // The Run is already terminal; a failing hook must not be retried here.
          logger.error('run finalizer failed', {
            ...base,
            outcome,
            code: codeOf(error),
          });
        }
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
      heartbeatWait.dispose();
    }
  };

  /**
   * Wait for the next poll tick: the idle interval, any in-flight completion, or a stop.
   *
   * The idle interval is **never** replaced by a full in-flight execution, otherwise a
   * newly arrived Task would have to wait for an unrelated, possibly long-running Run to
   * finish even though a concurrency slot is free. The pending timer is cancelled as soon
   * as an execution completes, so the loop does not keep a stray timer alive.
   */
  const waitForNextPoll = async (): Promise<void> => {
    const idleStop = new AbortController();
    const idleSignals = linkAbortSignals(signal, idleStop.signal);
    const idle = wait(idleIntervalMs, idleSignals.signal);

    try {
      await raceWithAbort(inFlight.size === 0 ? idle : Promise.race([...inFlight, idle]), signal);
    } finally {
      idleStop.abort();
      idleSignals.dispose();
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
      await waitForNextPoll();
      continue;
    }

    counters.claimed += 1;
    logger.info('run claimed', {
      taskId: claimed.taskId,
      runId: claimed.runId,
      attempt: claimed.attempt,
      leaseEpoch: claimed.leaseEpoch,
    });

    const job = executeOne(claimed).finally(() => {
      inFlight.delete(job);
    });

    inFlight.add(job);
  }

  await Promise.allSettled(inFlight);

  return Object.freeze({ ...counters });
}
