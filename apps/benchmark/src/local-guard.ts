const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const DEFAULT_LOCAL_TEST_DATABASE_URL =
  'postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test';

const FORBIDDEN_DB_NAME_TOKENS = ['prod', 'production', 'staging', 'live'];

/**
 * Validate that a positive safe integer lies within [min, max].
 */
export function assertPositiveSafeInt(
  name: string,
  value: number,
  max: number = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`invalid ${name}: expected an integer in [1, ${max}], got ${String(value)}`);
  }
}

/**
 * Validate concurrency levels for local benchmark sweeps before opening pools.
 */
export function assertValidConcurrencyLevels(
  levels: readonly number[],
  maxConcurrency: number = 100,
): void {
  if (levels.length === 0) {
    throw new Error('invalid concurrencyLevels: expected at least one concurrency level');
  }
  for (const level of levels) {
    assertPositiveSafeInt('concurrencyLevel', level, maxConcurrency);
  }
}

/**
 * Validate that a database URL targets an isolated local loopback test database only.
 * Rejects remote hosts, non-test database names, and production/staging environments even
 * when `--enable-local-load` is passed. Never echoes credentials in thrown errors.
 */
export function assertSafeLocalDatabaseUrl(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const emberEnv = (env.EMBER_ENV ?? '').trim().toLowerCase();
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  if (emberEnv === 'production' || emberEnv === 'staging' || nodeEnv === 'production') {
    throw new Error(
      `Unsafe benchmark environment (EMBER_ENV="${emberEnv || 'unset'}", NODE_ENV="${nodeEnv || 'unset'}"): local V2 benchmark refuses to run in production or staging.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('invalid databaseUrl: failed to parse PostgreSQL connection URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `Unsafe databaseUrl protocol "${parsed.protocol}": expected postgres: or postgresql:`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Unsafe databaseUrl host "${host}": local benchmark only permits loopback hosts (127.0.0.1, localhost, ::1). Refusing remote/cloud database target.`,
    );
  }

  const dbName = parsed.pathname.replace(/^\/+/, '').toLowerCase();
  if (dbName.length === 0) {
    throw new Error('Unsafe databaseUrl: missing database name in path');
  }
  if (FORBIDDEN_DB_NAME_TOKENS.some((tok) => dbName.includes(tok))) {
    throw new Error(
      `Unsafe databaseUrl target database "${dbName}": refuses production/staging/live database names.`,
    );
  }
  if (!dbName.includes('test') && !dbName.includes('local')) {
    throw new Error(
      `Unsafe databaseUrl target database "${dbName}": local V2 benchmark requires an explicit test/local database name (containing "test" or "local", e.g. "ember_test").`,
    );
  }
}

/**
 * Resolve and validate the local test database URL for V2-M0 benchmarks.
 * Deliberately ignores general `DATABASE_URL` so a developer's staging/cloud `DATABASE_URL`
 * can never be migrated or load-tested by accident.
 */
export function resolveSafeLocalDatabaseUrl(
  explicitUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate =
    explicitUrl && explicitUrl.trim().length > 0
      ? explicitUrl.trim()
      : env.TEST_DATABASE_URL && env.TEST_DATABASE_URL.trim().length > 0
        ? env.TEST_DATABASE_URL.trim()
        : DEFAULT_LOCAL_TEST_DATABASE_URL;

  assertSafeLocalDatabaseUrl(candidate, env);
  return candidate;
}
