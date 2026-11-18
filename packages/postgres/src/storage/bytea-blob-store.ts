import { PYTHON_AGENT_LIMITS } from '@ember/contracts';
import type {
  BlobGcOptions,
  BlobGcReport,
  BlobSource,
  BlobStore,
  InstalledBlobRef,
  StagedBlobRef,
} from '@ember/contracts';
import { DomainError, InvalidArgumentError, type Id } from '@ember/domain';
import type pg from 'pg';
import { asDomainError, withTransaction } from '../repositories/support.js';
import { BLOB_LOCK_NAMESPACE, DEFAULT_BLOB_GC_QUARANTINE_MS, blobLockKey } from './blob-store.js';
import {
  deleteR2Keys,
  putR2Bytes,
  readR2Bytes,
  sha256HexBytes,
  type R2BucketPort,
} from './r2-blob-store.js';
import {
  BLOB_KEY_PATTERN,
  STAGING_KEY_PATTERN,
  blobKeyFor,
  parseDigest,
  parseMediaType,
  parseTenantId,
  stagingKeyFor,
} from './validation.js';

export const MAX_BYTEA_BLOB_BYTES = PYTHON_AGENT_LIMITS.maxFileBytes;

type StorageBackend = 'postgres' | 'r2';

const INSERT_STAGED_METADATA_SQL = `
INSERT INTO staged_blobs (
  id, tenant_id, task_id, run_id, lease_epoch, sha256, size, media_type, storage_key, state
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
`;

const UPSERT_BYTEA_STAGED_SQL = `
INSERT INTO bytea_staged_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, storage_key) DO NOTHING
`;

const SELECT_BYTEA_STAGED_BACKEND_SQL = `
SELECT storage_backend
  FROM bytea_staged_blobs
 WHERE tenant_id = $1 AND storage_key = $2
 LIMIT 1
`;

const SELECT_BYTEA_STAGED_SQL = `
SELECT sha256, size, media_type, storage_backend, bytes
  FROM bytea_staged_blobs
 WHERE tenant_id = $1 AND storage_key = $2
`;

const HAS_BYTEA_STAGED_KEY_SQL = `
SELECT 1
  FROM bytea_staged_blobs
 WHERE tenant_id = $1 AND storage_key = $2
 LIMIT 1
`;

const SELECT_BYTEA_BLOB_SQL = `
SELECT sha256, size, media_type, storage_backend, bytes
  FROM bytea_blobs
 WHERE tenant_id = $1 AND storage_key = $2
`;

const HAS_BYTEA_BLOB_KEY_SQL = `
SELECT 1
  FROM bytea_blobs
 WHERE tenant_id = $1 AND storage_key = $2
 LIMIT 1
`;

const SELECT_BYTEA_BLOB_SIZE_SQL = `
SELECT size
  FROM bytea_blobs
 WHERE tenant_id = $1 AND storage_key = $2 AND sha256 = $3
`;

const INSERT_BYTEA_BLOB_SQL = `
INSERT INTO bytea_blobs (tenant_id, storage_key, sha256, size, media_type, storage_backend, bytes)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, storage_key) DO NOTHING
`;

const MARK_STAGED_SETTLED_SQL = `
UPDATE staged_blobs
   SET state = $3, settled_at = clock_timestamp()
 WHERE tenant_id = $1 AND id = $2 AND state = 'pending'
`;

const HAS_PENDING_STAGED_KEY_SQL = `
SELECT 1
  FROM staged_blobs
 WHERE tenant_id = $1 AND storage_key = $2 AND state = 'pending'
 LIMIT 1
`;

const DELETE_BYTEA_STAGED_KEY_SQL = `
DELETE FROM bytea_staged_blobs
 WHERE tenant_id = $1 AND storage_key = $2
 RETURNING storage_backend
`;

const LIST_STAGED_CANDIDATES_SQL = `
SELECT tenant_id, storage_key, storage_backend, created_at
  FROM bytea_staged_blobs
 WHERE created_at <= $1
 ORDER BY created_at ASC, storage_key ASC
`;

const LIST_BLOB_CANDIDATES_SQL = `
SELECT tenant_id, storage_key, sha256, storage_backend, created_at
  FROM bytea_blobs
 WHERE created_at <= $1
 ORDER BY created_at ASC, storage_key ASC
`;

const STAGED_ROWS_SQL = `
SELECT id, state, created_at
  FROM staged_blobs
 WHERE tenant_id = $1 AND storage_key = $2
`;

const DELETE_STAGED_BY_ID_SQL = `
DELETE FROM staged_blobs
 WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND state = 'pending'
`;

const BLOB_ROW_SQL = `
SELECT 1 FROM blobs WHERE tenant_id = $1 AND sha256 = $2
`;

const ARTIFACT_REFERENCE_SQL = `
SELECT 1 FROM artifacts WHERE tenant_id = $1 AND sha256 = $2 LIMIT 1
`;

const DELETE_BYTEA_BLOB_KEY_SQL = `
DELETE FROM bytea_blobs
 WHERE tenant_id = $1 AND storage_key = $2
`;

const ADVISORY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;

export interface PostgresByteaBlobStoreOptions {
  readonly maxBytes?: number;
  readonly gcQuarantineMs?: number;
  readonly r2Bucket?: R2BucketPort;
  readonly ownership?: {
    readonly taskId?: Id | null;
    readonly runId?: Id | null;
    readonly leaseEpoch?: number | null;
  };
}

/** Compute lowercase hex SHA-256 digest using Web Crypto (edge-safe, zero node:* imports). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return sha256HexBytes(bytes);
}

/** Decode a `pg` bytea column (Buffer, Uint8Array, or `\x`-prefixed hex) into `Uint8Array`. */
export function decodePgBytea(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string' && value.startsWith('\\x')) {
    const hex = value.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  throw new DomainError('DB_UNAVAILABLE', 'unexpected bytea payload returned by database');
}

/** Collect a `BlobSource` into a single bounded `Uint8Array`, enforcing `limitBytes`. */
export async function readBoundedBlobSource(
  source: BlobSource,
  limitBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0 || limitBytes > MAX_BYTEA_BLOB_BYTES) {
    throw new InvalidArgumentError([{ path: 'maxBytes', code: 'invalid_limit' }]);
  }

  if (source instanceof Uint8Array) {
    if (source.byteLength > limitBytes) {
      throw new DomainError('INVALID_ARGUMENT', 'blob exceeds the configured size limit');
    }
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw new InvalidArgumentError([{ path: 'source', code: 'invalid_chunk' }]);
    }
    total += chunk.byteLength;
    if (total > limitBytes) {
      throw new DomainError('INVALID_ARGUMENT', 'blob exceeds the configured size limit');
    }
    chunks.push(chunk);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

interface ContentAddressedR2Target {
  readonly scope: 'staged' | 'blob';
  readonly tenantId: string;
  readonly sha256: string;
  readonly storageKey: string;
}

function parseContentAddressedR2Target(storageKey: string): ContentAddressedR2Target | null {
  if (STAGING_KEY_PATTERN.test(storageKey)) {
    const [, tenantId, sha256] = storageKey.split('/');
    if (tenantId !== undefined && sha256 !== undefined) {
      return { scope: 'staged', tenantId, sha256, storageKey };
    }
  }
  if (BLOB_KEY_PATTERN.test(storageKey)) {
    const [, tenantId, sha256] = storageKey.split('/');
    if (tenantId !== undefined && sha256 !== undefined) {
      return { scope: 'blob', tenantId, sha256, storageKey };
    }
  }
  return null;
}

async function hasLiveDbReference(
  client: pg.PoolClient,
  target: ContentAddressedR2Target,
): Promise<boolean> {
  if (target.scope === 'staged') {
    const stagedBytes = await client.query(HAS_BYTEA_STAGED_KEY_SQL, [
      target.tenantId,
      target.storageKey,
    ]);
    if ((stagedBytes.rowCount ?? 0) > 0) {
      return true;
    }
    const pendingStaged = await client.query(HAS_PENDING_STAGED_KEY_SQL, [
      target.tenantId,
      target.storageKey,
    ]);
    return (pendingStaged.rowCount ?? 0) > 0;
  }

  const blobBytes = await client.query(HAS_BYTEA_BLOB_KEY_SQL, [
    target.tenantId,
    target.storageKey,
  ]);
  if ((blobBytes.rowCount ?? 0) > 0) {
    return true;
  }
  const blobRow = await client.query(BLOB_ROW_SQL, [target.tenantId, target.sha256]);
  if ((blobRow.rowCount ?? 0) > 0) {
    return true;
  }
  const artifactRef = await client.query(ARTIFACT_REFERENCE_SQL, [target.tenantId, target.sha256]);
  return (artifactRef.rowCount ?? 0) > 0;
}

/**
 * Delete content-addressed R2 objects only after re-acquiring the `(tenant, digest)` advisory
 * lock, re-checking latest Postgres references, and deleting inside the holding transaction.
 */
export async function cleanupUnreferencedR2Keys(
  pool: pg.Pool,
  r2Bucket: R2BucketPort | undefined,
  keys: readonly string[],
): Promise<void> {
  if (r2Bucket === undefined || keys.length === 0) {
    return;
  }

  const uniqueKeys = [...new Set(keys)];
  const targets: ContentAddressedR2Target[] = [];
  const otherKeys: string[] = [];

  for (const key of uniqueKeys) {
    const parsed = parseContentAddressedR2Target(key);
    if (parsed !== null) {
      targets.push(parsed);
    } else {
      otherKeys.push(key);
    }
  }

  if (targets.length > 0) {
    targets.sort(
      (a, b) =>
        a.tenantId.localeCompare(b.tenantId) ||
        a.sha256.localeCompare(b.sha256) ||
        a.scope.localeCompare(b.scope),
    );

    await withTransaction(pool, async (client) => {
      let lastLockKey: string | null = null;
      for (const target of targets) {
        const lockKey = blobLockKey(target.tenantId, target.sha256);
        if (lockKey !== lastLockKey) {
          await client.query(ADVISORY_LOCK_SQL, [lockKey]);
          lastLockKey = lockKey;
        }
        const referenced = await hasLiveDbReference(client, target);
        if (!referenced) {
          await deleteR2Keys(r2Bucket, [target.storageKey]);
        }
      }
    });
  }

  if (otherKeys.length > 0) {
    await deleteR2Keys(r2Bucket, otherKeys);
  }
}

/**
 * Edge-safe Neon PostgreSQL `bytea` or Cloudflare R2 `BlobStore` adapter.
 *
 * Keeps zero `node:*` imports so Cloudflare Workers bundles (`apps/api`,
 * `apps/cloud-async-runtime`) can import it directly.
 */
export class PostgresByteaBlobStore implements BlobStore {
  private readonly maxBytes: number;
  private readonly gcQuarantineMs: number;
  readonly r2Bucket: R2BucketPort | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PostgresByteaBlobStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? MAX_BYTEA_BLOB_BYTES;
    this.gcQuarantineMs = options.gcQuarantineMs ?? DEFAULT_BLOB_GC_QUARANTINE_MS;
    this.r2Bucket = options.r2Bucket;

    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes <= 0 ||
      this.maxBytes > MAX_BYTEA_BLOB_BYTES
    ) {
      throw new InvalidArgumentError([{ path: 'maxBytes', code: 'invalid_limit' }]);
    }
    if (!Number.isSafeInteger(this.gcQuarantineMs) || this.gcQuarantineMs <= 0) {
      throw new DomainError('INVALID_ARGUMENT', 'blob gc quarantine must be a positive duration');
    }
  }

  get limitBytes(): number {
    return this.maxBytes;
  }

  private async readStoredPayload(
    backend: StorageBackend,
    storageKey: string,
    pgBytes: unknown,
    expected?: { readonly size?: number; readonly sha256?: string },
  ): Promise<Uint8Array> {
    if (backend === 'r2') {
      if (this.r2Bucket === undefined) {
        throw new DomainError('DB_UNAVAILABLE', 'r2 bucket binding missing for r2-backed blob');
      }
      return readR2Bytes(this.r2Bucket, storageKey, expected);
    }

    const bytes = decodePgBytea(pgBytes);
    if (expected?.size !== undefined && bytes.byteLength !== expected.size) {
      throw new DomainError('DB_UNAVAILABLE', 'blob byte length mismatch');
    }
    if (expected?.sha256 !== undefined && (await sha256Hex(bytes)) !== expected.sha256) {
      throw new DomainError('DB_UNAVAILABLE', 'blob content does not match its digest');
    }
    return bytes;
  }

  async cleanupR2Keys(keys: readonly string[]): Promise<void> {
    await cleanupUnreferencedR2Keys(this.pool, this.r2Bucket, keys);
  }

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
      throw new InvalidArgumentError([{ path: 'maxBytes', code: 'invalid_limit' }]);
    }

    const bytes = await readBoundedBlobSource(source, limit);
    const sha256 = await sha256Hex(bytes);
    const stagedId = globalThis.crypto.randomUUID();
    const storageKey = stagingKeyFor(tenant, sha256);
    const ownership = this.options.ownership ?? {};
    const backend: StorageBackend = this.r2Bucket !== undefined ? 'r2' : 'postgres';
    let wroteR2 = false;

    try {
      await withTransaction(this.pool, async (client) => {
        await client.query(ADVISORY_LOCK_SQL, [blobLockKey(tenant, sha256)]);

        if (this.r2Bucket !== undefined) {
          const existingStaged = await client.query<{ storage_backend: StorageBackend }>(
            SELECT_BYTEA_STAGED_BACKEND_SQL,
            [tenant, storageKey],
          );
          if ((existingStaged.rowCount ?? 0) === 0) {
            await putR2Bytes(this.r2Bucket, storageKey, bytes, {
              httpMetadata: { contentType: type },
              customMetadata: { tenantId: tenant, sha256 },
            });
            wroteR2 = true;
          }
        }

        await client.query(UPSERT_BYTEA_STAGED_SQL, [
          tenant,
          storageKey,
          sha256,
          bytes.byteLength,
          type,
          backend,
          backend === 'r2' ? null : bytes,
        ]);
        await client.query(INSERT_STAGED_METADATA_SQL, [
          stagedId,
          tenant,
          ownership.taskId ?? null,
          ownership.runId ?? null,
          ownership.leaseEpoch ?? null,
          sha256,
          bytes.byteLength,
          type,
          storageKey,
        ]);
      });
    } catch (error) {
      if (wroteR2) {
        await cleanupUnreferencedR2Keys(this.pool, this.r2Bucket, [storageKey]).catch(
          () => undefined,
        );
      }
      throw asDomainError(error);
    }

    return Object.freeze({
      stagedId,
      sha256,
      size: bytes.byteLength,
      mediaType: type,
      storageKey,
    });
  }

  async install(tenantId: Id, staged: StagedBlobRef): Promise<InstalledBlobRef> {
    const cleanupKeys: string[] = [];
    const rollbackKeys: string[] = [];
    try {
      const installed = await withTransaction(this.pool, async (client) =>
        this.installInTransaction(client, tenantId, staged, cleanupKeys, rollbackKeys),
      );
      await this.cleanupR2Keys(cleanupKeys);
      return installed;
    } catch (error) {
      if (rollbackKeys.length > 0) {
        await cleanupUnreferencedR2Keys(this.pool, this.r2Bucket, rollbackKeys).catch(
          () => undefined,
        );
      }
      throw asDomainError(error);
    }
  }

  /**
   * Verify and install a staged blob inside an existing transaction so artifact rows
   * and blob records commit or roll back together.
   */
  async installInTransaction(
    client: pg.PoolClient,
    tenantId: Id,
    staged: StagedBlobRef,
    cleanupR2Keys?: string[],
    rollbackR2Keys?: string[],
  ): Promise<InstalledBlobRef> {
    const tenant = parseTenantId(tenantId);
    const digest = parseDigest(staged.sha256);
    const mediaType = parseMediaType(staged.mediaType);

    if (staged.storageKey !== stagingKeyFor(tenant, digest)) {
      throw new DomainError('POLICY_DENIED', 'staged key does not belong to this tenant');
    }

    const targetKey = blobKeyFor(tenant, digest);
    await client.query(ADVISORY_LOCK_SQL, [blobLockKey(tenant, digest)]);

    const existing = await client.query<{
      sha256: string;
      size: string | number;
      media_type: string;
      storage_backend: StorageBackend;
      bytes: unknown;
    }>(SELECT_BYTEA_BLOB_SQL, [tenant, targetKey]);

    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0]!;
      await this.readStoredPayload(row.storage_backend, targetKey, row.bytes, {
        size: staged.size,
        sha256: digest,
      });
    } else {
      const stagedRow = await client.query<{
        sha256: string;
        size: string | number;
        media_type: string;
        storage_backend: StorageBackend;
        bytes: unknown;
      }>(SELECT_BYTEA_STAGED_SQL, [tenant, staged.storageKey]);

      if ((stagedRow.rowCount ?? 0) === 0) {
        throw new DomainError('NOT_FOUND', 'staged blob bytes are missing');
      }

      const row = stagedRow.rows[0]!;
      const bytes = await this.readStoredPayload(
        row.storage_backend,
        staged.storageKey,
        row.bytes,
        {
          size: staged.size,
          sha256: digest,
        },
      );

      const backend: StorageBackend = this.r2Bucket !== undefined ? 'r2' : 'postgres';
      if (this.r2Bucket !== undefined) {
        await putR2Bytes(this.r2Bucket, targetKey, bytes, {
          httpMetadata: { contentType: mediaType },
          customMetadata: { tenantId: tenant, sha256: digest },
        });
        rollbackR2Keys?.push(targetKey);
      }

      await client.query(INSERT_BYTEA_BLOB_SQL, [
        tenant,
        targetKey,
        digest,
        bytes.byteLength,
        mediaType,
        backend,
        backend === 'r2' ? null : bytes,
      ]);
    }

    await client.query(MARK_STAGED_SETTLED_SQL, [tenant, staged.stagedId, 'published']);
    const pending = await client.query(HAS_PENDING_STAGED_KEY_SQL, [tenant, staged.storageKey]);
    if ((pending.rowCount ?? 0) === 0) {
      const deleted = await client.query<{ storage_backend: StorageBackend }>(
        DELETE_BYTEA_STAGED_KEY_SQL,
        [tenant, staged.storageKey],
      );
      if (deleted.rows[0]?.storage_backend === 'r2') {
        cleanupR2Keys?.push(staged.storageKey);
      }
    }

    return Object.freeze({
      sha256: digest,
      size: staged.size,
      mediaType,
      storageKey: targetKey,
    });
  }

  async read(tenantId: Id, storageKey: string): Promise<Uint8Array> {
    const tenant = parseTenantId(tenantId);
    const digest = parseDigest(storageKey.split('/').pop() ?? '');

    if (storageKey !== blobKeyFor(tenant, digest)) {
      throw new DomainError('POLICY_DENIED', 'blob key does not belong to this tenant');
    }

    try {
      const result = await this.pool.query<{ storage_backend: StorageBackend; bytes: unknown }>(
        SELECT_BYTEA_BLOB_SQL,
        [tenant, storageKey],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new DomainError('NOT_FOUND', 'blob bytes are missing');
      }
      const row = result.rows[0]!;
      return this.readStoredPayload(row.storage_backend, storageKey, row.bytes);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async verifyContent(tenantId: Id, sha256: string, size: number): Promise<boolean> {
    const tenant = parseTenantId(tenantId);
    const digest = parseDigest(sha256);
    return this.verify(tenant, blobKeyFor(tenant, digest), digest, size);
  }

  async assertInstalled(tenantId: Id, sha256: string, size: number): Promise<boolean> {
    const tenant = parseTenantId(tenantId);
    const digest = parseDigest(sha256);
    const targetKey = blobKeyFor(tenant, digest);

    try {
      const result = await this.pool.query<{ size: string | number }>(SELECT_BYTEA_BLOB_SIZE_SQL, [
        tenant,
        targetKey,
        digest,
      ]);
      if ((result.rowCount ?? 0) === 0) {
        return false;
      }
      return Number(result.rows[0]!.size) === size;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async verify(
    tenantId: Id,
    storageKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<boolean> {
    const tenant = parseTenantId(tenantId);
    const expected = parseDigest(expectedSha256);

    if (storageKey !== blobKeyFor(tenant, expected)) {
      throw new DomainError('POLICY_DENIED', 'blob key does not belong to this tenant');
    }

    try {
      const result = await this.pool.query<{ storage_backend: StorageBackend; bytes: unknown }>(
        SELECT_BYTEA_BLOB_SQL,
        [tenant, storageKey],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new DomainError('NOT_FOUND', 'blob bytes are missing');
      }
      const row = result.rows[0]!;
      const bytes = await this.readStoredPayload(row.storage_backend, storageKey, row.bytes);
      const actualDigest = await sha256Hex(bytes);
      return actualDigest === expected && bytes.byteLength === expectedSize;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async discard(tenantId: Id, staged: StagedBlobRef): Promise<void> {
    const tenant = parseTenantId(tenantId);
    const digest = parseDigest(staged.sha256);

    if (staged.storageKey !== stagingKeyFor(tenant, digest)) {
      throw new DomainError('POLICY_DENIED', 'staged key does not belong to this tenant');
    }

    try {
      let deleteFromR2 = false;
      await withTransaction(this.pool, async (client) => {
        await client.query(ADVISORY_LOCK_SQL, [`${BLOB_LOCK_NAMESPACE}:${tenant}:${digest}`]);
        await client.query(MARK_STAGED_SETTLED_SQL, [tenant, staged.stagedId, 'abandoned']);
        const pending = await client.query(HAS_PENDING_STAGED_KEY_SQL, [tenant, staged.storageKey]);
        if ((pending.rowCount ?? 0) === 0) {
          const deleted = await client.query<{ storage_backend: StorageBackend }>(
            DELETE_BYTEA_STAGED_KEY_SQL,
            [tenant, staged.storageKey],
          );
          deleteFromR2 = deleted.rows[0]?.storage_backend === 'r2';
        }
      });
      if (deleteFromR2) {
        await this.cleanupR2Keys([staged.storageKey]);
      }
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async sweepOrphans(now: Date, options: BlobGcOptions): Promise<BlobGcReport> {
    const retentionMs = options.retentionMs ?? this.gcQuarantineMs;

    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
      throw new DomainError('INVALID_ARGUMENT', 'blob gc retention must be a positive duration');
    }

    const cutoff = new Date(now.getTime() - retentionMs);
    const dryRun = options.dryRun ?? false;

    try {
      const [stagedRows, blobRows] = await Promise.all([
        this.pool.query<{
          tenant_id: string;
          storage_key: string;
          storage_backend: StorageBackend;
          created_at: Date | string;
        }>(LIST_STAGED_CANDIDATES_SQL, [now]),
        this.pool.query<{
          tenant_id: string;
          storage_key: string;
          sha256: string;
          storage_backend: StorageBackend;
          created_at: Date | string;
        }>(LIST_BLOB_CANDIDATES_SQL, [now]),
      ]);

      let removedStaged = 0;
      let removedBlobs = 0;
      let retained = 0;
      const r2KeysToDelete: string[] = [];

      for (const candidate of stagedRows.rows) {
        if (
          toDate(candidate.created_at).getTime() > cutoff.getTime() ||
          (candidate.storage_backend === 'r2' && this.r2Bucket === undefined)
        ) {
          retained += 1;
          continue;
        }
        const sha256 = parseDigest(candidate.storage_key.split('/').pop() ?? '');
        const outcome = await withTransaction(this.pool, async (client) => {
          await client.query(ADVISORY_LOCK_SQL, [
            `${BLOB_LOCK_NAMESPACE}:${candidate.tenant_id}:${sha256}`,
          ]);
          const rows = await client.query<{ id: string; state: string; created_at: Date | string }>(
            STAGED_ROWS_SQL,
            [candidate.tenant_id, candidate.storage_key],
          );
          const protectedRow = rows.rows.some(
            (row) => row.state !== 'pending' || toDate(row.created_at).getTime() > cutoff.getTime(),
          );
          if (protectedRow) {
            return { collected: false as const, r2Key: null as string | null };
          }
          let r2Key: string | null = null;
          if (!dryRun) {
            const deleted = await client.query<{ storage_backend: StorageBackend }>(
              DELETE_BYTEA_STAGED_KEY_SQL,
              [candidate.tenant_id, candidate.storage_key],
            );
            if (deleted.rows[0]?.storage_backend === 'r2') {
              r2Key = candidate.storage_key;
            }
            if (rows.rows.length > 0) {
              await client.query(DELETE_STAGED_BY_ID_SQL, [
                candidate.tenant_id,
                rows.rows.map((row) => row.id),
              ]);
            }
          }
          return { collected: true as const, r2Key };
        });

        if (outcome.collected) {
          removedStaged += 1;
          if (outcome.r2Key !== null) {
            r2KeysToDelete.push(outcome.r2Key);
          }
        } else {
          retained += 1;
        }
      }

      for (const candidate of blobRows.rows) {
        if (
          toDate(candidate.created_at).getTime() > cutoff.getTime() ||
          (candidate.storage_backend === 'r2' && this.r2Bucket === undefined)
        ) {
          retained += 1;
          continue;
        }
        const outcome = await withTransaction(this.pool, async (client) => {
          await client.query(ADVISORY_LOCK_SQL, [
            `${BLOB_LOCK_NAMESPACE}:${candidate.tenant_id}:${candidate.sha256}`,
          ]);
          const blobRow = await client.query(BLOB_ROW_SQL, [candidate.tenant_id, candidate.sha256]);
          if ((blobRow.rowCount ?? 0) > 0) {
            return { collected: false as const, r2Key: null as string | null };
          }
          const referenced = await client.query(ARTIFACT_REFERENCE_SQL, [
            candidate.tenant_id,
            candidate.sha256,
          ]);
          if ((referenced.rowCount ?? 0) > 0) {
            return { collected: false as const, r2Key: null as string | null };
          }
          let r2Key: string | null = null;
          if (!dryRun) {
            await client.query(DELETE_BYTEA_BLOB_KEY_SQL, [
              candidate.tenant_id,
              candidate.storage_key,
            ]);
            if (candidate.storage_backend === 'r2') {
              r2Key = candidate.storage_key;
            }
          }
          return { collected: true as const, r2Key };
        });

        if (outcome.collected) {
          removedBlobs += 1;
          if (outcome.r2Key !== null) {
            r2KeysToDelete.push(outcome.r2Key);
          }
        } else {
          retained += 1;
        }
      }

      if (!dryRun && r2KeysToDelete.length > 0) {
        await this.cleanupR2Keys(r2KeysToDelete);
      }

      return Object.freeze({
        scanned: stagedRows.rows.length + blobRows.rows.length,
        removedStaged,
        removedBlobs,
        retained,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }
}

/** Convenience Cloudflare R2-backed `BlobStore` using Neon metadata + R2 object payloads. */
export class PostgresR2BlobStore extends PostgresByteaBlobStore {
  constructor(
    pool: pg.Pool,
    r2Bucket: R2BucketPort,
    options: Omit<PostgresByteaBlobStoreOptions, 'r2Bucket'> = {},
  ) {
    super(pool, { ...options, r2Bucket });
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
