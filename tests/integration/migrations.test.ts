import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  loadDatabaseConfig,
  loadMigrations,
  MigrationError,
  runMigrations,
} from '@ember/postgres';
import { createDatabaseReadiness } from '../../apps/api/src/readiness.js';
import { createCloudflareAppleNonceReplayStore } from '../../apps/api/src/cloudflare-apple-replay.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const schemaPattern = /^ember_it_[a-f0-9]{12}$/;

let adminPool: TestPool | undefined;
let baseConfig: ReturnType<typeof loadDatabaseConfig> | undefined;
let pool: TestPool | undefined;

type TestPool = ReturnType<typeof createPool>;
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

  baseConfig = loadDatabaseConfig({ DATABASE_URL: testDatabaseUrl });
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

/**
 * Runs `fn` against a brand-new schema so a migration history can be staged from scratch.
 * The schema is dropped afterwards; nothing leaks into the shared test schema.
 */
async function withFreshSchema(fn: (isolatedPool: TestPool) => Promise<void>): Promise<void> {
  if (baseConfig === undefined || adminPool === undefined) {
    throw new Error('migration test fixtures were not initialised');
  }

  const isolated = `ember_it_${randomBytes(6).toString('hex')}`;
  await adminPool.query(`CREATE SCHEMA "${isolated}"`);

  const pool = createPool({ ...baseConfig, maxConnections: 2, searchPath: isolated });

  try {
    await fn(pool);
  } finally {
    await pool.end();

    if (schemaPattern.test(isolated)) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${isolated}" CASCADE`);
    }
  }
}

/** Copies the named migration files from the repository into a fresh temp directory. */
async function stageMigrations(names: readonly string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ember-migrations-history-'));

  for (const name of names) {
    await writeFile(
      path.join(dir, name),
      await readFile(path.join(migrationsDir, name), 'utf8'),
      'utf8',
    );
  }

  return dir;
}

// Fixed pre-B1 history for explicit 0009/0010 out-of-order compatibility tests.
// The full production migration list is discovered by runMigrations(migrationsDir).
const MIGRATION_FILES = [
  '0001_platform_metadata.sql',
  '0002_durable_task_inbox.sql',
  '0003_tasks_current_run_tenant_fk.sql',
  '0004_lease_fencing_and_retry.sql',
  '0005_p0b06_artifacts_workspace_checkpoint.sql',
  '0006_p0b08b_persistent_budget.sql',
  '0007_p0b08d_persistent_mock_approval.sql',
  '0008_p0c3_commitments.sql',
  '0009_p0c3b_runtime_closure.sql',
  '0010_p0c3d_consent.sql',
] as const;

describe('PostgreSQL migrations (real database)', () => {
  it('connects to an isolated test schema', async () => {
    const result = await requirePool().query<{ current_schema: string }>('SELECT current_schema()');

    expect(result.rows[0]?.current_schema).toBe(schema);
    expect(schemaPattern.test(schema)).toBe(true);
  });

  it('applies migrations from an empty schema and records the version', async () => {
    const migrationFiles = await loadMigrations(migrationsDir);
    const result = await runMigrations(requirePool(), migrationsDir);

    expect(result.applied).toHaveLength(migrationFiles.length);
    expect(result.applied.map((migration) => migration.id)).toEqual(
      migrationFiles.map((migration) => migration.id),
    );
    expect(result.applied[1]?.name).toBe('0002_durable_task_inbox.sql');
    expect(result.applied[2]?.name).toBe('0003_tasks_current_run_tenant_fk.sql');
    expect(result.applied[3]?.name).toBe('0004_lease_fencing_and_retry.sql');
    expect(result.applied[4]?.name).toBe('0005_p0b06_artifacts_workspace_checkpoint.sql');
    expect(result.applied[5]?.name).toBe('0006_p0b08b_persistent_budget.sql');
    expect(result.applied[6]?.name).toBe('0007_p0b08d_persistent_mock_approval.sql');
    expect(result.applied[7]?.name).toBe('0008_p0c3_commitments.sql');
    expect(result.applied[8]?.name).toBe('0009_p0c3b_runtime_closure.sql');
    expect(result.applied[9]?.name).toBe('0010_p0c3d_consent.sql');
    expect(result.applied[10]?.name).toBe('0011_identity_session.sql');
    expect(result.applied[11]?.name).toBe('0012_conversation.sql');
    expect(result.applied[12]?.name).toBe('0013_task_results.sql');
    expect(result.applied[13]?.name).toBe('0014_model_execution.sql');
    expect(result.applied[14]?.name).toBe('0015_model_budget_safety.sql');
    expect(result.applied[15]?.name).toBe('0016_model_budget_incident_usage_missing.sql');
    const appliedIds = result.applied.map((migration) => migration.id);
    const nonceMigrationIndex = appliedIds.indexOf('0017');
    const outboxMigrationIndex = appliedIds.indexOf('0018');

    expect(nonceMigrationIndex).toBeGreaterThan(appliedIds.indexOf('0016'));
    expect(result.applied[nonceMigrationIndex]?.name).toBe('0017_apple_nonce_replay.sql');
    expect(outboxMigrationIndex).toBe(nonceMigrationIndex + 1);
    expect(result.applied[outboxMigrationIndex]?.name).toBe('0018_b1_turn_dispatch_outbox.sql');
    expect(result.alreadyApplied).toBe(0);

    const versions = await requirePool().query<{
      id: string;
      name: string;
      checksum: string;
      execution_ms: number;
    }>('SELECT id, name, checksum, execution_ms FROM schema_migrations ORDER BY id');

    expect(versions.rows).toHaveLength(migrationFiles.length);
    expect(versions.rows.map((row) => row.id)).toEqual(
      migrationFiles.map((migration) => migration.id),
    );
    for (const row of versions.rows) {
      expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(row.execution_ms).toBeGreaterThanOrEqual(0);
    }
    expect(
      versions.rows
        .filter((row) => ['0011', '0012', '0013'].includes(row.id))
        .map(({ id, name, checksum }) => ({ id, name, checksum })),
    ).toEqual([
      {
        id: '0011',
        name: '0011_identity_session.sql',
        checksum: '37bcec88863f6c83d30c16bba755b63c07197bd9155089e713f89e5358934122',
      },
      {
        id: '0012',
        name: '0012_conversation.sql',
        checksum: '4d0fca538f18241bdace22de322fa0dbb40e8444aa9535e667d28df3eac2df58',
      },
      {
        id: '0013',
        name: '0013_task_results.sql',
        checksum: 'a8860cc8b0bfe692d6b27842a0ae66192985d1ac97e68b189b9cd65a68718037',
      },
    ]);

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
        'model_budget_incidents',
        'model_global_spend_days',
        'model_spend_days',
        'model_turn_attempts',
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
    const migrationFiles = await loadMigrations(migrationsDir);
    const before = await requirePool().query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations ORDER BY id',
    );
    const result = await runMigrations(requirePool(), migrationsDir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toBe(migrationFiles.length);
    const after = await requirePool().query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations ORDER BY id',
    );
    expect(after.rows).toEqual(before.rows);

    const versions = await requirePool().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    expect(versions.rows[0]?.count).toBe(String(migrationFiles.length));
  });

  it('rejects a renamed migration with identical contents', async () => {
    const tempMigrationsDir = await mkdtemp(path.join(tmpdir(), 'ember-migrations-'));
    const migrationCount = (await loadMigrations(migrationsDir)).length;

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
      expect(versions.rows[0]?.count).toBe(String(migrationCount));
    } finally {
      await rm(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('applies 0009 before 0010 when both are available (normal history)', async () => {
    await withFreshSchema(async (isolatedPool) => {
      const first = await runMigrations(
        isolatedPool,
        await stageMigrations(MIGRATION_FILES.filter((name) => !name.startsWith('0010'))),
      );

      // A database that stopped at P0-C3B: 0009 is the head.
      expect(first.applied.map((migration) => migration.id)).toEqual([
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

      const dir = await stageMigrations(MIGRATION_FILES);

      try {
        const second = await runMigrations(isolatedPool, dir);

        expect(second.applied.map((migration) => migration.id)).toEqual(['0010']);

        const applied = await isolatedPool.query<{ id: string }>(
          'SELECT id FROM schema_migrations ORDER BY id',
        );

        expect(applied.rows.map((row) => row.id)).toEqual([
          '0001',
          '0002',
          '0003',
          '0004',
          '0005',
          '0006',
          '0007',
          '0008',
          '0009',
          '0010',
        ]);

        const columns = await isolatedPool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'commitment_occurrences'
              AND column_name IN ('consent_grant_id', 'consent_version')
            ORDER BY column_name`,
        );

        expect(columns.rows.map((row) => row.column_name)).toEqual([
          'consent_grant_id',
          'consent_version',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('backfills 0009 after 0010 was already applied (out-of-order history)', async () => {
    await withFreshSchema(async (isolatedPool) => {
      // 0010 is available but 0009 is not: the state of a branch that merged P0-C3D first.
      const firstDir = await stageMigrations(
        MIGRATION_FILES.filter((name) => !name.startsWith('0009')),
      );

      try {
        const first = await runMigrations(isolatedPool, firstDir);

        expect(first.applied.map((migration) => migration.id)).toEqual([
          '0001',
          '0002',
          '0003',
          '0004',
          '0005',
          '0006',
          '0007',
          '0008',
          '0010',
        ]);

        const beforeBackfill = await isolatedPool.query<{ id: string }>(
          'SELECT id FROM schema_migrations ORDER BY id',
        );

        expect(beforeBackfill.rows.map((row) => row.id)).not.toContain('0009');
      } finally {
        await rm(firstDir, { recursive: true, force: true });
      }

      // 0009 finally becomes available: the runner applies the missing id without re-running 0010.
      const secondDir = await stageMigrations(MIGRATION_FILES);

      try {
        const second = await runMigrations(isolatedPool, secondDir);

        expect(second.applied.map((migration) => migration.id)).toEqual(['0009']);

        const applied = await isolatedPool.query<{ id: string }>(
          'SELECT id FROM schema_migrations ORDER BY id',
        );

        expect(applied.rows.map((row) => row.id)).toEqual([
          '0001',
          '0002',
          '0003',
          '0004',
          '0005',
          '0006',
          '0007',
          '0008',
          '0009',
          '0010',
        ]);

        // Both migrations remain effective: the consent fence AND the runtime-closure indexes.
        const indexes = await isolatedPool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = current_schema()
              AND indexname IN ('occurrences_dispatched_reap_idx', 'occurrences_tenant_task_idx')
            ORDER BY indexname`,
        );

        expect(indexes.rows.map((row) => row.indexname)).toEqual([
          'occurrences_dispatched_reap_idx',
          'occurrences_tenant_task_idx',
        ]);
      } finally {
        await rm(secondDir, { recursive: true, force: true });
      }
    });
  });

  it('reports ready against the migrated schema', async () => {
    const readiness = await createDatabaseReadiness(requirePool())();

    expect(readiness.status).toBe('ready');
    expect(readiness.checks['database']?.status).toBe('up');
  });

  it('rejects an edited migration checksum and leaves applied state untouched', async () => {
    const tempMigrationsDir = await mkdtemp(path.join(tmpdir(), 'ember-migrations-'));
    const migrationCount = (await loadMigrations(migrationsDir)).length;

    try {
      const filenames = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql'));
      for (const name of filenames) {
        const original = await readFile(path.join(migrationsDir, name), 'utf8');
        const contents =
          name === '0013_task_results.sql'
            ? `${original}\n-- edited after being applied\n`
            : original;
        await writeFile(path.join(tempMigrationsDir, name), contents, 'utf8');
      }

      await expect(runMigrations(requirePool(), tempMigrationsDir)).rejects.toThrow(MigrationError);
      await expect(runMigrations(requirePool(), tempMigrationsDir)).rejects.toThrow(
        /Checksum mismatch/,
      );

      const versions = await requirePool().query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      expect(versions.rows[0]?.count).toBe(String(migrationCount));
    } finally {
      await rm(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('applies the Apple nonce replay fence with one winner under concurrent use', async () => {
    const nonce = `integration-${randomBytes(32).toString('hex')}`;
    const replayStore = createCloudflareAppleNonceReplayStore(requirePool());
    const outcomes = await Promise.all(
      Array.from({ length: 32 }, () => replayStore.consume(nonce)),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes.filter((accepted) => !accepted)).toHaveLength(31);
  });
});
