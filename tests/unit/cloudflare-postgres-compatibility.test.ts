import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPool } from '../../packages/postgres/src/pool.js';

const WORKER_SQL_PATHS = [
  'packages/postgres/src/repositories/b1-session-support.ts',
  'packages/postgres/src/repositories/b1-session-provisioning-repository.ts',
  'packages/postgres/src/repositories/b1-session-repository.ts',
  'packages/postgres/src/repositories/b1-conversation-read.ts',
  'packages/postgres/src/repositories/b1-conversation-write.ts',
  'packages/postgres/src/repositories/b1-assistant-turn-repository.ts',
  'packages/postgres/src/repositories/support.ts',
  'apps/api/src/auth/b1-me-projection-reader.ts',
  'apps/api/src/cloudflare-apple-replay.ts',
  'apps/api/src/readiness.ts',
] as const;

const readRepoFile = (path: string): Promise<string> => readFile(join(process.cwd(), path), 'utf8');

describe('Cloudflare PostgreSQL provider compatibility', () => {
  it('keeps the Worker data path on transaction-pool-compatible PostgreSQL features', async () => {
    const [workerEntry, postgresEntry, ...runtimeSources] = await Promise.all([
      readRepoFile('apps/api/src/cloudflare-worker.ts'),
      readRepoFile('packages/postgres/src/b1-worker.ts'),
      ...WORKER_SQL_PATHS.map(readRepoFile),
    ]);
    const runtimeSql = runtimeSources.join('\n');

    expect(workerEntry).toContain("'@ember/postgres/b1-worker'");
    expect(workerEntry).not.toContain("from '@ember/postgres'");
    expect(postgresEntry).toContain('PostgresB1ConsumerSessionRepository');
    expect(runtimeSql).toMatch(/pg_advisory_xact_lock\s*\(/i);
    expect(runtimeSql).not.toMatch(/\bpg_(?:try_)?advisory_lock(?:_shared)?\s*\(/i);
    expect(runtimeSql).not.toMatch(/\b(?:LISTEN|NOTIFY|PREPARE|DEALLOCATE)\b/i);
  });

  it('uses PostgreSQL migrations without Supabase Data API dependencies', async () => {
    const migrationDirectory = join(process.cwd(), 'migrations');
    const migrationNames = await readdir(migrationDirectory);
    const migrationNumbers = Array.from({ length: 17 }, (_, index) => {
      return String(index + 1).padStart(4, '0');
    });
    const migrationFiles = await Promise.all(
      migrationNumbers.map(async (migrationNumber) => {
        const fileName = migrationNames.find((name) => name.startsWith(`${migrationNumber}_`));

        if (fileName === undefined) {
          throw new Error(`Missing migration ${migrationNumber}`);
        }

        return readRepoFile(`migrations/${fileName}`);
      }),
    );
    const migrationSql = migrationFiles.join('\n');
    const roleBootstrap = await readRepoFile('infra/postgres/ember-worker-role.sql');

    expect(migrationSql).not.toMatch(/\bauth\.(?:uid|jwt)\s*\(/i);
    expect(migrationSql).not.toMatch(/\bstorage\.objects\b/i);
    expect(migrationSql).not.toMatch(/\bCREATE\s+EXTENSION\b/i);
    expect(roleBootstrap).toMatch(/current_database\s*\(\s*\)/i);
    expect(roleBootstrap).not.toMatch(/ON DATABASE\s+postgres\b/i);
  });

  it('can rely on a least-privilege database role instead of a session startup option', async () => {
    const pool = createPool({
      connectionString: 'postgres://ember_worker:unused@127.0.0.1:5432/ember',
      maxConnections: 1,
      connectionTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      statementTimeoutMs: 5_000,
      statementTimeoutOnConnect: false,
      applicationName: 'compatibility-test',
    });

    expect(pool.options.options).toBeUndefined();
    expect(pool.options.application_name).toBe('compatibility-test');
    await pool.end();
  });
});
