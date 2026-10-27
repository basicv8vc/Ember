import pg from 'pg';
import { ConfigError, type DatabaseConfig } from './config.js';

const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface PoolHooks {
  /** Called when an idle pooled client reports an error (e.g. server restart). */
  readonly onIdleError?: (error: Error) => void;
}

/**
 * Create a `pg` connection pool. No connection is opened until the first query,
 * which keeps process startup and liveness independent from database uptime.
 */
export function createPool(config: DatabaseConfig, hooks: PoolHooks = {}): pg.Pool {
  const serverOptions = [`-c statement_timeout=${config.statementTimeoutMs}`];

  if (config.searchPath !== undefined) {
    if (!POSTGRES_IDENTIFIER.test(config.searchPath)) {
      throw new ConfigError('searchPath must be a lowercase PostgreSQL identifier');
    }
    serverOptions.push(`-c search_path=${config.searchPath}`);
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    application_name: config.applicationName,
    options: serverOptions.join(' '),
  });

  pool.on('error', (error: Error) => {
    hooks.onIdleError?.(error);
  });

  return pool;
}
