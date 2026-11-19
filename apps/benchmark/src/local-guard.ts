const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const DEFAULT_LOCAL_TEST_DATABASE_URL =
  'postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test';

const FORBIDDEN_DB_NAME_TOKENS = ['prod', 'production', 'staging', 'live'];
const ALLOWED_LOCAL_QUERY_PARAMS = new Set(['sslmode']);
const ALLOWED_LOCAL_SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require']);

function decodeDatabaseNameSegment(rawPathname: string): string {
  const withoutLeadingSlash = rawPathname.slice(1);
  if (withoutLeadingSlash.length === 0) {
    throw new Error('Unsafe databaseUrl: missing database name in path');
  }
  if (withoutLeadingSlash.includes('/')) {
    throw new Error('Unsafe databaseUrl: multi-segment database path is not permitted');
  }

  let uriDecoded: string;
  let componentDecoded: string;
  try {
    // pg-connection-string decodes pathnames with decodeURI; decode both forms so
    // percent-encoded prod/staging tokens (e.g. %70rod) or encoded slashes cannot bypass checks.
    uriDecoded = decodeURI(withoutLeadingSlash);
    componentDecoded = decodeURIComponent(withoutLeadingSlash);
  } catch {
    throw new Error('invalid databaseUrl: malformed percent-encoding in database name');
  }

  if (uriDecoded !== componentDecoded || componentDecoded.includes('/')) {
    throw new Error('Unsafe databaseUrl: ambiguous percent-encoding in database name');
  }

  return componentDecoded;
}

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

  const trimmed = databaseUrl.trim();
  if (trimmed.length === 0 || trimmed.startsWith('/')) {
    throw new Error('Unsafe databaseUrl: local benchmark requires a postgres:// loopback URL');
  }
  if (/[\s\0]/.test(trimmed)) {
    throw new Error('invalid databaseUrl: whitespace and control characters are not permitted');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('invalid databaseUrl: failed to parse PostgreSQL connection URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `Unsafe databaseUrl protocol "${parsed.protocol}": expected postgres: or postgresql:`,
    );
  }
  if (parsed.hash.length > 0) {
    throw new Error('Unsafe databaseUrl: URL fragments are not permitted');
  }

  for (const [rawKey, rawValue] of parsed.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    if (!ALLOWED_LOCAL_QUERY_PARAMS.has(key)) {
      throw new Error(
        `Unsafe databaseUrl query parameter "${rawKey}": target-changing or unapproved query options are refused by local benchmark guard.`,
      );
    }
    if (!ALLOWED_LOCAL_SSL_MODES.has(rawValue.trim().toLowerCase())) {
      throw new Error(
        `Unsafe databaseUrl sslmode "${rawValue}": local benchmark only permits disable/allow/prefer/require.`,
      );
    }
  }

  let decodedHost: string;
  try {
    decodedHost = decodeURIComponent(parsed.hostname).toLowerCase();
  } catch {
    throw new Error('invalid databaseUrl: malformed percent-encoding in hostname');
  }
  if (parsed.hostname.includes('%') || !LOOPBACK_HOSTS.has(decodedHost)) {
    throw new Error(
      `Unsafe databaseUrl host "${decodedHost}": local benchmark only permits loopback hosts (127.0.0.1, localhost, ::1). Refusing remote/cloud database target.`,
    );
  }

  const dbName = decodeDatabaseNameSegment(parsed.pathname).toLowerCase();
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
