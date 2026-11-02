import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, loadDatabaseConfig, MigrationError, runMigrations } from '@ember/postgres';
import { createDatabaseReadiness } from '../../apps/api/src/readiness.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const schemaPattern = /^ember_it_[a-f0-9]{12}$/;

let adminPool: ReturnType<typeof createPool> | undefined;
let pool: ReturnType<typeof createPool> | undefined;
let schema = '';

function requirePool(): NonNullable<typeof pool> {
  if (pool === undefined) {
    throw new Error('integration test pool was not initialised');
  }
  return pool;
}

beforeAll(async () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (testDatabaseUrl === undefined || testDatabaseUrl.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is required for integration tests. ' +
        'Start the local database with `pnpm dev:db` and copy `.env.example` to `.env.local`.',
    );
  }

  const baseConfig = loadDatabaseConfig({ DATABASE_URL: testDatabaseUrl });
  adminPool = createPool({ ...baseConfig, maxConnections: 2 });

  schema = `ember_it_${randomBytes(6).toString('hex')}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ ...baseConfig, maxConnections: 4, searchPath: schema });
});

afterAll(async () => {
  await pool?.end();
  pool = undefined;

  if (adminPool !== undefined) {
    if (schema !== '' && schemaPattern.test(schema)) {
      // Only ever drop the schema this test run created.
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await adminPool.end();
    adminPool = undefined;
  }
});

describe('PostgreSQL migrations (real database)', () => {
  it('connects to an isolated test schema', async () => {
    const result = await requirePool().query<{ current_schema: string }>('SELECT current_schema()');

    expect(result.rows[0]?.current_schema).toBe(schema);
    expect(schemaPattern.test(schema)).toBe(true);
  });

  it('applies migrations from an empty schema and records the version', async () => {
    const result = await runMigrations(requirePool(), migrationsDir);

    expect(result.applied).toHaveLength(9);
    expect(result.applied.map((migration) => migration.id)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
    ]);
    expect(result.applied[1]?.name).toBe('0002_durable_task_inbox.sql');
    expect(result.applied[2]?.name).toBe('0003_tasks_current_run_tenant_fk.sql');
    expect(result.applied[3]?.name).toBe('0004_lease_fencing_and_retry.sql');
    expect(result.applied[4]?.name).toBe('0005_p0b06_artifacts_workspace_checkpoint.sql');
    expect(result.applied[5]?.name).toBe('0006_p0b08b_persistent_budget.sql');
    expect(result.applied[6]?.name).toBe('0007_p0b08d_persistent_mock_approval.sql');
    expect(result.applied[7]?.name).toBe('0008_p0c3_commitments.sql');
    expect(result.applied[8]?.name).toBe('0009_p0c3b_runtime_closure.sql');
    expect(result.alreadyApplied).toBe(0);

    const versions = await requirePool().query<{
      id: string;
      name: string;
      checksum: string;
      execution_ms: number;
    }>('SELECT id, name, checksum, execution_ms FROM schema_migrations ORDER BY id');

    expect(versions.rows).toHaveLength(9);
    expect(versions.rows.map((row) => row.id)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
    ]);
    for (const row of versions.rows) {
      expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(row.execution_ms).toBeGreaterThanOrEqual(0);
    }

    const metadata = await requirePool().query<{ value: string }>(
      "SELECT value FROM platform_metadata WHERE key = 'ember.foundation.version'",
    );
    expect(metadata.rows[0]?.value).toBe('p0b-01');
  });

  it('creates the reviewed P0B-03 business relations', async () => {
    const tables = await requirePool().query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
        ORDER BY table_name`,
    );

    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'agents',
        'approvals',
        'commitment_occurrences',
        'commitment_outcomes',
        'commitments',
        'platform_metadata',
        'principals',
        'runs',
        'schema_migrations',
        'task_events',
        'tasks',
        'tenants',
        'workspaces',
      ]),
    );
  });

  it('is idempotent on a repeated run', async () => {
    const result = await runMigrations(requirePool(), migrationsDir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toBe(9);

    const versions = await requirePool().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    expect(versions.rows[0]?.count).toBe('9');
  });

  it('rejects a renamed migration with identical contents', async () => {
    const tempMigrationsDir = await mkdtemp(path.join(tmpdir(), 'ember-migrations-'));

    try {
      await writeFile(
        path.join(tempMigrationsDir, '0001_platform_metadata_renamed.sql'),
        await readFile(path.join(migrationsDir, '0001_platform_metadata.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0002_durable_task_inbox.sql'),
        await readFile(path.join(migrationsDir, '0002_durable_task_inbox.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0003_tasks_current_run_tenant_fk.sql'),
        await readFile(path.join(migrationsDir, '0003_tasks_current_run_tenant_fk.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0004_lease_fencing_and_retry.sql'),
        await readFile(path.join(migrationsDir, '0004_lease_fencing_and_retry.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0005_p0b06_artifacts_workspace_checkpoint.sql'),
        await readFile(
          path.join(migrationsDir, '0005_p0b06_artifacts_workspace_checkpoint.sql'),
          'utf8',
        ),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0006_p0b08b_persistent_budget.sql'),
        await readFile(path.join(migrationsDir, '0006_p0b08b_persistent_budget.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0007_p0b08d_persistent_mock_approval.sql'),
        await readFile(
          path.join(migrationsDir, '0007_p0b08d_persistent_mock_approval.sql'),
          'utf8',
        ),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0008_p0c3_commitments.sql'),
        await readFile(path.join(migrationsDir, '0008_p0c3_commitments.sql'), 'utf8'),
        'utf8',
      );

      await expect(runMigrations(requirePool(), tempMigrationsDir)).rejects.toThrow(
        /must not be renamed/,
      );

      const versions = await requirePool().query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      expect(versions.rows[0]?.count).toBe('9');
    } finally {
      await rm(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('reports ready against the migrated schema', async () => {
    const readiness = await createDatabaseReadiness(requirePool())();

    expect(readiness.status).toBe('ready');
    expect(readiness.checks['database']?.status).toBe('up');
  });

  it('rejects an edited migration checksum and leaves applied state untouched', async () => {
    const tempMigrationsDir = await mkdtemp(path.join(tmpdir(), 'ember-migrations-'));

    try {
      const original = await readFile(
        path.join(migrationsDir, '0001_platform_metadata.sql'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0001_platform_metadata.sql'),
        `${original}\n-- edited after being applied\n`,
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0002_durable_task_inbox.sql'),
        await readFile(path.join(migrationsDir, '0002_durable_task_inbox.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0003_tasks_current_run_tenant_fk.sql'),
        await readFile(path.join(migrationsDir, '0003_tasks_current_run_tenant_fk.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0004_lease_fencing_and_retry.sql'),
        await readFile(path.join(migrationsDir, '0004_lease_fencing_and_retry.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0005_p0b06_artifacts_workspace_checkpoint.sql'),
        await readFile(
          path.join(migrationsDir, '0005_p0b06_artifacts_workspace_checkpoint.sql'),
          'utf8',
        ),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0006_p0b08b_persistent_budget.sql'),
        await readFile(path.join(migrationsDir, '0006_p0b08b_persistent_budget.sql'), 'utf8'),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0007_p0b08d_persistent_mock_approval.sql'),
        await readFile(
          path.join(migrationsDir, '0007_p0b08d_persistent_mock_approval.sql'),
          'utf8',
        ),
        'utf8',
      );
      await writeFile(
        path.join(tempMigrationsDir, '0008_p0c3_commitments.sql'),
        await readFile(path.join(migrationsDir, '0008_p0c3_commitments.sql'), 'utf8'),
        'utf8',
      );

      await expect(runMigrations(requirePool(), tempMigrationsDir)).rejects.toThrow(MigrationError);
      await expect(runMigrations(requirePool(), tempMigrationsDir)).rejects.toThrow(
        /Checksum mismatch/,
      );

      const versions = await requirePool().query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      expect(versions.rows[0]?.count).toBe('9');
    } finally {
      await rm(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
