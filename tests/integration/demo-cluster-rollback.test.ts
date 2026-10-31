import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@ember/domain';
import { createPool, loadDatabaseConfig } from '@ember/postgres';
import { assertSafeTestDatabaseUrl, DemoCluster } from '../../apps/cli/src/cluster.js';
import { assertSafeTestDatabaseUrl as assertSafeE2eDatabaseUrl } from '../e2e/support/e2e-cluster.js';

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

  describe('Database URL Safety Whitelist', () => {
    const assertBoth = (url: string, expectAllowed: boolean): void => {
      if (expectAllowed) {
        expect(() => assertSafeTestDatabaseUrl(url)).not.toThrow();
        expect(() => assertSafeE2eDatabaseUrl(url)).not.toThrow();
      } else {
        expect(() => assertSafeTestDatabaseUrl(url)).toThrow(DomainError);
        expect(() => assertSafeE2eDatabaseUrl(url)).toThrow(DomainError);
      }
    };

    it('strictly allows local test or dev databases (e.g. localhost/ember_test)', () => {
      assertBoth('postgres://ember:dev@127.0.0.1:5432/ember_test', true);
      assertBoth('postgres://ember:dev@localhost:5432/ember_demo', true);
      assertBoth('postgres://ember:dev@localhost:5432/ember_dev', true);
      assertBoth('postgres://ember:dev@[::1]:5432/ember_test', true);
      assertBoth('postgres://ember:dev@127.0.0.1:5432/my_test_db', true);
      assertBoth('postgres://ember:dev@localhost:5432/app-demo', true);
    });

    it('strictly rejects local non-test databases (e.g. localhost/production)', () => {
      // Local host but production database name
      assertBoth('postgres://ember:dev@localhost:5432/production', false);
      assertBoth('postgres://ember:dev@127.0.0.1:5432/production', false);
      assertBoth('postgres://ember:dev@localhost:5432/ember_prod', false);
      assertBoth('postgres://ember:dev@localhost:5432/prod_test', false);

      // Local host but arbitrary non-test database name (no test/dev/demo token)
      assertBoth('postgres://ember:dev@localhost:5432/ember', false);
      assertBoth('postgres://ember:dev@127.0.0.1:5432/users_db', false);

      // Substring match trick: contains 'test' inside words like 'contest' or 'fastest', not standalone token
      assertBoth('postgres://ember:dev@localhost:5432/contest_db', false);
      assertBoth('postgres://ember:dev@localhost:5432/fastest_production', false);
      assertBoth('postgres://ember:dev@localhost:5432/greatest', false);
    });

    it('strictly rejects remote test databases (e.g. remote.example.com/ember_test)', () => {
      // Remote host even if database name is ember_test
      assertBoth('postgres://user:pass@remote.example.com:5432/ember_test', false);
      assertBoth('postgres://user:pass@192.168.1.100:5432/ember_test', false);
      assertBoth('postgres://user:pass@10.0.0.5:5432/ember_test', false);
      assertBoth('postgres://user:pass@db.internal.corp:5432/ember_test', false);
      assertBoth('postgres://user:pass@aws.rds.amazonaws.com:5432/ember_demo', false);
    });

    it('strictly rejects remote non-test databases (e.g. remote.example.com/production)', () => {
      assertBoth('postgres://user:pass@remote.example.com:5432/production', false);
      assertBoth('postgres://user:pass@production-db.internal:5432/production', false);
      assertBoth('postgres://user:pass@prod.aws.com:5432/ember_prod', false);
    });
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
