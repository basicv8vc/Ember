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
import { asDomainError } from '../repositories/support.js';
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

const MARK_PUBLISHED_SQL = `
UPDATE staged_blobs
   SET state = 'published', settled_at = clock_timestamp()
 WHERE tenant_id = $1 AND storage_key = $2 AND state = 'pending'
`;

const STAGED_PENDING_SQL = `
SELECT storage_key
  FROM staged_blobs
 WHERE state = 'pending' AND created_at <= $1
`;

const STAGED_KEYS_SQL = `
SELECT storage_key
  FROM staged_blobs
 WHERE storage_key = ANY($1::text[])
`;

const INSTALLED_KEYS_SQL = `
SELECT storage_key
  FROM blobs
 WHERE storage_key = ANY($1::text[])
`;

const DELETE_STAGED_SQL = `
DELETE FROM staged_blobs
 WHERE state = 'pending' AND storage_key = ANY($1::text[])
`;

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

    // The staged row is only private bookkeeping; marking it published is not what makes
    // bytes readable. A failure here leaves an orphan staging row for the collector.
    await this.pool
      .query(MARK_PUBLISHED_SQL, [parseTenantId(tenantId), staged.storageKey])
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

  async verify(
    tenantId: Id,
    storageKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<boolean> {
    return this.files.verify(tenantId, storageKey, expectedSha256, expectedSize);
  }

  async discard(tenantId: Id, staged: StagedBlobRef): Promise<void> {
    await this.files.discard(tenantId, staged);
    await this.pool
      .query(
        `UPDATE staged_blobs
            SET state = 'abandoned', settled_at = clock_timestamp()
          WHERE tenant_id = $1 AND storage_key = $2 AND state = 'pending'`,
        [parseTenantId(tenantId), staged.storageKey],
      )
      .catch(() => undefined);
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

      const [pendingRows, stagedRows, installedRows] = await Promise.all([
        this.pool.query<{ storage_key: string }>(STAGED_PENDING_SQL, [cutoff]),
        this.pool.query<{ storage_key: string }>(STAGED_KEYS_SQL, [[...stagingKeys]]),
        this.pool.query<{ storage_key: string }>(INSTALLED_KEYS_SQL, [[...installedKeys]]),
      ]);

      const knownStaging = new Set(stagedRows.rows.map((row) => row.storage_key));
      const pendingStaging = new Set(pendingRows.rows.map((row) => row.storage_key));
      const knownInstalled = new Set(installedRows.rows.map((row) => row.storage_key));

      let removedStaged = 0;
      let removedBlobs = 0;
      let retained = 0;

      for (const key of stagingKeys) {
        const age = await this.files.ageMs(key, 'staging', now);

        if (age === null) {
          continue;
        }

        const orphan = !knownStaging.has(key);
        const quarantinedPending = pendingStaging.has(key);

        if ((!orphan && !quarantinedPending) || age < retentionMs) {
          retained += 1;
          continue;
        }

        if (!dryRun) {
          await this.files.removeKey(key, 'staging');

          if (quarantinedPending) {
            await this.pool.query(DELETE_STAGED_SQL, [[key]]);
          }
        }

        removedStaged += 1;
      }

      for (const key of installedKeys) {
        if (knownInstalled.has(key)) {
          // Published metadata exists; retention is decided by the artifact/workspace/
          // checkpoint references, not by this collector.
          retained += 1;
          continue;
        }

        const age = await this.files.ageMs(key, 'blobs', now);

        if (age === null || age < retentionMs) {
          retained += 1;
          continue;
        }

        if (!dryRun) {
          await this.files.removeKey(key, 'blobs');
        }

        removedBlobs += 1;
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
}
