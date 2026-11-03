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
  /**
   * Pool used only for cluster-level DDL that needs elevated privileges (`CREATE ROLE`).
   *
   * Migrations, production repositories and every other fixture keep using `TEST_DATABASE_URL`;
   * only tests that intentionally exercise role provisioning reach for this pool. It is backed by
   * `TEST_ADMIN_DATABASE_URL` when that is set, and otherwise falls back to `adminPool` so a
   * cluster where the test role already has `CREATEROLE` keeps working unchanged.
   */
  readonly roleAdminPool: TestPool;
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

/** How long `close()` waits for checked-out clients before reporting them as leaked. */
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Close one pool, reporting a leaked client instead of hanging on it.
 *
 * `pool.end()` never settles while a client is still checked out, so a test that forgets to
 * release one turns the whole file into a silent hang and hides the assertion that failed first.
 * Failing with the connection counts instead keeps that original failure readable.
 */
async function endPool(pool: TestPool, name: string): Promise<void> {
  const ended = pool.end().then(() => 'ended' as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS);
  });

  try {
    if ((await Promise.race([ended, timedOut])) === 'timeout') {
      throw new Error(
        `${name} did not close within ${CLOSE_TIMEOUT_MS}ms: ` +
          `${pool.totalCount - pool.idleCount} connection(s) still checked out, ` +
          `${pool.waitingCount} query(ies) queued - a test leaked a pooled client`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
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

  // A cluster-level role-provisioning test needs CREATEROLE, which the ordinary test role must not
  // have. When a dedicated privileged URL is configured it is used for that one purpose only.
  const roleAdminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  const roleAdminPool =
    roleAdminUrl === undefined || roleAdminUrl.length === 0
      ? adminPool
      : createPool({ ...loadDatabaseConfig({ DATABASE_URL: roleAdminUrl }), maxConnections: 2 });

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
      roleAdminPool,
      close: async () => {
        // Throws (rather than hanging) if a test left a client checked out; the pools after it
        // then stay open on purpose, because this run is already failing loudly.
        await endPool(scopedPool, 'test pool');
        await endPool(scopedObserver, 'observer pool');
        await endPool(adminPool, 'admin pool');
        if (roleAdminPool !== adminPool) {
          await endPool(roleAdminPool, 'role admin pool');
        }

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
    if (roleAdminPool !== adminPool) {
      await roleAdminPool.end().catch(() => undefined);
    }
    throw error;
  }
}
