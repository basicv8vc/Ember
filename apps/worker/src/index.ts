import {
  PostgresLeaseQueue,
  createPool,
  describeDatabaseTarget,
  loadDatabaseConfig,
  systemClock,
} from '@ember/postgres';
import { loadWorkerConfig, WorkerConfigError } from './config.js';
import { createWorkerLogger, type WorkerLogger } from './logger.js';
import { runReaperLoop } from './reaper-loop.js';

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

  if (config.mode !== 'reaper-only') {
    throw new WorkerConfigError(
      'poll mode requires the P0B-05 execution router and a real RunHandler; ' +
        'the production worker refuses to claim Tasks without one',
    );
  }

  const databaseConfig = loadDatabaseConfig();
  const logger = createWorkerLogger({ level: config.logLevel });
  const pool = createPool(databaseConfig, {
    onIdleError: () => {
      logger.warn('database idle connection error');
    },
  });
  const queue = new PostgresLeaseQueue(pool, { ...config.lease, clock: systemClock });
  const controller = new AbortController();

  registerShutdown(controller, logger);

  logger.info('worker starting', {
    mode: config.mode,
    workerId: config.workerId,
    database: describeDatabaseTarget(databaseConfig.connectionString),
    leaseDurationMs: config.lease.leaseDurationMs,
    heartbeatIntervalMs: config.lease.heartbeatIntervalMs,
    reaperIntervalMs: config.intervalMs,
  });

  try {
    await runReaperLoop({
      queue,
      clock: systemClock,
      intervalMs: config.intervalMs,
      errorBackoffMs: config.errorBackoffMs,
      logger,
      signal: controller.signal,
    });
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
