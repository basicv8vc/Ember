import type { Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import type { JWTVerifyGetKey } from 'jose';
import {
  LocalBlobStore,
  PostgresAgentRepository,
  PostgresApprovalRepository,
  PostgresArtifactStore,
  PostgresBlobStore,
  PostgresB1ConsumerProvisioningRepository,
  PostgresB1ConsumerSessionRepository,
  PostgresCommitmentRepository,
  PostgresConsentRepository,
  PostgresTaskRepository,
  createPool,
  describeDatabaseTarget,
  loadDatabaseConfig,
  type DatabaseConfig,
} from '@ember/postgres';
import { createApp, SERVICE_NAME } from './app.js';
import { createDevTokenAuthenticator } from './auth/bearer-authenticator.js';
import { PostgresB1MeProjectionReader } from './auth/b1-me-projection-reader.js';
import {
  createB1AuthRuntimeFromEnvironment,
  type ListenerAddress,
} from './auth/b1-auth-runtime.js';
import type { B1SessionPorts } from './auth/session-service.js';
import { loadDevAuthConfig } from './auth/dev-auth-config.js';
import { isLoopbackHost, loadApiConfig, type ApiConfig } from './env.js';
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
      const httpServer = server as HttpServer;
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      // SSE loops were aborted above. Close the remaining accepted sockets after close()
      // stops new connections, so a stuck keep-alive response cannot hold pool shutdown open.
      httpServer.closeAllConnections();
      await serverClosed;
      logger.info('HTTP server closed');
      await pool.end();
      logger.info('database pool closed');
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

export interface ApiApplicationOptions {
  readonly pool: ReturnType<typeof createPool>;
  readonly apiConfig: ApiConfig;
  readonly databaseConfig: DatabaseConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
  /** Must report the actual bound socket; null/string/unbound addresses keep dev sign-in off. */
  readonly actualListener: () => ListenerAddress;
  /** In-process local JWKS fixture for E2E only; production startup does not set this. */
  readonly appleKeyResolver?: JWTVerifyGetKey;
}

/**
 * Build the production API composition with PostgreSQL-backed B1 session ports. The listener
 * is injected as a callback so the R-9 policy samples the real server address on each request.
 */
export function createApiApplication(options: ApiApplicationOptions) {
  const { pool, apiConfig, env, logger } = options;
  const devAuth = loadDevAuthConfig(env);

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

  const ports: B1SessionPorts = {
    provisioning: new PostgresB1ConsumerProvisioningRepository(pool),
    sessions: new PostgresB1ConsumerSessionRepository(pool),
    me: new PostgresB1MeProjectionReader(pool),
  };

  const b1Session = createB1AuthRuntimeFromEnvironment({
    ports,
    env,
    actualListener: options.actualListener,
    ...(options.appleKeyResolver === undefined
      ? {}
      : { appleKeyResolver: options.appleKeyResolver }),
  });

  return createApp({
    readiness: createDatabaseReadiness(pool),
    serviceVersion: SERVICE_VERSION,
    logger,
    authenticator: createDevTokenAuthenticator(devAuth.tenants),
    agentStore: new PostgresAgentRepository(pool),
    taskStore: new PostgresTaskRepository(pool),
    approvalStore: new PostgresApprovalRepository(pool),
    commitmentStore: new PostgresCommitmentRepository(pool),
    consentStore: new PostgresConsentRepository(pool),
    b1Session,
    ...(apiConfig.blobRoot === null
      ? {}
      : {
          artifactStore: new PostgresArtifactStore(
            pool,
            new PostgresBlobStore(pool, new LocalBlobStore({ rootDir: apiConfig.blobRoot })),
          ),
        }),
  });
}

export type StartApiServerOptions = Omit<ApiApplicationOptions, 'actualListener'>;

/**
 * Start the same server used by the executable entry point. `actualListener` is null until
 * `server.address()` reports a bound socket, so dev sign-in cannot be enabled during startup.
 */
export function startApiServer(options: StartApiServerOptions): ServerType {
  const listener: { server?: ServerType } = {};
  const app = createApiApplication({
    ...options,
    actualListener: () => listener.server?.address() ?? null,
  });

  const server = serve(
    { fetch: app.fetch, hostname: options.apiConfig.host, port: options.apiConfig.port },
    (info) => {
      options.logger.info('api listening', {
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        env: options.apiConfig.env,
        host: info.address,
        port: info.port,
        database: describeDatabaseTarget(options.databaseConfig.connectionString),
      });
    },
  );

  listener.server = server;
  return server;
}

async function main(): Promise<void> {
  const env = process.env;
  const apiConfig = loadApiConfig(env);
  const databaseConfig = loadDatabaseConfig(env);
  const logger = createLogger({ level: apiConfig.logLevel });
  const pool = createPool(databaseConfig, {
    onIdleError: (error) => {
      // Category only: an idle-connection fault can include the endpoint it tried to reach.
      logger.warn('database idle connection error', { category: unexpectedErrorCategory(error) });
    },
  });

  if (!isLoopbackHost(apiConfig.host)) {
    logger.warn('binding to a non-loopback interface', {
      host: apiConfig.host,
      reason: 'EMBER_ALLOW_NON_LOOPBACK_BIND=true',
    });
  }

  const server = await (async (): Promise<ServerType> => {
    try {
      return startApiServer({ pool, apiConfig, databaseConfig, env, logger });
    } catch (error) {
      await pool.end();
      throw error;
    }
  })();

  registerShutdown(server, pool, logger);
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && pathToFileURL(resolve(entryPoint)).href === import.meta.url;
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    // Startup failures are operator-facing and happen before any request is served, so the
    // detail is kept: configuration errors never interpolate credentials. Request-path
    // failures take the redacted route in `app.onError` instead.
    process.stderr.write(
      `api failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
