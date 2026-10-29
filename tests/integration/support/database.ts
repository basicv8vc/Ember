import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createPool,
  loadDatabaseConfig,
  runMigrations,
  type DatabaseConfig,
} from '@ember/postgres';

export type TestPool = ReturnType<typeof createPool>;

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url));
const schemaPattern = /^ember_it_[a-f0-9]{12}$/;

export interface TestDatabase {
  readonly schema: string;
  readonly pool: TestPool;
  /** Separate pool used to prove that committed rows are visible outside the writer. */
  readonly observerPool: TestPool;
  readonly adminPool: TestPool;
  close(): Promise<void>;
}

export interface TestDatabaseOptions {
  readonly maxConnections?: number;
}

/**
 * Session-scoped view of one open connection.
 *
 * `pg.PoolClient` declares overloaded `query` signatures (including a callback form), so a
 * client type cannot be derived from `Pool.connect`; a structural interface accepts the real
 * client instead.
 */
export interface LockSession {
  query<R extends Record<string, unknown>>(sql: string): Promise<{ readonly rows: readonly R[] }>;
}

/** Backend pid of one session, so a lock assertion can name the exact backend it expects. */
export async function backendPid(client: LockSession): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;

  if (pid === undefined) {
    throw new Error('could not read the backend pid');
  }

  return pid;
}

/**
 * Create a throwaway schema, run every repository migration in it, and return pools that
 * are scoped to that schema. Only this run's schema is ever dropped.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (testDatabaseUrl === undefined || testDatabaseUrl.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is required for integration tests. ' +
        'Start the local database with `pnpm dev:db` and copy `.env.example` to `.env.local`.',
    );
  }

  const baseConfig: DatabaseConfig = loadDatabaseConfig({ DATABASE_URL: testDatabaseUrl });
  const adminPool = createPool({ ...baseConfig, maxConnections: 2 });
  const schema = `ember_it_${randomBytes(6).toString('hex')}`;

  let pool: TestPool | undefined;
  let observerPool: TestPool | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = createPool({
      ...baseConfig,
      maxConnections: options.maxConnections ?? 12,
      searchPath: schema,
    });
    observerPool = createPool({ ...baseConfig, maxConnections: 2, searchPath: schema });

    await runMigrations(pool, migrationsDir);

    const scopedPool = pool;
    const scopedObserver = observerPool;

    return {
      schema,
      pool: scopedPool,
      observerPool: scopedObserver,
      adminPool,
      close: async () => {
        await scopedPool.end();
        await scopedObserver.end();
        await adminPool.end();

        if (!schemaPattern.test(schema)) {
          throw new Error('refusing to drop an unverified test schema');
        }
        // Only ever drop the schema this helper created, after all clients are closed.
        const cleanupPool = createPool({ ...baseConfig, maxConnections: 1 });
        try {
          await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await cleanupPool.end();
        }
      },
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await observerPool?.end().catch(() => undefined);
    if (schemaPattern.test(schema)) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await adminPool.end().catch(() => undefined);
    throw error;
  }
}
