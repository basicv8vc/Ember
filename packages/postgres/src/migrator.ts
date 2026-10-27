import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

/** Stable, application-specific advisory lock key for migration runs. */
const MIGRATION_ADVISORY_LOCK_KEY = 8_675_309;

export const MIGRATIONS_TABLE = 'schema_migrations';

const MIGRATION_FILENAME_PATTERN = /^(\d{4,})_([a-z0-9_]+)\.sql$/;

const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  id           text        PRIMARY KEY,
  name         text        NOT NULL UNIQUE,
  checksum     text        NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  execution_ms integer     NOT NULL
)`;

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

export interface Migration {
  /** Numeric prefix from the filename, e.g. `"0001"`. */
  readonly id: string;
  /** Full filename, e.g. `"0001_platform_metadata.sql"`. */
  readonly name: string;
  /** SHA-256 of the file contents. */
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly id: string;
  readonly name: string;
  readonly appliedAt: string;
  readonly executionMs: number;
}

export interface MigrationRunResult {
  /** Migrations applied by this invocation, in filename order. */
  readonly applied: AppliedMigration[];
  /** Number of migrations that were already recorded before this invocation. */
  readonly alreadyApplied: number;
}

export interface MigrationLogger {
  info(message: string): void;
}

export interface RunMigrationsOptions {
  readonly logger?: MigrationLogger;
}

interface MigrationRow {
  id: string;
  name: string;
  checksum: string;
  applied_at: Date;
  execution_ms: number;
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Read and validate migration files from a directory.
 * Files must be named `NNNN_lower_snake_case.sql` and are applied in ascending id order.
 */
export async function loadMigrations(migrationsDir: string): Promise<Migration[]> {
  let entries: string[];

  try {
    entries = await readdir(migrationsDir);
  } catch (error) {
    throw new MigrationError(
      `Cannot read migrations directory "${migrationsDir}": ${(error as Error).message}`,
    );
  }

  const filenames = entries.filter((entry) => entry.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  let previousId = -1;

  for (const name of filenames) {
    const match = MIGRATION_FILENAME_PATTERN.exec(name);

    if (match === null) {
      throw new MigrationError(
        `Invalid migration filename "${name}" (expected NNNN_lower_snake_case.sql)`,
      );
    }

    const [, id, slug] = match;
    if (id === undefined || slug === undefined) {
      throw new MigrationError(`Invalid migration filename "${name}"`);
    }

    const numericId = Number(id);
    if (numericId <= previousId) {
      throw new MigrationError(
        `Migration ids must be unique and strictly increasing; "${name}" is out of order`,
      );
    }
    previousId = numericId;

    const sql = await readFile(path.join(migrationsDir, name), 'utf8');
    if (sql.trim().length === 0) {
      throw new MigrationError(`Migration "${name}" is empty`);
    }

    migrations.push({ id, name, checksum: checksumOf(sql), sql });
  }

  return migrations;
}

/**
 * Apply all pending migrations inside a single dedicated connection.
 *
 * - Uses a PostgreSQL advisory lock so concurrent runners serialize.
 * - Each migration runs in its own transaction together with its version row.
 * - Already-applied migrations are skipped, so repeated runs are safe.
 * - Checksums of applied migrations are verified; edited history is rejected.
 *
 * This runner owns only `schema_migrations`. It does not define P0B-03 business tables.
 */
export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string,
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const migrations = await loadMigrations(migrationsDir);
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);

    try {
      await client.query(CREATE_MIGRATIONS_TABLE_SQL);

      const existingResult = await client.query<MigrationRow>(
        `SELECT id, name, checksum, applied_at, execution_ms
           FROM ${MIGRATIONS_TABLE}
          ORDER BY id`,
      );
      const existing = existingResult.rows;

      const migrationsById = new Map(migrations.map((migration) => [migration.id, migration]));

      for (const row of existing) {
        const migration = migrationsById.get(row.id);

        if (migration === undefined) {
          throw new MigrationError(
            `Applied migration id ${row.id} (${row.name}) is missing from "${migrationsDir}"`,
          );
        }
        if (migration.checksum !== row.checksum) {
          throw new MigrationError(
            `Checksum mismatch for applied migration ${row.id} (${row.name}); ` +
              'already-applied migrations must not be edited',
          );
        }
      }

      const appliedIds = new Set(existing.map((row) => row.id));
      const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
      const applied: AppliedMigration[] = [];

      for (const migration of pending) {
        const startedAt = performance.now();

        await client.query('BEGIN');
        try {
          await client.query(migration.sql);

          const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
          const inserted = await client.query<{ applied_at: Date }>(
            `INSERT INTO ${MIGRATIONS_TABLE} (id, name, checksum, execution_ms)
             VALUES ($1, $2, $3, $4)
             RETURNING applied_at`,
            [migration.id, migration.name, migration.checksum, executionMs],
          );

          await client.query('COMMIT');

          const insertedRow = inserted.rows[0];
          if (insertedRow === undefined) {
            throw new MigrationError(`Migration "${migration.name}" did not return a version row`);
          }

          applied.push({
            id: migration.id,
            name: migration.name,
            appliedAt: insertedRow.applied_at.toISOString(),
            executionMs,
          });
          options.logger?.info(`applied migration ${migration.name} in ${executionMs}ms`);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          if (error instanceof MigrationError) {
            throw error;
          }
          throw new MigrationError(
            `Failed to apply migration "${migration.name}": ${(error as Error).message}`,
            { cause: error },
          );
        }
      }

      return { applied, alreadyApplied: existing.length };
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
