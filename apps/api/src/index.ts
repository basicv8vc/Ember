import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { createPool, describeDatabaseTarget, loadDatabaseConfig } from '@ember/postgres';
import { createApp, SERVICE_NAME } from './app.js';
import { isLoopbackHost, loadApiConfig } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { createDatabaseReadiness } from './readiness.js';

const SERVICE_VERSION = '0.0.0';

interface CloseablePool {
  end(): Promise<void>;
}

function registerShutdown(server: ServerType, pool: CloseablePool, logger: Logger): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await pool.end();
      clearTimeout(forceExit);
      logger.info('shutdown complete');
    } catch (error) {
      clearTimeout(forceExit);
      logger.error('shutdown failed', { error: (error as Error).message });
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

function main(): void {
  const apiConfig = loadApiConfig();
  const databaseConfig = loadDatabaseConfig();
  const logger = createLogger({ level: apiConfig.logLevel });

  const pool = createPool(databaseConfig, {
    onIdleError: (error) => {
      logger.warn('database idle connection error', { error: error.message });
    },
  });

  const app = createApp({
    readiness: createDatabaseReadiness(pool),
    serviceVersion: SERVICE_VERSION,
  });

  if (!isLoopbackHost(apiConfig.host)) {
    logger.warn('binding to a non-loopback interface', {
      host: apiConfig.host,
      reason: 'EMBER_ALLOW_NON_LOOPBACK_BIND=true',
    });
  }

  const server = serve(
    { fetch: app.fetch, hostname: apiConfig.host, port: apiConfig.port },
    (info) => {
      logger.info('api listening', {
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        env: apiConfig.env,
        host: info.address,
        port: info.port,
        database: describeDatabaseTarget(databaseConfig.connectionString),
      });
    },
  );

  registerShutdown(server, pool, logger);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `api failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
