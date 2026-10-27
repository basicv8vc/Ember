import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, MigrationError } from '@ember/postgres';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const migrationsDir = path.join(repoRoot, 'migrations');

const temporaryDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ember-migrations-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('loadMigrations', () => {
  it('loads the repository migrations in order', async () => {
    const migrations = await loadMigrations(migrationsDir);

    expect(migrations.length).toBeGreaterThanOrEqual(1);
    const first = migrations[0];
    expect(first).toBeDefined();
    expect(first?.id).toBe('0001');
    expect(first?.name).toBe('0001_platform_metadata.sql');
    expect(first?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(first?.sql).toContain('CREATE TABLE IF NOT EXISTS platform_metadata');
  });

  it('rejects filenames without a numeric prefix', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'init.sql'), 'SELECT 1;', 'utf8');

    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('rejects filenames that are not lower snake case', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, '0001_Bad-Name.sql'), 'SELECT 1;', 'utf8');

    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('rejects duplicate migration ids', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, '0001_first.sql'), 'SELECT 1;', 'utf8');
    await writeFile(path.join(dir, '0001_second.sql'), 'SELECT 2;', 'utf8');

    await expect(loadMigrations(dir)).rejects.toThrow(/strictly increasing/);
  });

  it('rejects empty migration files', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, '0001_empty.sql'), '   \n', 'utf8');

    await expect(loadMigrations(dir)).rejects.toThrow(/empty/);
  });

  it('fails with a clear error for a missing directory', async () => {
    await expect(loadMigrations(path.join(repoRoot, 'does-not-exist'))).rejects.toThrow(
      MigrationError,
    );
  });
});
