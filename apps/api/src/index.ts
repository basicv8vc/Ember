import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import {
  PostgresTaskRepository,
  createPool,
  describeDatabaseTarget,
  loadDatabaseConfig,
} from '@ember/postgres';
import { createApp, SERVICE_NAME } from './app.js';
import { createDevTokenAuthenticator } from './auth/bearer-authenticator.js';
import { loadDevAuthConfig } from './auth/dev-auth-config.js';
import { isLoopbackHost, loadApiConfig } from './env.js';
import { unexpectedErrorCategory } from './http/error-mapping.js';
import { createLogger, type Logger } from './logger.js';
import { createDatabaseReadiness } from './readiness.js';
import { shutdownTaskEventStreams } from './tasks/event-stream.js';

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
    // Abort SSE poll loops before server.close() waits for their long-lived responses.
    shutdownTaskEventStreams();

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
      // Same rule as the request path: a shutdown fault is logged by category only, because a
      // pool/server error message can carry a connection string or a socket address.
      logger.error('shutdown failed', { category: unexpectedErrorCategory(error) });
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

function main(): void {
  const apiConfig = loadApiConfig();
  const databaseConfig = loadDatabaseConfig();
  const devAuth = loadDevAuthConfig();
  const logger = createLogger({ level: apiConfig.logLevel });

  if (devAuth.tenants.length === 0) {
    // Fail closed, but loudly: the process still starts so the cause is a log line rather
    // than a crash loop, and every `/v1` request is rejected with 401.
    logger.warn('no dev tenant credentials configured; every /v1 request will be rejected', {
      hint: 'set EMBER_DEV_AUTH_TENANT_A_TOKEN/_TENANT_ID/_PRINCIPAL_ID (optionally slot B)',
    });
  } else {
    // Count only: token values and ids never reach a log line.
    logger.info('dev tenant credentials loaded', { tenants: devAuth.tenants.length });
  }

  const pool = createPool(databaseConfig, {
    onIdleError: (error) => {
      // Category only: an idle-connection fault can include the endpoint it tried to reach.
      logger.warn('database idle connection error', { category: unexpectedErrorCategory(error) });
    },
  });

  const app = createApp({
    readiness: createDatabaseReadiness(pool),
    serviceVersion: SERVICE_VERSION,
    logger,
    authenticator: createDevTokenAuthenticator(devAuth.tenants),
    taskStore: new PostgresTaskRepository(pool),
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
  // Startup failures are operator-facing and happen before any request is served, so the
  // detail is kept: the only errors reachable here are config-validation errors, which name
  // environment variables and never interpolate a credential value. Request-path faults take
  // the redacted route in `app.onError` instead.
  process.stderr.write(
    `api failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
