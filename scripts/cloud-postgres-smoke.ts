import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, loadDatabaseConfig, runMigrations } from '@ember/postgres';

const EXPECTED_MIGRATIONS = 16;
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const SCHEMA_PREFIX = 'ember_cloud_smoke_';
let currentStep = 'configuration';
const CLOUD_PROVIDERS = ['local-postgres', 'supabase-free', 'neon-free', 'aws-postgres'] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

type SmokePool = ReturnType<typeof createPool>;

interface SmokeClient {
  query(text: string): Promise<unknown>;
}

interface SmokeReport {
  readonly provider: CloudProvider;
  readonly postgresMajor: number;
  readonly ssl: boolean;
  readonly databaseBytes: string;
  readonly maxConnections: string;
  readonly migrationsFirstRun: number;
  readonly migrationsSecondRun: number;
  readonly migrationsAlreadyApplied: number;
  readonly uniqueViolationSqlState: '23505';
  readonly rollbackIsolated: true;
  readonly idempotentReplay: true;
  readonly tenantScopedRead: true;
  readonly skipLockedDistinctClaims: true;
  readonly schemaDropped: true;
}

class SmokeAssertionError extends Error {
  override readonly name = 'SmokeAssertionError';
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SmokeAssertionError(message);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined;
}

async function rollbackIfOpen(client: SmokeClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

async function runSmoke(): Promise<SmokeReport> {
  currentStep = 'connect';
  const providerValue = process.env.CLOUD_POSTGRES_SMOKE_PROVIDER;
  assert(
    CLOUD_PROVIDERS.some((provider) => provider === providerValue),
    'CLOUD_POSTGRES_SMOKE_PROVIDER must be local-postgres, supabase-free, neon-free, or aws-postgres',
  );
  const provider = providerValue as CloudProvider;
  const connectionString = process.env.CLOUD_POSTGRES_SMOKE_DATABASE_URL;
  assert(
    connectionString !== undefined && connectionString.length > 0,
    'CLOUD_POSTGRES_SMOKE_DATABASE_URL is required',
  );

  const config = loadDatabaseConfig({
    DATABASE_URL: connectionString,
    EMBER_DB_POOL_MAX: '4',
    EMBER_DB_CONNECT_TIMEOUT_MS: '5000',
  });
  const adminPool = createPool(config);
  const schema = `${SCHEMA_PREFIX}${randomBytes(8).toString('hex')}`;
  let schemaCreated = false;
  let smokePool: SmokePool | undefined;
  let report: SmokeReport | undefined;
  let originalError: unknown;
  let smokeFailed = false;

  try {
    const connection = await adminPool.query<{
      server_version_num: string;
      ssl: boolean | null;
      database_bytes: string;
      max_connections: string;
    }>(`SELECT current_setting('server_version_num') AS server_version_num,
               (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
               pg_database_size(current_database())::text AS database_bytes,
               current_setting('max_connections') AS max_connections`);
    const server = connection.rows[0];
    assert(server !== undefined, 'server probe returned no row');
    const postgresMajor = Math.floor(Number(server.server_version_num) / 10_000);
    assert(postgresMajor === 17, 'database endpoint is not running PostgreSQL 17');
    assert(server.ssl === true, 'database connection is not using TLS');

    currentStep = 'create-isolated-schema';
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    smokePool = createPool({ ...config, searchPath: schema });

    currentStep = 'migrations-first-run';
    const firstRun = await runMigrations(smokePool, MIGRATIONS_DIR);
    assert(
      firstRun.applied.length === EXPECTED_MIGRATIONS,
      'expected all 16 migrations on first run',
    );
    assert(firstRun.alreadyApplied === 0, 'first migration run unexpectedly skipped history');

    currentStep = 'migrations-second-run';
    const secondRun = await runMigrations(smokePool, MIGRATIONS_DIR);
    assert(secondRun.applied.length === 0, 'second migration run applied new migrations');
    assert(
      secondRun.alreadyApplied === EXPECTED_MIGRATIONS,
      'second migration run did not find all 16 migrations',
    );

    currentStep = 'transaction-unique-tenant-smoke';
    await smokePool.query(`CREATE TABLE smoke_idempotency (
      tenant_id text NOT NULL,
      idempotency_key text NOT NULL,
      payload text NOT NULL,
      CONSTRAINT smoke_idempotency_tenant_key UNIQUE (tenant_id, idempotency_key)
    )`);

    const rollbackClient = await smokePool.connect();
    try {
      await rollbackClient.query('BEGIN');
      await rollbackClient.query(
        'INSERT INTO smoke_idempotency (tenant_id, idempotency_key, payload) VALUES ($1, $2, $3)',
        ['rollback-tenant', 'rollback-key', 'uncommitted'],
      );
      await rollbackClient.query('ROLLBACK');
    } catch (error) {
      await rollbackIfOpen(rollbackClient);
      throw error;
    } finally {
      rollbackClient.release();
    }
    const rolledBack = await smokePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM smoke_idempotency WHERE tenant_id = 'rollback-tenant'`,
    );
    assert(rolledBack.rows[0]?.count === '0', 'rolled-back row became visible');

    const insertOnce = `INSERT INTO smoke_idempotency (tenant_id, idempotency_key, payload)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
    const firstInsert = await smokePool.query(insertOnce, ['tenant-a', 'retry-1', 'accepted']);
    const replayInsert = await smokePool.query(insertOnce, ['tenant-a', 'retry-1', 'accepted']);
    assert(firstInsert.rowCount === 1, 'first idempotent insert was not accepted');
    assert(replayInsert.rowCount === 0, 'duplicate idempotent replay created a second row');

    const otherTenantInsert = await smokePool.query(insertOnce, [
      'tenant-b',
      'retry-1',
      'accepted',
    ]);
    assert(otherTenantInsert.rowCount === 1, 'same idempotency key was not isolated by tenant');
    let uniqueViolation: string | undefined;
    try {
      await smokePool.query(
        'INSERT INTO smoke_idempotency (tenant_id, idempotency_key, payload) VALUES ($1, $2, $3)',
        ['tenant-a', 'retry-1', 'duplicate'],
      );
    } catch (error) {
      uniqueViolation = errorCode(error);
    }
    assert(uniqueViolation === '23505', 'unique conflict did not preserve SQLSTATE 23505');

    const scopedRead = await smokePool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM smoke_idempotency WHERE tenant_id = $1 ORDER BY tenant_id',
      ['tenant-a'],
    );
    assert(
      scopedRead.rows.length === 1 && scopedRead.rows[0]?.tenant_id === 'tenant-a',
      'tenant-scoped read returned a foreign tenant row',
    );

    currentStep = 'lease-skip-locked-smoke';
    await smokePool.query('CREATE TABLE smoke_leases (id integer PRIMARY KEY)');
    await smokePool.query('INSERT INTO smoke_leases (id) VALUES (1), (2)');
    const firstWorker = await smokePool.connect();
    const secondWorker = await smokePool.connect();
    let firstWorkerOpen = false;
    let secondWorkerOpen = false;
    try {
      await firstWorker.query('BEGIN');
      firstWorkerOpen = true;
      await secondWorker.query('BEGIN');
      secondWorkerOpen = true;
      const firstClaim = await firstWorker.query<{ id: number }>(
        'SELECT id FROM smoke_leases ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED',
      );
      const secondClaim = await secondWorker.query<{ id: number }>(
        'SELECT id FROM smoke_leases ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED',
      );
      assert(firstClaim.rows[0]?.id === 1, 'first worker did not lock the first lease');
      assert(secondClaim.rows[0]?.id === 2, 'second worker did not skip the first locked lease');
      await firstWorker.query('COMMIT');
      firstWorkerOpen = false;
      await secondWorker.query('COMMIT');
      secondWorkerOpen = false;
    } finally {
      if (firstWorkerOpen) await rollbackIfOpen(firstWorker);
      if (secondWorkerOpen) await rollbackIfOpen(secondWorker);
      firstWorker.release();
      secondWorker.release();
    }

    report = {
      provider,
      postgresMajor,
      ssl: server.ssl,
      databaseBytes: server.database_bytes,
      maxConnections: server.max_connections,
      migrationsFirstRun: firstRun.applied.length,
      migrationsSecondRun: secondRun.applied.length,
      migrationsAlreadyApplied: secondRun.alreadyApplied,
      uniqueViolationSqlState: '23505',
      rollbackIsolated: true,
      idempotentReplay: true,
      tenantScopedRead: true,
      skipLockedDistinctClaims: true,
      schemaDropped: true,
    };
  } catch (error) {
    originalError = error;
    smokeFailed = true;
  }

  let cleanupFailed = false;
  await smokePool?.end().catch(() => {
    cleanupFailed = true;
  });
  if (schemaCreated) {
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {
      cleanupFailed = true;
    });
  }
  await adminPool.end().catch(() => {
    cleanupFailed = true;
  });
  if (cleanupFailed) {
    currentStep = 'cleanup';
    throw new SmokeAssertionError(`cleanup failed for generated schema ${schema}`);
  }
  if (smokeFailed) {
    throw originalError;
  }
  assert(report !== undefined, 'smoke completed without a report');
  return report;
}

runSmoke()
  .then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  })
  .catch((error: unknown) => {
    const code = errorCode(error);
    const name = error instanceof Error ? error.name : 'UnknownError';
    const safeMessage =
      error instanceof SmokeAssertionError && error.message.length > 0 ? `: ${error.message}` : '';
    process.stderr.write(
      `Cloud PostgreSQL smoke failed during ${currentStep} (${name}${code ? ` ${code}` : ''})${safeMessage}; connection strings and server messages are not logged.\n`,
    );
    process.exitCode = 1;
  });
