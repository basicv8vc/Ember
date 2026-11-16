import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { BlobSource, StagedBlobRef } from '@ember/contracts';
import { MAX_BLOB_BYTES } from '@ember/contracts';
import { DomainError, InvalidArgumentError, type Id } from '@ember/domain';
import {
  SHA256_PATTERN,
  UUID_PATTERN,
  blobKeyFor,
  parseDigest,
  parseMediaType,
  parseStorageKey,
  parseTenantId,
  stagingKeyFor,
  type InstalledFile,
} from './validation.js';

export {
  blobKeyFor,
  parseDigest,
  parseMediaType,
  parseStorageKey,
  parseTenantId,
  stagingKeyFor,
  type InstalledFile,
};

/**
 * Local, content-addressed blob storage (P0B-06 adapter).
 *
 * Layout inside a controlled root (mode 0700, never a project or home directory):
 *
 * ```text
 * <root>/staging/<tenantId>/<sha256>   private, verified, not yet published
 * <root>/blobs/<tenantId>/<sha256>     immutable installed bytes
 * ```
 *
 * Every relative key is derived from a validated UUID and a SHA-256 digest, never from a
 * caller-supplied path, so `../`, absolute paths, NUL bytes and separator tricks cannot be
 * represented. Every file access additionally rejects symlinks and re-checks that the real
 * parent directory stays inside the root, which covers a directory swapped after validation.
 */

export interface LocalBlobStoreOptions {
  /** Absolute path of the controlled blob root. */
  readonly rootDir: string;
  /** Hard upper bound for a single blob; defaults to the contract maximum. */
  readonly maxBytes?: number;
}

function invalid(field: string, code: string): never {
  throw new InvalidArgumentError([{ path: field, code }]);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Hard-link a staged file into its content key, then drop the staging name.
 *
 * `link` fails instead of overwriting when the destination exists, which is exactly the
 * "never silently replace immutable bytes" rule. Both names live inside the same root, so no
 * cross-device fallback is needed.
 */
async function linkNoClobber(from: string, to: string): Promise<'linked' | 'exists'> {
  try {
    await link(from, to);
    await unlink(from).catch(() => undefined);
    return 'linked';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'exists';
    }
    throw error;
  }
}

/**
 * Local blob store.
 *
 * The class exposes filesystem operations only; `PostgresBlobStore` adds the durable staging
 * and artifact metadata plus the reference-aware garbage collector.
 */
export class LocalBlobStore {
  private readonly rootDir: string;
  private readonly maxBytes: number;

  constructor(options: LocalBlobStoreOptions) {
    if (typeof options.rootDir !== 'string' || !path.isAbsolute(options.rootDir)) {
      invalid('rootDir', 'must_be_absolute');
    }

    this.rootDir = path.resolve(options.rootDir);
    this.maxBytes = options.maxBytes ?? MAX_BLOB_BYTES;

    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      invalid('maxBytes', 'invalid_limit');
    }
  }

  get root(): string {
    return this.rootDir;
  }

  get limitBytes(): number {
    return this.maxBytes;
  }

  /** Create the root and both namespaces with owner-only permissions. */
  async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const info = await stat(this.rootDir);

    if (!info.isDirectory()) {
      throw new DomainError('DB_UNAVAILABLE', 'blob root is not a directory');
    }

    for (const namespace of ['staging', 'blobs'] as const) {
      await mkdir(path.join(this.rootDir, namespace), { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Resolve a validated relative key to an absolute path inside the root.
   *
   * Both the lexical containment check and the real path of the (existing) parent directory
   * are verified, so a symlinked directory cannot redirect a write outside the root.
   */
  async resolveKey(storageKey: string, namespace: 'staging' | 'blobs'): Promise<string> {
    parseStorageKey(storageKey, namespace);
    const absolute = path.join(this.rootDir, ...storageKey.split('/'));

    if (!this.isInsideRoot(absolute)) {
      throw new DomainError('POLICY_DENIED', 'blob path escapes the controlled root');
    }

    const parent = path.dirname(absolute);
    await mkdir(parent, { recursive: true, mode: 0o700 });

    const [rootReal, parentReal] = await Promise.all([realpath(this.rootDir), realpath(parent)]);

    if (!this.isInsideRoot(parentReal, rootReal)) {
      throw new DomainError('POLICY_DENIED', 'blob directory escapes the controlled root');
    }

    const existing = await lstat(absolute).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });

    if (existing !== null && existing.isSymbolicLink()) {
      throw new DomainError('POLICY_DENIED', 'blob path must not be a symbolic link');
    }

    return absolute;
  }

  private isInsideRoot(candidate: string, root = this.rootDir): boolean {
    const relative = path.relative(root, candidate);

    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * Write bytes to the private staging area while hashing them.
   *
   * The write goes to a uniquely named `.part` file opened with `O_EXCL` (so an existing
   * symlink or file can never be followed) and is fsynced before an atomic link. The size
   * limit is enforced while streaming, so an oversized or endless source is aborted instead
   * of being materialised in memory.
   */
  async stage(
    tenantId: Id,
    source: BlobSource,
    mediaType: string,
    options: { readonly maxBytes?: number } = {},
  ): Promise<StagedBlobRef> {
    const tenant = parseTenantId(tenantId);
    const type = parseMediaType(mediaType);
    const limit = options.maxBytes ?? this.maxBytes;

    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.maxBytes) {
      invalid('maxBytes', 'invalid_limit');
    }

    await this.ensureRoot();

    const stagedId = randomUUID();
    const stagingDir = path.join(this.rootDir, 'staging', tenant);
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    const realRoot = await realpath(this.rootDir);
    const realParent = await realpath(stagingDir);

    if (!this.isInsideRoot(realParent, realRoot)) {
      throw new DomainError('POLICY_DENIED', 'staging directory escapes the controlled root');
    }

    const tempPath = path.join(stagingDir, `.${stagedId}.part`);
    const handle = await open(tempPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;

    try {
      const write = async (chunk: Uint8Array): Promise<void> => {
        if (!(chunk instanceof Uint8Array)) {
          invalid('source', 'invalid_chunk');
        }

        size += chunk.byteLength;

        if (size > limit) {
          throw new DomainError('INVALID_ARGUMENT', 'blob exceeds the configured size limit');
        }

        hash.update(chunk);
        await handle.write(chunk);
      };

      if (source instanceof Uint8Array) {
        await write(source);
      } else {
        for await (const chunk of source) {
          await write(chunk);
        }
      }

      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }

    const sha256 = hash.digest('hex');
    const key = stagingKeyFor(tenant, sha256);
    const target = await this.resolveKey(key, 'staging');
    const outcome = await linkNoClobber(tempPath, target);

    if (outcome === 'exists') {
      await unlink(tempPath).catch(() => undefined);
    }

    return Object.freeze({ stagedId, sha256, size, mediaType: type, storageKey: key });
  }

  /**
   * Verify the staged bytes again and atomically install them under their content key.
   *
   * The re-hash is what makes "verified" meaningful: bytes that changed after staging (or a
   * staging file swapped for another one) are rejected instead of being published.
   */
  async install(tenantId: Id, staged: StagedBlobRef): Promise<InstalledFile> {
    const tenant = parseTenantId(tenantId);
    const digest = parseDigest(staged.sha256);

    if (staged.storageKey !== stagingKeyFor(tenant, digest)) {
      throw new DomainError('POLICY_DENIED', 'staged key does not belong to this tenant');
    }

    const source = await this.resolveKey(staged.storageKey, 'staging');
    const key = blobKeyFor(tenant, digest);
    const target = await this.resolveKey(key, 'blobs');

    // Concurrent installs of the same content are expected. The destination is
    // content-addressed, so an already installed file with the right bytes is success.
    if (await this.verifyInstalled(target, digest, staged.size)) {
      await rm(source, { force: true });
      return Object.freeze({ storageKey: key, sha256: digest, size: staged.size });
    }

    let outcome;

    try {
      // Re-hash the staged bytes first: "verified" must mean the bytes being published.
      const actual = await this.hashFile(source);

      if (actual.sha256 !== digest || actual.size !== staged.size) {
        throw new DomainError('DB_UNAVAILABLE', 'staged blob content does not match its record');
      }

      outcome = await linkNoClobber(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Another writer published this digest between our check and the link.
        if (await this.verifyInstalled(target, digest, staged.size)) {
          return Object.freeze({ storageKey: key, sha256: digest, size: staged.size });
        }

        throw new DomainError('NOT_FOUND', 'staged blob file is missing');
      }

      throw error;
    }

    if (outcome === 'exists') {
      if (!(await this.verifyInstalled(target, digest, staged.size))) {
        // Never overwrite: a digest-addressed file that no longer matches is corruption.
        throw new DomainError('DB_UNAVAILABLE', 'installed blob file is corrupted');
      }

      await rm(source, { force: true });
      return Object.freeze({ storageKey: key, sha256: digest, size: staged.size });
    }

    return Object.freeze({ storageKey: key, sha256: digest, size: staged.size });
  }

  /** True only when the file exists and still hashes to the expected identity. */
  private async verifyInstalled(
    absolutePath: string,
    sha256: string,
    size: number,
  ): Promise<boolean> {
    const existing = await lstat(absolutePath).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });

    if (existing === null) {
      return false;
    }

    if (existing.isSymbolicLink()) {
      throw new DomainError('POLICY_DENIED', 'blob path must not be a symbolic link');
    }

    const actual = await this.hashFile(absolutePath).catch(() => null);

    return actual !== null && actual.sha256 === sha256 && actual.size === size;
  }

  async read(tenantId: Id, storageKey: string): Promise<Uint8Array> {
    const tenant = parseTenantId(tenantId);
    const digest = parseDigest(storageKey.split('/').pop() ?? '');

    if (storageKey !== blobKeyFor(tenant, digest)) {
      throw new DomainError('POLICY_DENIED', 'blob key does not belong to this tenant');
    }

    const absolute = await this.resolveKey(storageKey, 'blobs');

    try {
      return await readFile(absolute);
    } catch (error) {
      if (isMissing(error)) {
        throw new DomainError('NOT_FOUND', 'blob file is missing');
      }
      throw error;
    }
  }

  async verify(
    tenantId: Id,
    storageKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<boolean> {
    const expected = parseDigest(expectedSha256);

    if (storageKey !== blobKeyFor(tenantId, expected)) {
      throw new DomainError('POLICY_DENIED', 'blob key does not belong to this tenant');
    }

    const absolute = await this.resolveKey(storageKey, 'blobs');
    const actual = await this.hashFile(absolute).catch((error: unknown) => {
      if (isMissing(error)) {
        throw new DomainError('NOT_FOUND', 'blob file is missing');
      }
      throw error;
    });

    return actual.sha256 === expected && actual.size === expectedSize;
  }

  /** Verify installed bytes by content identity, without exposing a storage key. */
  async verifyContent(tenantId: Id, sha256: string, size: number): Promise<boolean> {
    return this.verify(tenantId, blobKeyFor(tenantId, sha256), sha256, size);
  }

  /**
   * Cheap presence check for installed bytes: exists, regular file, expected size.
   *
   * Content was already established by `install`; this only answers "are those exact bytes
   * still here". A caller holding the tenant-digest lock uses it to prove that a collector,
   * which takes the same lock before deleting, has not removed the file it is about to
   * reference.
   */
  async assertInstalled(tenantId: Id, sha256: string, size: number): Promise<boolean> {
    const tenant = parseTenantId(tenantId);
    const absolute = await this.resolveKey(blobKeyFor(tenant, parseDigest(sha256)), 'blobs');
    const existing = await lstat(absolute).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });

    if (existing === null) {
      return false;
    }

    if (existing.isSymbolicLink()) {
      throw new DomainError('POLICY_DENIED', 'blob path must not be a symbolic link');
    }

    return existing.isFile() && existing.size === size;
  }

  async discard(tenantId: Id, staged: StagedBlobRef): Promise<void> {
    const tenant = parseTenantId(tenantId);

    if (staged.storageKey !== stagingKeyFor(tenant, staged.sha256)) {
      throw new DomainError('POLICY_DENIED', 'staged key does not belong to this tenant');
    }

    const absolute = await this.resolveKey(staged.storageKey, 'staging');
    await rm(absolute, { force: true });
  }

  /** Streaming SHA-256 plus size of one file, without loading it into memory. */
  async hashFile(absolutePath: string): Promise<{ sha256: string; size: number }> {
    const hash = createHash('sha256');
    let size = 0;

    for await (const chunk of createReadStream(absolutePath)) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      hash.update(buffer);
    }

    return { sha256: hash.digest('hex'), size };
  }

  /** List relative keys below one namespace. Used by the reference-aware garbage collector. */
  async listKeys(namespace: 'staging' | 'blobs'): Promise<readonly string[]> {
    const base = path.join(this.rootDir, namespace);
    const keys: string[] = [];
    let tenants: string[];

    try {
      tenants = await readdir(base);
    } catch (error) {
      if (isMissing(error)) {
        return Object.freeze([]);
      }
      throw error;
    }

    for (const tenant of tenants) {
      if (!UUID_PATTERN.test(tenant)) {
        continue;
      }

      const files = await readdir(path.join(base, tenant)).catch(() => [] as string[]);

      for (const file of files) {
        if (SHA256_PATTERN.test(file)) {
          keys.push(`${namespace}/${tenant}/${file}`);
        }
      }
    }

    return Object.freeze(keys.sort());
  }

  async removeKey(storageKey: string, namespace: 'staging' | 'blobs'): Promise<void> {
    const absolute = await this.resolveKey(storageKey, namespace);
    await rm(absolute, { force: true });
  }

  /** Age of a stored file, `null` when it disappeared concurrently. */
  async ageMs(
    storageKey: string,
    namespace: 'staging' | 'blobs',
    now: Date,
  ): Promise<number | null> {
    const absolute = await this.resolveKey(storageKey, namespace);
    const info = await stat(absolute).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });

    return info === null ? null : Math.max(0, now.getTime() - info.mtimeMs);
  }
}
