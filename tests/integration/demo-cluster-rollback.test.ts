import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@ember/domain';
import { createPool, loadDatabaseConfig } from '@ember/postgres';
import { assertSafeTestDatabaseUrl, DemoCluster } from '../../apps/cli/src/cluster.js';

describe('DemoCluster Initialization Safety & Rollback Verification', () => {
  const safeDbUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test';

  let adminPool: ReturnType<typeof createPool>;

  beforeAll(() => {
    const baseConfig = loadDatabaseConfig({ DATABASE_URL: safeDbUrl });
    adminPool = createPool({ ...baseConfig, maxConnections: 2 });
  });

  afterAll(async () => {
    await adminPool?.end().catch(() => undefined);
  });

  it('strictly rejects non-local or non-test database URLs', () => {
    expect(() => {
      assertSafeTestDatabaseUrl('postgres://user:pass@production-db.internal:5432/production');
    }).toThrow(DomainError);

    expect(() => {
      assertSafeTestDatabaseUrl('postgres://user:pass@prod.aws.com:5432/ember_prod');
    }).toThrow(DomainError);

    // Safe URLs pass validation
    expect(() => {
      assertSafeTestDatabaseUrl('postgres://ember:dev@127.0.0.1:5432/ember_test');
    }).not.toThrow();

    expect(() => {
      assertSafeTestDatabaseUrl('postgres://ember:dev@localhost:5432/ember_demo');
    }).not.toThrow();
  });

  it('cleans up all schema and pool resources when initialization fails mid-way', async () => {
    const schemasBefore = await adminPool.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'ember_demo_%'`,
    );
    const initialCount = schemasBefore.rowCount ?? 0;

    // Simulate startup failure with invalid options or unreachable migration
    await expect(
      DemoCluster.start({
        databaseUrl: safeDbUrl,
        workerConcurrency: -1, // Invalid concurrency will fail worker setup and trigger rollback
      }),
    ).rejects.toThrow();

    // Verify no orphaned schema remains
    const schemasAfter = await adminPool.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'ember_demo_%'`,
    );
    const finalCount = schemasAfter.rowCount ?? 0;

    expect(finalCount).toBe(initialCount);
  });
});
