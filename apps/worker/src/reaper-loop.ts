import type { LeaseQueue } from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import type { Clock } from '@ember/postgres';
import type { WorkerLogger } from './logger.js';

export interface ReaperLoopOptions {
  readonly queue: Pick<LeaseQueue, 'reapExpired'>;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly errorBackoffMs: number;
  readonly logger: WorkerLogger;
  readonly signal: AbortSignal;
}

/** Resolve after `ms`, or immediately when the worker is asked to stop. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Stop-aware, bounded-failure reaper loop.
 *
 * It only terminalizes already-expired durable state; it never claims a Run and never
 * pretends a Task executed. Failures are logged with a fixed domain code and retried with
 * a bounded backoff instead of a busy loop.
 */
export async function runReaperLoop(options: ReaperLoopOptions): Promise<void> {
  const { queue, clock, intervalMs, errorBackoffMs, logger, signal } = options;

  while (!signal.aborted) {
    const startedAt = performance.now();

    try {
      const reaped = await queue.reapExpired(clock.now());
      if (reaped > 0) {
        logger.info('reaped expired leases', {
          count: reaped,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      }
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      logger.error('reaper tick failed', {
        code: isDomainError(error) ? error.code : 'UNEXPECTED',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      await sleep(errorBackoffMs, signal);
      continue;
    }

    if (signal.aborted) {
      break;
    }
    await sleep(intervalMs, signal);
  }
}
