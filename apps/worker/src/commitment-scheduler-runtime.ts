import type { ConsentAuthority } from '@ember/connectors';
import type { ConsentFenceAuthority } from '@ember/execution';
import {
  PostgresCommitmentRepository,
  PostgresCommitmentTaskDispatcher,
  PostgresConsentPublicationGuard,
  systemClock,
} from '@ember/postgres';
import type { createPool } from '@ember/postgres';
import { evaluateSchedulerConsentGate } from './commitment-consent.js';
import { CommitmentScheduler, DEFAULT_MAX_ERROR_BACKOFF_MS } from './commitment-scheduler.js';
import type { WorkerConfig } from './config.js';
import type { WorkerLogger } from './logger.js';

export interface CommitmentSchedulerRuntimeOptions {
  readonly config: WorkerConfig;
  readonly pool: ReturnType<typeof createPool>;
  readonly logger: WorkerLogger;
  readonly signal: AbortSignal;
  /**
   * Consent integration seam.
   *
   * The Scheduler may only run when this is a durable, fence-capable authority: it converts due
   * commitments into dispatched Tasks autonomously, and every one of those Tasks must be able to
   * publish under a versioned Consent authorization. Missing, placeholder, or non-attributable
   * authorities keep the Scheduler stopped instead of generating work that can never publish.
   */
  readonly consent?: ConsentAuthority | ConsentFenceAuthority;
}

/**
 * Start the P0-C3B Commitment Scheduler inside the Worker process lifecycle.
 *
 * - Disabled by default; `EMBER_SCHEDULER_ENABLED=true` is the only way to switch it on, and the
 *   Worker config loader already refuses that while durable Consent persistence is missing.
 * - A missing or non-attributable Consent authority is a hard startup refusal (fail closed), not
 *   a warning: dispatching work whose Outcome can never be published is worse than not starting.
 * - It shares the Worker's `AbortController`, so SIGINT/SIGTERM drain it with the poll loop.
 * - `runLoop()` never rejects: failures are logged and retried with bounded exponential
 *   backoff, so a scheduler fault cannot take the Worker down.
 * - The loop is *not* awaited here; callers include it in the same `Promise.all` as the other
 *   loops so shutdown ordering is explicit.
 */
export function startCommitmentScheduler(
  options: CommitmentSchedulerRuntimeOptions,
): Promise<void> {
  const { config, logger, signal, consent } = options;
  const pool = options.pool;

  if (!config.scheduler.enabled) {
    logger.info('commitment scheduler disabled', {
      hint: 'set EMBER_SCHEDULER_ENABLED=true to enable autonomous commitment scheduling',
    });
    return Promise.resolve();
  }

  const gate = evaluateSchedulerConsentGate(consent);

  if (!gate.ready) {
    logger.error('commitment scheduler refused to start', {
      reason: gate.reason,
      hint: 'wire a durable, fence-capable Source Consent authority before enabling the scheduler',
    });
    return Promise.resolve();
  }

  if (config.mode !== 'poll') {
    logger.warn('commitment scheduler is enabled without a poll loop; occurrences will queue up', {
      mode: config.mode,
    });
  }

  // The scheduler's own store uses the same publication guard as the runtime, so reconciliation
  // paths cannot bypass the transaction-scoped Consent check either.
  const store = new PostgresCommitmentRepository(pool, {
    consentPublicationGuard: new PostgresConsentPublicationGuard(),
  });
  const dispatcher = new PostgresCommitmentTaskDispatcher(pool);
  const scheduler = new CommitmentScheduler(store, dispatcher, {
    enabled: true,
    pollIntervalMs: config.scheduler.intervalMs,
    batchSize: config.scheduler.batchSize,
    concurrency: config.scheduler.concurrency,
    stalledTimeoutSeconds: config.scheduler.stalledTimeoutSeconds,
    errorBackoffMs: config.errorBackoffMs,
    maxErrorBackoffMs: DEFAULT_MAX_ERROR_BACKOFF_MS,
    clock: systemClock,
    logger,
  });

  logger.info('commitment scheduler enabled', {
    intervalMs: config.scheduler.intervalMs,
    batchSize: config.scheduler.batchSize,
    stalledTimeoutSeconds: config.scheduler.stalledTimeoutSeconds,
  });

  return scheduler.runLoop(signal).catch((error: unknown) => {
    // Defensive: `runLoop` is internally guarded, but the Worker must never die of a scheduler.
    logger.error('commitment scheduler loop failed unexpectedly', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
