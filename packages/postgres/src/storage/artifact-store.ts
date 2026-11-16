import { createHash, randomUUID } from 'node:crypto';
import {
  AuthContextSchema,
  IdSchema,
  MAX_BLOB_BYTES,
  toInvalidArgumentError,
} from '@ember/contracts';
import type { ArtifactLookup, ArtifactMetadata, ArtifactRef, BlobStore } from '@ember/contracts';
import { DomainError, isDomainError, type AuthContext, type Id } from '@ember/domain';
import type pg from 'pg';
import { asDomainError, toIsoTimestamp, withTransaction } from '../repositories/support.js';
import { lockBlobDigests } from './blob-store.js';
import { parseMediaType, parseTenantId } from './validation.js';

/**
 * Tenant-scoped artifact API (user path) and internal lookup (Run path).
 *
 * `put` is the only way a verified user upload becomes readable: it writes bytes to private
 * staging, re-verifies them, installs them under their digest and only then commits the
 * `blobs` + `artifacts` rows together. A database failure leaves no visible Artifact.
 */

interface ArtifactMetadataRow {
  id: string;
  tenant_id: string;
  task_id: string | null;
  run_id: string | null;
  created_by: string;
  sha256: string;
  size: string | number;
  media_type: string;
  retention: string;
  created_at: Date | string;
}

interface ArtifactRow extends ArtifactMetadataRow {
  storage_key: string;
}

const SELECT_ARTIFACT_SQL = `
SELECT a.id, a.tenant_id, a.task_id, a.run_id, a.created_by, a.sha256, a.size,
       a.media_type, a.retention, a.created_at, b.storage_key
  FROM artifacts a
  JOIN blobs b ON b.tenant_id = a.tenant_id AND b.sha256 = a.sha256
 WHERE a.tenant_id = $1 AND a.id = $2
`;

const LIST_TASK_ARTIFACTS_SQL = `
SELECT a.id, a.tenant_id, a.task_id, a.run_id, a.created_by, a.sha256, a.size,
       a.media_type, a.retention, a.created_at
  FROM artifacts a
  JOIN blobs b ON b.tenant_id = a.tenant_id AND b.sha256 = a.sha256
 WHERE a.tenant_id = $1 AND a.task_id = $2
 ORDER BY a.created_at ASC, a.id ASC
`;

const INSERT_BLOB_SQL = `
INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (tenant_id, sha256) DO NOTHING
`;

const INSERT_ARTIFACT_SQL = `
INSERT INTO artifacts (
  id, tenant_id, task_id, run_id, created_by, sha256, size, media_type, retention
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;

const DELETE_ARTIFACT_SQL = `
DELETE FROM artifacts
 WHERE tenant_id = $1 AND id = $2
`;

const LOCK_ARTIFACT_SQL = `
SELECT sha256
  FROM artifacts
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

/**
 * Reference guard for deletion.
 *
 * Historical Workspace versions, committed checkpoints and pending conflict candidates all
 * keep their Artifact references; removing the metadata underneath them would create dangling
 * references, so a referenced Artifact cannot be deleted in this phase.
 */
const ARTIFACT_REFERENCES_SQL = `
SELECT
  EXISTS (
    SELECT 1
      FROM workspace_versions v
      JOIN workspaces w ON w.tenant_id = v.tenant_id AND w.id = v.workspace_id
     WHERE v.tenant_id = $1 AND w.tenant_id = $1
       AND v.manifest -> 'files' @> jsonb_build_array(jsonb_build_object('artifactId', $2::text))
  ) AS in_workspace_version,
  EXISTS (
    SELECT 1
      FROM step_checkpoints c
     WHERE c.tenant_id = $1
       AND c.artifacts @> jsonb_build_array(jsonb_build_object('artifactId', $2::text))
  ) AS in_checkpoint,
  EXISTS (
    SELECT 1
      FROM workspace_conflicts k
     WHERE k.tenant_id = $1
       AND k.candidate_manifest -> 'files'
           @> jsonb_build_array(jsonb_build_object('artifactId', $2::text))
  ) AS in_conflict
`;

function parseContext(ctx: AuthContext): AuthContext {
  const parsed = AuthContextSchema.safeParse(ctx);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function parseId(value: Id, field: string): Id {
  const parsed = IdSchema.safeParse(value);

  if (!parsed.success) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a UUID`);
  }

  return parsed.data;
}

function toMetadata(row: ArtifactMetadataRow): ArtifactMetadata {
  return Object.freeze({
    artifactId: row.id,
    sha256: row.sha256,
    size: Number(row.size),
    mediaType: row.media_type,
    createdBy: row.created_by === 'user' ? ('user' as const) : ('run' as const),
    retention: row.retention === 'user' ? ('user' as const) : ('task' as const),
    taskId: row.task_id,
    runId: row.run_id,
    createdAt: toIsoTimestamp(row.created_at),
  });
}

/** User-facing Artifact API plus tenant-scoped internal lookups. */
export class PostgresArtifactStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly blobs: BlobStore,
  ) {}

  async put(ctx: AuthContext, data: Uint8Array, mediaType: string): Promise<ArtifactRef> {
    const context = parseContext(ctx);
    const type = parseMediaType(mediaType);
    const staged = await this.blobs.stage(context.tenantId, data, type);
    const installed = await this.blobs.install(context.tenantId, staged);

    try {
      return await withTransaction(this.pool, async (client) => {
        // Same tenant-digest lock the collector takes, so these bytes cannot be swept between
        // install and COMMIT.
        await lockBlobDigests(client, context.tenantId, [installed.sha256]);

        // The advisory lock only orders this publish against a *future* sweep: the collector
        // may already have held it and deleted these bytes while this call was between
        // `install` and here (an installed file has no `blobs` row yet, so nothing protected
        // it). Re-asserting presence under the lock makes the two outcomes exclusive — either
        // the bytes are still on disk and this publish commits, or they are gone and nothing
        // is written at all.
        const present = await this.blobs.assertInstalled(
          context.tenantId,
          installed.sha256,
          installed.size,
        );

        if (!present) {
          throw new DomainError('DB_UNAVAILABLE', 'installed bytes disappeared before publication');
        }

        await client.query(INSERT_BLOB_SQL, [
          context.tenantId,
          installed.sha256,
          installed.size,
          installed.mediaType,
          installed.storageKey,
        ]);

        const artifactId = randomUUID();
        await client.query(INSERT_ARTIFACT_SQL, [
          artifactId,
          context.tenantId,
          null,
          null,
          'user',
          installed.sha256,
          installed.size,
          installed.mediaType,
          'user',
        ]);

        return Object.freeze({
          artifactId,
          sha256: installed.sha256,
          size: installed.size,
          mediaType: installed.mediaType,
        });
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async get(ctx: AuthContext, artifactId: Id): Promise<Uint8Array> {
    const context = parseContext(ctx);
    const lookup = await this.find(context, artifactId);

    if (lookup === null) {
      throw new DomainError('NOT_FOUND', 'artifact is not available in this tenant');
    }

    if (
      !Number.isSafeInteger(lookup.metadata.size) ||
      lookup.metadata.size < 0 ||
      lookup.metadata.size > MAX_BLOB_BYTES
    ) {
      throw new DomainError('DB_UNAVAILABLE', 'artifact size is outside the supported limit');
    }

    try {
      // Hash and size are checked before allocating the response buffer. This keeps reads
      // within the same hard limit as writes, even if persisted metadata was corrupted.
      const valid = await this.blobs.verify(
        context.tenantId,
        lookup.storageKey,
        lookup.metadata.sha256,
        lookup.metadata.size,
      );

      if (!valid) {
        throw new DomainError('DB_UNAVAILABLE', 'artifact bytes failed integrity verification');
      }
    } catch (error) {
      if (isDomainError(error) && error.code === 'NOT_FOUND') {
        throw new DomainError('DB_UNAVAILABLE', 'artifact bytes are missing');
      }

      throw error;
    }

    let bytes: Uint8Array;

    try {
      bytes = await this.blobs.read(context.tenantId, lookup.storageKey);
    } catch (error) {
      if (isDomainError(error) && error.code === 'NOT_FOUND') {
        throw new DomainError('DB_UNAVAILABLE', 'artifact bytes are missing');
      }

      throw error;
    }

    // Verify the *same* buffer that is returned. A second read could observe different bytes
    // on disk than the ones handed to the caller.
    const digest = createHash('sha256').update(bytes).digest('hex');

    if (digest !== lookup.metadata.sha256 || bytes.byteLength !== lookup.metadata.size) {
      // Never hand a client bytes whose digest no longer matches the published metadata.
      throw new DomainError('DB_UNAVAILABLE', 'artifact bytes failed integrity verification');
    }

    return bytes;
  }

  async verify(
    ctx: AuthContext,
    artifactId: Id,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<boolean> {
    const lookup = await this.find(ctx, artifactId);

    if (lookup === null) {
      throw new DomainError('NOT_FOUND', 'artifact is not available in this tenant');
    }

    return this.blobs.verify(ctx.tenantId, lookup.storageKey, expectedSha256, expectedSize);
  }

  /**
   * Remove a tenant-owned Artifact, unless a durable reference still needs it.
   *
   * Full retention policy is a later phase, but deletion must never produce a dangling
   * reference from a Workspace version, a committed checkpoint or a pending conflict.
   *
   * This is the second half of the shared row-lock protocol in `artifact-references.ts`: the
   * Artifact row is locked `FOR UPDATE` *before* references are evaluated, and every writer
   * that persists a reference holds `FOR SHARE` on that same row until it commits. A writer
   * therefore either commits first (and this check sees its reference) or waits here and finds
   * the Artifact gone. Without the lock the check would be a plain `SELECT` and a concurrent
   * checkpoint/version/conflict could be written into the window between check and delete.
   */
  async delete(ctx: AuthContext, artifactId: Id): Promise<void> {
    const context = parseContext(ctx);
    const id = parseId(artifactId, 'artifactId');

    try {
      await withTransaction(this.pool, async (client) => {
        // Rendezvous point with every reference writer. Held until COMMIT, so no reference row
        // can become visible between this read and the DELETE below.
        const locked = await client.query<{ sha256: string }>(LOCK_ARTIFACT_SQL, [
          context.tenantId,
          id,
        ]);

        if (locked.rows[0] === undefined) {
          throw new DomainError('NOT_FOUND', 'artifact is not available in this tenant');
        }

        const references = await client.query<{
          in_workspace_version: boolean;
          in_checkpoint: boolean;
          in_conflict: boolean;
        }>(ARTIFACT_REFERENCES_SQL, [context.tenantId, id]);
        const row = references.rows[0];

        if (
          row !== undefined &&
          (row.in_workspace_version || row.in_checkpoint || row.in_conflict)
        ) {
          throw new DomainError(
            'POLICY_DENIED',
            'artifact is still referenced by a workspace version, checkpoint or conflict',
          );
        }

        const deleted = await client.query(DELETE_ARTIFACT_SQL, [context.tenantId, id]);

        if (deleted.rowCount !== 1) {
          throw new DomainError('NOT_FOUND', 'artifact is not available in this tenant');
        }
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async find(ctx: AuthContext, artifactId: Id): Promise<ArtifactLookup | null> {
    const context = parseContext(ctx);
    return this.findInTenant(context.tenantId, artifactId);
  }

  async findInTenant(tenantId: Id, artifactId: Id): Promise<ArtifactLookup | null> {
    const tenant = parseTenantId(tenantId);
    const id = parseId(artifactId, 'artifactId');

    try {
      const result = await this.pool.query<ArtifactRow>(SELECT_ARTIFACT_SQL, [tenant, id]);
      const row = result.rows[0];

      return row === undefined
        ? null
        : Object.freeze({ metadata: toMetadata(row), storageKey: row.storage_key });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** List only published Artifact metadata for one Task in the caller's tenant. */
  async listForTask(ctx: AuthContext, taskId: Id): Promise<readonly ArtifactMetadata[]> {
    const context = parseContext(ctx);
    const id = parseId(taskId, 'taskId');

    try {
      const result = await this.pool.query<ArtifactMetadataRow>(LIST_TASK_ARTIFACTS_SQL, [
        context.tenantId,
        id,
      ]);

      return Object.freeze(result.rows.map(toMetadata));
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
