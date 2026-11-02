import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, loadDatabaseConfig, MigrationError, runMigrations } from '@ember/postgres';
import { createDatabaseReadiness } from '../../apps/api/src/readiness.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const schemaPattern = /^ember_it_[a-f0-9]{12}$/;

/**
 * The reviewed history, read from disk once.
 *
 * The suite asserts the *set* of migrations rather than a hard-coded count, so adding a migration
 * updates one list here instead of a dozen numeric literals, and a staged copy for the
 * rename/checksum cases can never silently omit the newest file.
 */
const MIGRATION_FILES = (await readdir(migrationsDir))
  .filter((file) => file.endsWith('.sql'))
  .sort();
const MIGRATION_IDS = MIGRATION_FILES.map((file) => file.slice(0, 4));
const MIGRATION_COUNT = MIGRATION_FILES.length;

/** Copy the real history into `targetDir`, optionally renaming or editing one file. */
async function stageMigrations(
  targetDir: string,
  transform: (file: string, contents: string) => { name: string; contents: string } = (
    file,
    contents,
  ) => ({ name: file, contents }),
): Promise<void> {
  for (const file of MIGRATION_FILES) {
    const contents = await readFile(path.join(migrationsDir, file), 'utf8');
    const staged = transform(file, contents);

    await writeFile(path.join(targetDir, staged.name), staged.contents, 'utf8');
  }
}

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

    expect(result.applied).toHaveLength(MIGRATION_COUNT);
    expect(result.applied.map((migration) => migration.id)).toEqual(MIGRATION_IDS);
    expect(result.applied[1]?.name).toBe('0002_durable_task_inbox.sql');
    expect(result.applied[2]?.name).toBe('0003_tasks_current_run_tenant_fk.sql');
    expect(result.applied[3]?.name).toBe('0004_lease_fencing_and_retry.sql');
    expect(result.applied[4]?.name).toBe('0005_p0b06_artifacts_workspace_checkpoint.sql');
    expect(result.applied[5]?.name).toBe('0006_p0b08b_persistent_budget.sql');
    expect(result.applied[6]?.name).toBe('0007_p0b08d_persistent_mock_approval.sql');
    expect(result.applied[7]?.name).toBe('0008_p0c3_commitments.sql');
    expect(result.applied[8]?.name).toBe('0010_p0c3d_consent.sql');
    expect(result.alreadyApplied).toBe(0);

    const versions = await requirePool().query<{
      id: string;
      name: string;
      checksum: string;
      execution_ms: number;
    }>('SELECT id, name, checksum, execution_ms FROM schema_migrations ORDER BY id');

    expect(versions.rows).toHaveLength(MIGRATION_COUNT);
    expect(versions.rows.map((row) => row.id)).toEqual(MIGRATION_IDS);
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
        'consent_grants',
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

  it('creates the P0-C3D consent relation without any credential column', async () => {
    const columns = await requirePool().query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'consent_grants'
        ORDER BY column_name`,
    );
    const names = columns.rows.map((row) => row.column_name);

    expect(names).toEqual([
      'allowed_operations',
      'created_at',
      'expires_at',
      'granted_at',
      'granted_by_principal_id',
      'id',
      'revoked_at',
      'revoked_by_principal_id',
      'scopes',
      'source_profile_id',
      'status',
      'tenant_id',
      'updated_at',
      'version',
    ]);

    // Authorization facts only: no token, secret, key, cookie or password may ever be stored.
    expect(
      names.filter((name) => /token|secret|password|key|cookie|credential/i.test(name)),
    ).toEqual([]);

    // `expired` is derived, never stored, so an expiry cannot go stale in a column.
    const statuses = await requirePool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'consent_grants'::regclass AND conname = 'consent_grants_status_check'`,
    );
    expect(statuses.rows[0]?.def).toContain("'active'");
    expect(statuses.rows[0]?.def).toContain("'revoked'");
    expect(statuses.rows[0]?.def).not.toContain('expired');

    const occurrenceColumn = await requirePool().query<{ data_type: string }>(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'commitment_occurrences'
          AND column_name = 'consent_version'`,
    );
    expect(occurrenceColumn.rows[0]?.data_type).toBe('integer');
  });

  it('is idempotent on a repeated run', async () => {
    const result = await runMigrations(requirePool(), migrationsDir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toBe(MIGRATION_COUNT);

    const versions = await requirePool().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    expect(versions.rows[0]?.count).toBe(String(MIGRATION_COUNT));
  });

  it('rejects a renamed migration with identical contents', async () => {
    const tempMigrationsDir = await mkdtemp(path.join(tmpdir(), 'ember-migrations-'));

    try {
      // Same bytes, different name: the migrator must refuse a renamed revision.
      await stageMigrations(tempMigrationsDir, (file, contents) =>
        file === '0001_platform_metadata.sql'
          ? { name: '0001_platform_metadata_renamed.sql', contents }
          : { name: file, contents },
      );

      await expect(runMigrations(requirePool(), tempMigrationsDir)).rejects.toThrow(
        /must not be renamed/,
      );

      const versions = await requirePool().query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      expect(versions.rows[0]?.count).toBe(String(MIGRATION_COUNT));
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
      // Same name, edited bytes: an already-applied revision must never change underneath.
      await stageMigrations(tempMigrationsDir, (file, contents) =>
        file === '0001_platform_metadata.sql'
          ? { name: file, contents: `${contents}\n-- edited after being applied\n` }
          : { name: file, contents },
      );

      await expect(runMigrations(requirePool(), tempMigrationsDir)).rejects.toThrow(MigrationError);
      await expect(runMigrations(requirePool(), tempMigrationsDir)).rejects.toThrow(
        /Checksum mismatch/,
      );

      const versions = await requirePool().query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      expect(versions.rows[0]?.count).toBe(String(MIGRATION_COUNT));
    } finally {
      await rm(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
