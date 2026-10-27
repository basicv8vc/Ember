import { z } from 'zod';

/**
 * Configuration errors are raised for malformed local environment input.
 * Messages never contain credential values (in particular the database password).
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface DatabaseConfig {
  /** Full PostgreSQL connection string (already validated). */
  readonly connectionString: string;
  /** Maximum number of pooled connections. */
  readonly maxConnections: number;
  /** How long to wait for a new connection before failing. */
  readonly connectionTimeoutMs: number;
  /** How long an idle pooled connection is kept alive. */
  readonly idleTimeoutMs: number;
  /** Server-side statement timeout applied to every connection. */
  readonly statementTimeoutMs: number;
  /** Optional `search_path` used to isolate test schemas. */
  readonly searchPath?: string;
  /** `application_name` reported to PostgreSQL. */
  readonly applicationName: string;
}

const DEFAULT_POOL_MAX = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export const POSTGRES_DATABASE_URL_PREFIXES = ['postgres:', 'postgresql:'] as const;

const postgresUrlSchema = z
  .string()
  .min(1, 'DATABASE_URL must not be empty')
  .refine((value) => {
    try {
      const url = new URL(value);
      return POSTGRES_DATABASE_URL_PREFIXES.includes(
        url.protocol as (typeof POSTGRES_DATABASE_URL_PREFIXES)[number],
      );
    } catch {
      return false;
    }
  }, 'DATABASE_URL must be a postgres:// or postgresql:// connection string');

const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrlSchema,
  EMBER_DB_POOL_MAX: z.coerce
    .number()
    .int('EMBER_DB_POOL_MAX must be an integer')
    .min(1, 'EMBER_DB_POOL_MAX must be at least 1')
    .max(50, 'EMBER_DB_POOL_MAX must be at most 50')
    .default(DEFAULT_POOL_MAX),
  EMBER_DB_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int('EMBER_DB_CONNECT_TIMEOUT_MS must be an integer')
    .min(100, 'EMBER_DB_CONNECT_TIMEOUT_MS must be at least 100')
    .max(60_000, 'EMBER_DB_CONNECT_TIMEOUT_MS must be at most 60000')
    .default(DEFAULT_CONNECT_TIMEOUT_MS),
  EMBER_DB_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int('EMBER_DB_IDLE_TIMEOUT_MS must be an integer')
    .min(1_000, 'EMBER_DB_IDLE_TIMEOUT_MS must be at least 1000')
    .max(600_000, 'EMBER_DB_IDLE_TIMEOUT_MS must be at most 600000')
    .default(DEFAULT_IDLE_TIMEOUT_MS),
  EMBER_DB_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int('EMBER_DB_STATEMENT_TIMEOUT_MS must be an integer')
    .min(100, 'EMBER_DB_STATEMENT_TIMEOUT_MS must be at least 100')
    .max(300_000, 'EMBER_DB_STATEMENT_TIMEOUT_MS must be at most 300000')
    .default(DEFAULT_STATEMENT_TIMEOUT_MS),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validate database-related environment variables.
 *
 * @throws {ConfigError} when required values are missing or malformed.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = databaseEnvSchema.safeParse(env);

  if (!parsed.success) {
    throw new ConfigError(`Invalid database environment: ${formatIssues(parsed.error)}`);
  }

  const values = parsed.data;

  return {
    connectionString: values.DATABASE_URL,
    maxConnections: values.EMBER_DB_POOL_MAX,
    connectionTimeoutMs: values.EMBER_DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: values.EMBER_DB_IDLE_TIMEOUT_MS,
    statementTimeoutMs: values.EMBER_DB_STATEMENT_TIMEOUT_MS,
    applicationName: 'ember',
  };
}

/**
 * Render a connection string for logs with the password removed.
 * Never log the raw `DATABASE_URL`.
 */
export function redactDatabaseUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.password !== '') {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid-database-url>';
  }
}
