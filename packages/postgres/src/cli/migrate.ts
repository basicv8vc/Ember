import { fileURLToPath } from 'node:url';
import {
  createPool,
  describeDatabaseTarget,
  formatDatabaseTarget,
  loadDatabaseConfig,
  runMigrations,
  type MigrationLogger,
} from '../index.js';

const defaultMigrationsDir = fileURLToPath(new URL('../../../../migrations', import.meta.url));

const logger: MigrationLogger = {
  info: (message) => {
    process.stdout.write(`${message}\n`);
  },
};

async function main(): Promise<void> {
  const migrationsDir = process.env.EMBER_MIGRATIONS_DIR ?? defaultMigrationsDir;
  const config = loadDatabaseConfig();
  const pool = createPool(config, {
    onIdleError: (error) => {
      process.stderr.write(`database idle connection error: ${error.message}\n`);
    },
  });

  process.stdout.write(`running migrations from ${migrationsDir}\n`);
  process.stdout.write(
    `database: ${formatDatabaseTarget(describeDatabaseTarget(config.connectionString))}\n`,
  );

  try {
    const result = await runMigrations(pool, migrationsDir, { logger });
    process.stdout.write(
      `migrations complete: ${result.applied.length} applied, ` +
        `${result.alreadyApplied} already applied\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`migration failed: ${message}\n`);
  process.exitCode = 1;
});
