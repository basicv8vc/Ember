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
import { BLOB_LOCK_NAMESPACE, DEFAULT_BLOB_GC_QUARANTINE_MS } from './blob-store.js';
import { blobKeyFor, parseDigest, parseMediaType, parseTenantId, stagingKeyFor } from './validation.js';

export const MAX_BYTEA_BLOB_BYTES = PYTHON_AGENT_LIMITS.maxFileBytes;

const INSERT_STAGED_METADATA_SQL = `
INSERT INTO staged_blobs (
  id, tenant_id, task_id, run_id, lease_epoch, sha256, size, media_type, storage_key, state
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
`;

const UPSERT_BYTEA_STAGED_SQL = `
INSERT INTO bytea_staged_blobs (tenant_id, storage_key, sha256, size, media_type, bytes)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, storage_key) DO NOTHING
`;

const SELECT_BYTEA_STAGED_SQL = `
SELECT sha256, size, media_type, bytes
  FROM bytea_staged_blobs
 WHERE tenant_id = $1 AND storage_key = $2
`;

const SELECT_BYTEA_BLOB_SQL = `
SELECT sha256, size, media_type, bytes
  FROM bytea_blobs
 WHERE tenant_id = $1 AND storage_key = $2
`;

const SELECT_BYTEA_BLOB_SIZE_SQL = `
SELECT size
  FROM bytea_blobs
 WHERE tenant_id = $1 AND storage_key = $2 AND sha256 = $3
`;

const INSERT_BYTEA_BLOB_SQL = `
INSERT INTO bytea_blobs (tenant_id, storage_key, sha256, size, media_type, bytes)
VALUES ($1, $2, $3, $4, $5, $6)
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
`;

const LIST_STAGED_CANDIDATES_SQL = `
SELECT tenant_id, storage_key, created_at
  FROM bytea_staged_blobs
 WHERE created_at <= $1
 ORDER BY created_at ASC, storage_key ASC
`;

const LIST_BLOB_CANDIDATES_SQL = `
SELECT tenant_id, storage_key, sha256, created_at
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
  readonly ownership?: {
    readonly taskId?: Id | null;
    readonly runId?: Id | null;
    readonly leaseEpoch?: number | null;
  };
}

/** Compute lowercase hex SHA-256 digest using Web Crypto (edge-safe, zero node:* imports). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i]!.toString(16).padStart(2, '0');
  }
  return hex;
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

/**
 * Edge-safe Neon PostgreSQL `bytea` `BlobStore` adapter (`<= 256 KiB` per object).
 *
 * Keeps zero `node:*` imports so Cloudflare Workers bundles (`apps/api`,
 * `apps/cloud-async-runtime`) can import it directly.
 */
export class PostgresByteaBlobStore implements BlobStore {
  private readonly maxBytes: number;
  private readonly gcQuarantineMs: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PostgresByteaBlobStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? MAX_BYTEA_BLOB_BYTES;
    this.gcQuarantineMs = options.gcQuarantineMs ?? DEFAULT_BLOB_GC_QUARANTINE_MS;

    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0 || this.maxBytes > MAX_BYTEA_BLOB_BYTES) {
      throw new InvalidArgumentError([{ path: 'maxBytes', code: 'invalid_limit' }]);
    }
    if (!Number.isSafeInteger(this.gcQuarantineMs) || this.gcQuarantineMs <= 0) {
      throw new DomainError('INVALID_ARGUMENT', 'blob gc quarantine must be a positive duration');
    }
  }

  get limitBytes(): number {
    return this.maxBytes;
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

    try {
      await withTransaction(this.pool, async (client) => {
        await client.query(ADVISORY_LOCK_SQL, [`${BLOB_LOCK_NAMESPACE}:${tenant}:${sha256}`]);
        await client.query(UPSERT_BYTEA_STAGED_SQL, [
          tenant,
          storageKey,
          sha256,
          bytes.byteLength,
          type,
          bytes,
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
    try {
      return await withTransaction(this.pool, async (client) =>
        this.installInTransaction(client, tenantId, staged),
      );
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Verify and install a staged `bytea` blob inside an existing transaction so artifact rows
   * and blob bytes commit or roll back together.
   */
  async installInTransaction(
    client: pg.PoolClient,
    tenantId: Id,
    staged: StagedBlobRef,
  ): Promise<InstalledBlobRef> {
    const tenant = parseTenantId(tenantId);
    const digest = parseDigest(staged.sha256);
    const mediaType = parseMediaType(staged.mediaType);

    if (staged.storageKey !== stagingKeyFor(tenant, digest)) {
      throw new DomainError('POLICY_DENIED', 'staged key does not belong to this tenant');
    }

    const targetKey = blobKeyFor(tenant, digest);
    await client.query(ADVISORY_LOCK_SQL, [`${BLOB_LOCK_NAMESPACE}:${tenant}:${digest}`]);

    const existing = await client.query<{
      sha256: string;
      size: string | number;
      media_type: string;
      bytes: unknown;
    }>(SELECT_BYTEA_BLOB_SQL, [tenant, targetKey]);

    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0]!;
      const bytes = decodePgBytea(row.bytes);
      const actualDigest = await sha256Hex(bytes);

      if (actualDigest !== digest || bytes.byteLength !== staged.size) {
        throw new DomainError('DB_UNAVAILABLE', 'installed blob content is corrupted');
      }
    } else {
      const stagedRow = await client.query<{
        sha256: string;
        size: string | number;
        media_type: string;
        bytes: unknown;
      }>(SELECT_BYTEA_STAGED_SQL, [tenant, staged.storageKey]);

      if ((stagedRow.rowCount ?? 0) === 0) {
        throw new DomainError('NOT_FOUND', 'staged blob bytes are missing');
      }

      const bytes = decodePgBytea(stagedRow.rows[0]!.bytes);
      const actualDigest = await sha256Hex(bytes);

      if (actualDigest !== digest || bytes.byteLength !== staged.size) {
        throw new DomainError('DB_UNAVAILABLE', 'staged blob content does not match its record');
      }

      await client.query(INSERT_BYTEA_BLOB_SQL, [
        tenant,
        targetKey,
        digest,
        bytes.byteLength,
        mediaType,
        bytes,
      ]);
    }

    await client.query(MARK_STAGED_SETTLED_SQL, [tenant, staged.stagedId, 'published']);
    const pending = await client.query(HAS_PENDING_STAGED_KEY_SQL, [tenant, staged.storageKey]);
    if ((pending.rowCount ?? 0) === 0) {
      await client.query(DELETE_BYTEA_STAGED_KEY_SQL, [tenant, staged.storageKey]);
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
      const result = await this.pool.query<{ bytes: unknown }>(SELECT_BYTEA_BLOB_SQL, [
        tenant,
        storageKey,
      ]);
      if ((result.rowCount ?? 0) === 0) {
        throw new DomainError('NOT_FOUND', 'blob bytes are missing');
      }
      return decodePgBytea(result.rows[0]!.bytes);
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
      const result = await this.pool.query<{ bytes: unknown }>(SELECT_BYTEA_BLOB_SQL, [
        tenant,
        storageKey,
      ]);
      if ((result.rowCount ?? 0) === 0) {
        throw new DomainError('NOT_FOUND', 'blob bytes are missing');
      }
      const bytes = decodePgBytea(result.rows[0]!.bytes);
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
      await withTransaction(this.pool, async (client) => {
        await client.query(ADVISORY_LOCK_SQL, [`${BLOB_LOCK_NAMESPACE}:${tenant}:${digest}`]);
        await client.query(MARK_STAGED_SETTLED_SQL, [tenant, staged.stagedId, 'abandoned']);
        const pending = await client.query(HAS_PENDING_STAGED_KEY_SQL, [
          tenant,
          staged.storageKey,
        ]);
        if ((pending.rowCount ?? 0) === 0) {
          await client.query(DELETE_BYTEA_STAGED_KEY_SQL, [tenant, staged.storageKey]);
        }
      });
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
        this.pool.query<{ tenant_id: string; storage_key: string; created_at: Date | string }>(
          LIST_STAGED_CANDIDATES_SQL,
          [now],
        ),
        this.pool.query<{
          tenant_id: string;
          storage_key: string;
          sha256: string;
          created_at: Date | string;
        }>(LIST_BLOB_CANDIDATES_SQL, [now]),
      ]);

      let removedStaged = 0;
      let removedBlobs = 0;
      let retained = 0;

      for (const candidate of stagedRows.rows) {
        if (toDate(candidate.created_at).getTime() > cutoff.getTime()) {
          retained += 1;
          continue;
        }
        const sha256 = parseDigest(candidate.storage_key.split('/').pop() ?? '');
        const collected = await withTransaction(this.pool, async (client) => {
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
            return false;
          }
          if (!dryRun) {
            await client.query(DELETE_BYTEA_STAGED_KEY_SQL, [
              candidate.tenant_id,
              candidate.storage_key,
            ]);
            if (rows.rows.length > 0) {
              await client.query(DELETE_STAGED_BY_ID_SQL, [
                candidate.tenant_id,
                rows.rows.map((row) => row.id),
              ]);
            }
          }
          return true;
        });

        if (collected) {
          removedStaged += 1;
        } else {
          retained += 1;
        }
      }

      for (const candidate of blobRows.rows) {
        if (toDate(candidate.created_at).getTime() > cutoff.getTime()) {
          retained += 1;
          continue;
        }
        const collected = await withTransaction(this.pool, async (client) => {
          await client.query(ADVISORY_LOCK_SQL, [
            `${BLOB_LOCK_NAMESPACE}:${candidate.tenant_id}:${candidate.sha256}`,
          ]);
          const blobRow = await client.query(BLOB_ROW_SQL, [candidate.tenant_id, candidate.sha256]);
          if ((blobRow.rowCount ?? 0) > 0) {
            return false;
          }
          const referenced = await client.query(ARTIFACT_REFERENCE_SQL, [
            candidate.tenant_id,
            candidate.sha256,
          ]);
          if ((referenced.rowCount ?? 0) > 0) {
            return false;
          }
          if (!dryRun) {
            await client.query(DELETE_BYTEA_BLOB_KEY_SQL, [
              candidate.tenant_id,
              candidate.storage_key,
            ]);
          }
          return true;
        });

        if (collected) {
          removedBlobs += 1;
        } else {
          retained += 1;
        }
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

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
