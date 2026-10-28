import {
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  createPool,
  describeDatabaseTarget,
  loadDatabaseConfig,
  systemClock,
} from '@ember/postgres';
import {
  DeterministicExecutionRouter,
  DeterministicExecutor,
  EXECUTABLE_TASK_KINDS,
} from '@ember/execution';
import { loadWorkerConfig } from './config.js';
import { createWorkerLogger, type WorkerLogger } from './logger.js';
import { runPollLoop } from './poll-loop.js';
import { runReaperLoop } from './reaper-loop.js';
import { createRunHandler } from './run-handler.js';

function registerShutdown(controller: AbortController, logger: WorkerLogger): void {
  let stopping = false;

  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('worker stopping', { signal });
    controller.abort();
  };

  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const databaseConfig = loadDatabaseConfig();
  const logger = createWorkerLogger({ level: config.logLevel });
  const pool = createPool(databaseConfig, {
    onIdleError: () => {
      logger.warn('database idle connection error');
    },
  });

  // Claim eligibility is derived from the executor's own capability list, so the worker can
  // never claim a Task kind it has no deterministic branch for.
  const queue = new PostgresLeaseQueue(pool, {
    ...config.lease,
    clock: systemClock,
    ...(config.mode === 'poll' ? { claimableKinds: EXECUTABLE_TASK_KINDS } : {}),
  });
  const controller = new AbortController();

  registerShutdown(controller, logger);

  logger.info('worker starting', {
    mode: config.mode,
    env: config.env,
    simulatedExecution: config.simulatedExecution,
    workerId: config.workerId,
    database: describeDatabaseTarget(databaseConfig.connectionString),
    leaseDurationMs: config.lease.leaseDurationMs,
    heartbeatIntervalMs: config.lease.heartbeatIntervalMs,
    reaperIntervalMs: config.intervalMs,
    concurrency: config.concurrency,
    ...(config.mode === 'poll' ? { claimableKinds: EXECUTABLE_TASK_KINDS } : {}),
  });

  try {
    const reaper = runReaperLoop({
      queue,
      clock: systemClock,
      intervalMs: config.intervalMs,
      errorBackoffMs: config.errorBackoffMs,
      logger,
      signal: controller.signal,
    });

    if (config.mode === 'reaper-only') {
      await reaper;
      return;
    }

    const handler = createRunHandler({
      contextReader: new PostgresRunExecutionContextReader(pool),
      router: new DeterministicExecutionRouter(),
      executor: new DeterministicExecutor(),
      clock: systemClock,
      logger,
    });

    // Both loops share one stop signal: a shutdown drains the reaper and stops claiming new
    // Runs, while in-flight simulations observe the abort and discard their results.
    const summary = await Promise.all([
      reaper,
      runPollLoop({
        queue,
        handler,
        clock: systemClock,
        workerId: config.workerId,
        concurrency: config.concurrency,
        heartbeatIntervalMs: config.lease.heartbeatIntervalMs,
        idleIntervalMs: config.intervalMs,
        errorBackoffMs: config.errorBackoffMs,
        logger,
        signal: controller.signal,
      }),
    ]).then(([, pollSummary]) => pollSummary);

    logger.info('poll loop stopped', { ...summary, workerId: config.workerId });
  } finally {
    await pool.end();
    logger.info('worker stopped', { workerId: config.workerId });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`worker failed: ${message}\n`);
  process.exitCode = 1;
});
