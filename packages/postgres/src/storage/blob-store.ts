import type {
  BlobGcOptions,
  BlobGcReport,
  BlobSource,
  BlobStore,
  InstalledBlobRef,
  StagedBlobRef,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type pg from 'pg';
import { asDomainError, withTransaction } from '../repositories/support.js';
import { parseTenantId } from './local-blob-store.js';
import type { LocalBlobStore } from './local-blob-store.js';

/**
 * PostgreSQL-backed `BlobStore`: filesystem bytes plus the staged/blob metadata that decides
 * whether those bytes are part of a published result.
 *
 * Ordering rules that make the lifecycle auditable:
 * 1. bytes are written and hashed in the private staging area (never visible to a reader);
 * 2. a `staged_blobs` row records that attempt for the owning tenant/task/run;
 * 3. `install` re-verifies the staged bytes and links them under their content key;
 * 4. only a trusted transaction inserting `artifacts` makes bytes readable.
 *
 * A crash between 1 and 2 leaves a file with no row. A crash between 3 and 4 leaves an
 * installed file with no `blobs` row. Both are provably unreachable through the Artifact API
 * and are collected only after a non-zero quarantine window.
 */

const INSERT_STAGED_SQL = `
INSERT INTO staged_blobs (
  id, tenant_id, task_id, run_id, lease_epoch, sha256, size, media_type, storage_key, state
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
`;

const MARK_SETTLED_SQL = `
UPDATE staged_blobs
   SET state = $3, settled_at = clock_timestamp()
 WHERE tenant_id = $1 AND id = $2 AND state = 'pending'
`;

/** Every staging row that shares one physical key, with the state that protects it. */
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

/**
 * Cross-process coordination key for one tenant digest.
 *
 * Publishers take this lock for the whole publishing transaction and the collector takes it
 * before deciding to remove bytes, so "scanned as unreferenced" can never turn into
 * "deleted after a concurrent publish".
 */
export const BLOB_LOCK_NAMESPACE = 'ember.blob';

const ADVISORY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;

export interface PostgresBlobStoreOptions {
  /** Minimum quarantine before anything unreferenced may be collected (default 1 hour). */
  readonly gcQuarantineMs?: number;
  /** Extra staging ownership recorded for auditability. */
  readonly ownership?: {
    readonly taskId?: Id | null;
    readonly runId?: Id | null;
    readonly leaseEpoch?: number | null;
  };
}

export const DEFAULT_BLOB_GC_QUARANTINE_MS = 3_600_000;

export class PostgresBlobStore implements BlobStore {
  private readonly gcQuarantineMs: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly files: LocalBlobStore,
    private readonly options: PostgresBlobStoreOptions = {},
  ) {
    this.gcQuarantineMs = options.gcQuarantineMs ?? DEFAULT_BLOB_GC_QUARANTINE_MS;

    if (!Number.isSafeInteger(this.gcQuarantineMs) || this.gcQuarantineMs <= 0) {
      throw new DomainError('INVALID_ARGUMENT', 'blob gc quarantine must be a positive duration');
    }
  }

  /** Escape hatch for adapters and tests that need the raw filesystem primitives. */
  get local(): LocalBlobStore {
    return this.files;
  }

  async stage(
    tenantId: Id,
    source: BlobSource,
    mediaType: string,
    options: { readonly maxBytes?: number } = {},
  ): Promise<StagedBlobRef> {
    const tenant = parseTenantId(tenantId);
    const staged = await this.files.stage(tenant, source, mediaType, options);
    const ownership = this.options.ownership ?? {};

    try {
      await this.pool.query(INSERT_STAGED_SQL, [
        staged.stagedId,
        tenant,
        ownership.taskId ?? null,
        ownership.runId ?? null,
        ownership.leaseEpoch ?? null,
        staged.sha256,
        staged.size,
        staged.mediaType,
        staged.storageKey,
      ]);
    } catch (error) {
      // The bytes stay quarantined and unreferenced; the garbage collector is the only path
      // that may remove them. Never publish metadata for a write that was not recorded.
      throw asDomainError(error);
    }

    return staged;
  }

  async install(tenantId: Id, staged: StagedBlobRef): Promise<InstalledBlobRef> {
    const installed = await this.files.install(tenantId, staged);

    // Only this upload attempt is settled. Other attempts for the same digest keep their own
    // pending row, which is what makes repeated uploads of identical bytes safe.
    await this.pool
      .query(MARK_SETTLED_SQL, [parseTenantId(tenantId), staged.stagedId, 'published'])
      .catch(() => undefined);

    return Object.freeze({
      sha256: installed.sha256,
      size: installed.size,
      mediaType: staged.mediaType,
      storageKey: installed.storageKey,
    });
  }

  async read(tenantId: Id, storageKey: string): Promise<Uint8Array> {
    return this.files.read(tenantId, storageKey);
  }

  async verifyContent(tenantId: Id, sha256: string, size: number): Promise<boolean> {
    return this.files.verifyContent(tenantId, sha256, size);
  }

  async assertInstalled(tenantId: Id, sha256: string, size: number): Promise<boolean> {
    return this.files.assertInstalled(tenantId, sha256, size);
  }

  async verify(
    tenantId: Id,
    storageKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<boolean> {
    return this.files.verify(tenantId, storageKey, expectedSha256, expectedSize);
  }

  async discard(tenantId: Id, staged: StagedBlobRef): Promise<void> {
    await this.pool
      .query(MARK_SETTLED_SQL, [parseTenantId(tenantId), staged.stagedId, 'abandoned'])
      .catch(() => undefined);
    await this.files.discard(tenantId, staged);
  }

  /**
   * Reference-aware collection of provably unreferenced bytes.
   *
   * Only two classes are ever deleted:
   * - a staging file with no `staged_blobs` row, or a quarantined pending row that was never
   *   published (a crash before publication);
   * - an installed file with no `blobs` row (a crash between install and the publishing
   *   transaction).
   *
   * A `blobs` row that still exists is never collected here, even when no artifact currently
   * points at it: retention and historical-workspace policy are a separate, deliberate
   * decision. That is what keeps user artifacts, historical Workspace versions, checkpoint
   * references and pending-conflict candidates safe.
   */
  async sweepOrphans(now: Date, options: BlobGcOptions): Promise<BlobGcReport> {
    const retentionMs = options.retentionMs ?? this.gcQuarantineMs;

    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
      throw new DomainError('INVALID_ARGUMENT', 'blob gc retention must be a positive duration');
    }

    const cutoff = new Date(now.getTime() - retentionMs);
    const dryRun = options.dryRun ?? false;

    try {
      const [stagingKeys, installedKeys] = await Promise.all([
        this.files.listKeys('staging'),
        this.files.listKeys('blobs'),
      ]);

      let removedStaged = 0;
      let removedBlobs = 0;
      let retained = 0;

      for (const key of stagingKeys) {
        const age = await this.files.ageMs(key, 'staging', now);

        if (age === null) {
          continue;
        }

        if (age < retentionMs) {
          retained += 1;
          continue;
        }

        const collected = await this.collectStagingKey(key, cutoff, dryRun);

        if (collected) {
          removedStaged += 1;
        } else {
          retained += 1;
        }
      }

      for (const key of installedKeys) {
        const age = await this.files.ageMs(key, 'blobs', now);

        if (age === null || age < retentionMs) {
          retained += 1;
          continue;
        }

        const collected = await this.collectInstalledKey(key, dryRun);

        if (collected) {
          removedBlobs += 1;
        } else {
          retained += 1;
        }
      }

      return Object.freeze({
        scanned: stagingKeys.length + installedKeys.length,
        removedStaged,
        removedBlobs,
        retained,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Collect one staging file, or retain it.
   *
   * The decision is taken in a transaction that first takes the tenant-digest advisory lock
   * shared with every publisher, and then re-reads the staging rows. A row that is already
   * settled (published/abandoned) or younger than the quarantine protects the bytes, no
   * matter what the earlier directory scan observed.
   */
  private async collectStagingKey(key: string, cutoff: Date, dryRun: boolean): Promise<boolean> {
    const { tenantId, sha256 } = splitStorageKey(key);
    const collected = await withTransaction(this.pool, async (client) => {
      await client.query(ADVISORY_LOCK_SQL, [blobLockKey(tenantId, sha256)]);

      const rows = await client.query<{ id: string; state: string; created_at: Date | string }>(
        STAGED_ROWS_SQL,
        [tenantId, key],
      );
      const protectedRow = rows.rows.some(
        (row) => row.state !== 'pending' || toDate(row.created_at).getTime() > cutoff.getTime(),
      );

      if (protectedRow) {
        return false;
      }

      if (!dryRun) {
        await this.files.removeKey(key, 'staging');

        if (rows.rows.length > 0) {
          await client.query(DELETE_STAGED_BY_ID_SQL, [tenantId, rows.rows.map((row) => row.id)]);
        }
      }

      return true;
    });

    return collected;
  }

  /**
   * Collect one installed file that no database row references.
   *
   * Under the same advisery lock, a `blobs` row or any artifact row for the digest retains the
   * bytes. That is what keeps a publish that committed after the scan from losing its file.
   */
  private async collectInstalledKey(key: string, dryRun: boolean): Promise<boolean> {
    const { tenantId, sha256 } = splitStorageKey(key);

    return await withTransaction(this.pool, async (client) => {
      await client.query(ADVISORY_LOCK_SQL, [blobLockKey(tenantId, sha256)]);

      const blobRow = await client.query(BLOB_ROW_SQL, [tenantId, sha256]);

      if ((blobRow.rowCount ?? 0) > 0) {
        return false;
      }

      const referenced = await client.query(ARTIFACT_REFERENCE_SQL, [tenantId, sha256]);

      if ((referenced.rowCount ?? 0) > 0) {
        return false;
      }

      if (!dryRun) {
        await this.files.removeKey(key, 'blobs');
      }

      return true;
    });
  }
}

/** Advisory-lock key for one tenant digest; publishers and the collector must agree. */
export function blobLockKey(tenantId: Id, sha256: string): string {
  return `${BLOB_LOCK_NAMESPACE}:${parseTenantId(tenantId)}:${sha256}`;
}

/**
 * Take the tenant-digest advisory lock inside the caller's transaction.
 *
 * A publishing transaction holds it until COMMIT, so the collector either observes the
 * publisher's committed rows or waits for them.
 */
export async function lockBlobDigests(
  client: pg.PoolClient,
  tenantId: Id,
  sha256Values: readonly string[],
): Promise<void> {
  for (const sha256 of [...new Set(sha256Values)].sort()) {
    await client.query(ADVISORY_LOCK_SQL, [blobLockKey(tenantId, sha256)]);
  }
}

function splitStorageKey(key: string): { tenantId: string; sha256: string } {
  const [, tenantId, sha256] = key.split('/');

  if (tenantId === undefined || sha256 === undefined) {
    throw new DomainError('INVALID_ARGUMENT', 'storage key is not well formed');
  }

  return { tenantId, sha256 };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
