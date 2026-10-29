import { randomUUID } from 'node:crypto';
import { AuthContextSchema, IdSchema, toInvalidArgumentError } from '@ember/contracts';
import type { ArtifactLookup, ArtifactMetadata, ArtifactRef, BlobStore } from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import type pg from 'pg';
import { asDomainError, toIsoTimestamp, withTransaction } from '../repositories/support.js';
import { parseMediaType, parseTenantId } from './local-blob-store.js';

/**
 * Tenant-scoped artifact API (user path) and internal lookup (Run path).
 *
 * `put` is the only way a verified user upload becomes readable: it writes bytes to private
 * staging, re-verifies them, installs them under their digest and only then commits the
 * `blobs` + `artifacts` rows together. A database failure leaves no visible Artifact.
 */

interface ArtifactRow {
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
  storage_key: string;
}

const SELECT_ARTIFACT_SQL = `
SELECT a.id, a.tenant_id, a.task_id, a.run_id, a.created_by, a.sha256, a.size,
       a.media_type, a.retention, a.created_at, b.storage_key
  FROM artifacts a
  JOIN blobs b ON b.tenant_id = a.tenant_id AND b.sha256 = a.sha256
 WHERE a.tenant_id = $1 AND a.id = $2
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

function toMetadata(row: ArtifactRow): ArtifactMetadata {
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
    const lookup = await this.find(ctx, artifactId);

    if (lookup === null) {
      throw new DomainError('NOT_FOUND', 'artifact is not available in this tenant');
    }

    const bytes = await this.blobs.read(ctx.tenantId, lookup.storageKey);
    const intact = await this.blobs.verify(
      ctx.tenantId,
      lookup.storageKey,
      lookup.metadata.sha256,
      lookup.metadata.size,
    );

    if (!intact) {
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

  async delete(ctx: AuthContext, artifactId: Id): Promise<void> {
    const context = parseContext(ctx);
    const id = parseId(artifactId, 'artifactId');

    try {
      const result = await this.pool.query(DELETE_ARTIFACT_SQL, [context.tenantId, id]);

      if (result.rowCount !== 1) {
        throw new DomainError('NOT_FOUND', 'artifact is not available in this tenant');
      }
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
}
