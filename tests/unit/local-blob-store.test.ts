import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalBlobStore } from '@ember/postgres';

/**
 * Filesystem adapter tests. No database is involved; every root is a temporary directory
 * created by this test and removed afterwards.
 */

let root: string;
let store: LocalBlobStore;
const tenant = randomUUID();

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ember-blob-unit-'));
  store = new LocalBlobStore({ rootDir: root, maxBytes: 16 });
});

afterEach(async () => {
  if (root.startsWith(tmpdir())) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('P0B06 local blob store', () => {
  it('stages and installs content under its digest', async () => {
    const staged = await store.stage(tenant, Buffer.from('hello'), 'text/plain');

    expect(staged.size).toBe(5);
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(staged.storageKey).toBe(`staging/${tenant}/${staged.sha256}`);

    const installed = await store.install(tenant, staged);

    expect(installed.storageKey).toBe(`blobs/${tenant}/${staged.sha256}`);
    await expect(store.read(tenant, installed.storageKey)).resolves.toEqual(Buffer.from('hello'));
    await expect(
      store.verify(tenant, installed.storageKey, staged.sha256, staged.size),
    ).resolves.toBe(true);
    await expect(store.verifyContent(tenant, staged.sha256, staged.size)).resolves.toBe(true);

    // The staging copy is gone after installation.
    await expect(readdir(path.join(root, 'staging', tenant))).resolves.toEqual([]);
  });

  it('is idempotent for concurrent installations of the same content', async () => {
    const staged = await store.stage(tenant, Buffer.from('same'), 'text/plain');

    const installed = await Promise.all(
      Array.from({ length: 8 }, () => store.install(tenant, staged)),
    );

    expect(new Set(installed.map((entry) => entry.storageKey)).size).toBe(1);
    await expect(store.read(tenant, installed[0]!.storageKey)).resolves.toEqual(
      Buffer.from('same'),
    );
  });

  it('refuses content above the configured limit and writes nothing', async () => {
    await expect(store.stage(tenant, Buffer.alloc(17), 'text/plain')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    const staging = await readdir(path.join(root, 'staging', tenant)).catch(() => []);

    expect(staging).toEqual([]);
  });

  it('rejects an absolute or traversing key and a foreign tenant key', async () => {
    await expect(store.read(tenant, '/etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(store.read(tenant, `blobs/${tenant}/../../etc/passwd`)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    const foreign = `blobs/${randomUUID()}/${'a'.repeat(64)}`;

    await expect(store.read(tenant, foreign)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('refuses to follow a symlink inside the root', async () => {
    const digest = 'd'.repeat(64);
    const target = path.join(root, 'blobs', tenant, digest);

    await mkdir(path.dirname(target), { recursive: true });
    await symlink('/etc/hostname', target);

    await expect(store.read(tenant, `blobs/${tenant}/${digest}`)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  it('detects tampered installed bytes', async () => {
    const staged = await store.stage(tenant, Buffer.from('original'), 'text/plain');
    const installed = await store.install(tenant, staged);

    await writeFile(path.join(root, ...installed.storageKey.split('/')), 'tampered');

    await expect(
      store.verify(tenant, installed.storageKey, staged.sha256, staged.size),
    ).resolves.toBe(false);
    await expect(store.verifyContent(tenant, staged.sha256, staged.size)).resolves.toBe(false);
  });

  it('never overwrites an existing installed digest with different bytes', async () => {
    const digest = 'e'.repeat(64);
    const target = path.join(root, 'blobs', tenant, digest);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'corrupted');

    const staged = await store.stage(tenant, Buffer.from('payload'), 'text/plain');

    // Point the staged reference at the pre-existing (corrupt) target digest.
    await expect(
      store.install(tenant, {
        ...staged,
        sha256: digest,
        storageKey: `staging/${tenant}/${digest}`,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(stat(target)).resolves.toBeDefined();
  });

  it('refuses to stage for a malformed tenant or media type', async () => {
    await expect(store.stage('not-a-uuid', Buffer.from('x'), 'text/plain')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      store.stage(tenant, Buffer.from('x'), 'text/plain; charset=utf-8'),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
