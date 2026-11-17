import {
  ArtifactFilenameSchema,
  AuthContextSchema,
  B3StagedUploadMediaTypeSchema,
  B3StagedUploadReceiptDtoSchema,
  B3TaskArtifactsListDtoSchema,
  IdSchema,
  PYTHON_AGENT_LIMITS,
  toInvalidArgumentError,
  type B3StagedUploadReceiptDto,
  type B3TaskArtifactsListDto,
} from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import { decodePgBytea, sha256Hex } from '../storage/bytea-blob-store.js';
import {
  deleteR2Keys,
  putR2Bytes,
  readR2Bytes,
  uploadKeyFor,
  type R2BucketPort,
} from '../storage/r2-blob-store.js';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

const UPLOAD_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;

const COUNT_UNBOUND_UPLOADS_SQL = `
SELECT count(*)::int AS active_count
  FROM user_staged_uploads
 WHERE tenant_id = $1::uuid
   AND principal_id = $2::uuid
   AND status = 'unbound'
   AND expires_at > $3::timestamptz
`;

const INSERT_STAGED_UPLOAD_SQL = `
INSERT INTO user_staged_uploads (
  id,
  tenant_id,
  principal_id,
  filename,
  media_type,
  sha256,
  size,
  storage_backend,
  storage_key,
  bytes,
  status,
  expires_at,
  created_at
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, 'unbound', $11::timestamptz, $12::timestamptz)
RETURNING id, filename, media_type, size, sha256, expires_at, created_at
`;

const TASK_EXISTS_SQL = `
SELECT 1
  FROM tasks
 WHERE tenant_id = $1::uuid AND id = $2::uuid
`;

const LIST_TASK_ARTIFACTS_SQL = `
SELECT a.id AS artifact_id,
       a.filename,
       a.media_type,
       a.size,
       a.sha256,
       a.created_by,
       a.created_at
  FROM artifacts a
  JOIN blobs b
    ON b.tenant_id = a.tenant_id AND b.sha256 = a.sha256
 WHERE a.tenant_id = $1::uuid
   AND a.task_id = $2::uuid
 ORDER BY a.created_at ASC, a.id ASC
`;

const GET_ARTIFACT_DOWNLOAD_SQL = `
SELECT a.id AS artifact_id,
       a.filename,
       a.media_type,
       a.size,
       a.sha256,
       bb.storage_backend,
       bb.storage_key,
       bb.bytes
  FROM artifacts a
  JOIN blobs b
    ON b.tenant_id = a.tenant_id AND b.sha256 = a.sha256
  JOIN bytea_blobs bb
    ON bb.tenant_id = b.tenant_id AND bb.storage_key = b.storage_key
 WHERE a.tenant_id = $1::uuid
   AND a.id = $2::uuid
`;

const SWEEP_EXPIRED_UPLOADS_SQL = `
DELETE FROM user_staged_uploads
 WHERE status = 'unbound'
   AND expires_at <= COALESCE($1::timestamptz, clock_timestamp())
 RETURNING storage_backend, storage_key
`;

const stageUploadInputSchema = z.strictObject({
  filename: ArtifactFilenameSchema,
  mediaType: B3StagedUploadMediaTypeSchema,
  bytes: z.instanceof(Uint8Array),
  now: z.date().optional(),
});

export interface StageUploadInput {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly now?: Date;
}

export interface B3ArtifactDownload {
  readonly artifactId: Id;
  readonly filename: string | null;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface B3StagedUploadRepository {
  stageUpload(ctx: AuthContext, input: StageUploadInput): Promise<B3StagedUploadReceiptDto>;
  listTaskArtifacts(ctx: AuthContext, taskId: Id): Promise<B3TaskArtifactsListDto | null>;
  getTaskArtifactDownload(ctx: AuthContext, artifactId: Id): Promise<B3ArtifactDownload | null>;
  sweepExpiredUnboundUploads(now?: Date): Promise<{ readonly removed: number }>;
}

export interface PostgresB3StagedUploadRepositoryOptions {
  readonly r2Bucket?: R2BucketPort;
}

/**
 * Edge-safe PostgreSQL repository for pre-delegation tenant-private staged uploads and
 * session-authenticated Task artifact downloads (R2 or `bytea_blobs`-backed).
 */
export class PostgresB3StagedUploadRepository implements B3StagedUploadRepository {
  private readonly r2Bucket: R2BucketPort | undefined;

  constructor(
    private readonly pool: pg.Pool,
    options: PostgresB3StagedUploadRepositoryOptions = {},
  ) {
    this.r2Bucket = options.r2Bucket;
  }

  async stageUpload(ctx: AuthContext, input: StageUploadInput): Promise<B3StagedUploadReceiptDto> {
    const authResult = AuthContextSchema.safeParse(ctx);
    if (!authResult.success) {
      throw toInvalidArgumentError(authResult.error);
    }
    const auth = authResult.data;

    const inputResult = stageUploadInputSchema.safeParse(input);
    if (!inputResult.success) {
      throw toInvalidArgumentError(inputResult.error);
    }
    const parsed = inputResult.data;

    if (parsed.bytes.byteLength > PYTHON_AGENT_LIMITS.maxFileBytes) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `uploaded file exceeds ${PYTHON_AGENT_LIMITS.maxFileBytes} byte limit`,
      );
    }

    const bytes = new Uint8Array(
      parsed.bytes.buffer,
      parsed.bytes.byteOffset,
      parsed.bytes.byteLength,
    );
    const sha256 = await sha256Hex(bytes);
    const uploadId = globalThis.crypto.randomUUID();
    const lockKey = `ember.upload:${auth.tenantId}:${auth.principalId}`;
    const r2Key = this.r2Bucket === undefined ? null : uploadKeyFor(auth.tenantId, uploadId);

    if (this.r2Bucket !== undefined && r2Key !== null) {
      await putR2Bytes(this.r2Bucket, r2Key, bytes, {
        httpMetadata: { contentType: parsed.mediaType },
        customMetadata: {
          tenantId: auth.tenantId,
          uploadId,
          sha256,
        },
      });
    }

    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query(UPLOAD_LOCK_SQL, [lockKey]);

        const createdAt =
          parsed.now ??
          new Date(
            (await client.query<{ now: Date | string }>('SELECT clock_timestamp() AS now')).rows[0]!
              .now,
          );
        const expiresAt = new Date(createdAt.getTime() + PYTHON_AGENT_LIMITS.maxUploadTtlMs);

        const countResult = await client.query<{ active_count: number }>(
          COUNT_UNBOUND_UPLOADS_SQL,
          [auth.tenantId, auth.principalId, createdAt],
        );

        const activeCount = Number(countResult.rows[0]?.active_count ?? 0);
        if (activeCount >= PYTHON_AGENT_LIMITS.maxUnboundUploadsPerUser) {
          throw new DomainError(
            'BUDGET_EXCEEDED',
            'unbound staged upload quota reached for principal',
          );
        }

        const inserted = await client.query<{
          id: string;
          filename: string;
          media_type: string;
          size: string | number;
          sha256: string;
          expires_at: Date | string;
          created_at: Date | string;
        }>(INSERT_STAGED_UPLOAD_SQL, [
          uploadId,
          auth.tenantId,
          auth.principalId,
          parsed.filename,
          parsed.mediaType,
          sha256,
          bytes.byteLength,
          r2Key === null ? 'postgres' : 'r2',
          r2Key,
          r2Key === null ? bytes : null,
          expiresAt,
          createdAt,
        ]);

        const row = inserted.rows[0]!;
        return B3StagedUploadReceiptDtoSchema.parse({
          upload_id: row.id,
          filename: row.filename,
          media_type: row.media_type,
          size: Number(row.size),
          sha256: row.sha256,
          expires_at: toIsoTimestamp(row.expires_at),
          created_at: toIsoTimestamp(row.created_at),
        });
      });
    } catch (error) {
      if (r2Key !== null) {
        await deleteR2Keys(this.r2Bucket, [r2Key]);
      }
      throw asDomainError(error);
    }
  }

  async listTaskArtifacts(ctx: AuthContext, taskId: Id): Promise<B3TaskArtifactsListDto | null> {
    const authResult = AuthContextSchema.safeParse(ctx);
    if (!authResult.success) {
      throw toInvalidArgumentError(authResult.error);
    }
    const idResult = IdSchema.safeParse(taskId);
    if (!idResult.success) {
      throw toInvalidArgumentError(idResult.error);
    }

    const tenantId = authResult.data.tenantId;
    const targetTaskId = idResult.data;

    try {
      const taskExists = await this.pool.query(TASK_EXISTS_SQL, [tenantId, targetTaskId]);
      if ((taskExists.rowCount ?? 0) === 0) {
        return null;
      }

      const result = await this.pool.query<{
        artifact_id: string;
        filename: string | null;
        media_type: string;
        size: string | number;
        sha256: string;
        created_by: 'user' | 'run';
        created_at: Date | string;
      }>(LIST_TASK_ARTIFACTS_SQL, [tenantId, targetTaskId]);

      return B3TaskArtifactsListDtoSchema.parse({
        task_id: targetTaskId,
        artifacts: result.rows.map((row) => ({
          artifact_id: row.artifact_id,
          filename: row.filename,
          media_type: row.media_type,
          size: Number(row.size),
          sha256: row.sha256,
          created_by: row.created_by,
          created_at: toIsoTimestamp(row.created_at),
        })),
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async getTaskArtifactDownload(
    ctx: AuthContext,
    artifactId: Id,
  ): Promise<B3ArtifactDownload | null> {
    const authResult = AuthContextSchema.safeParse(ctx);
    if (!authResult.success) {
      throw toInvalidArgumentError(authResult.error);
    }
    const idResult = IdSchema.safeParse(artifactId);
    if (!idResult.success) {
      throw toInvalidArgumentError(idResult.error);
    }

    try {
      const result = await this.pool.query<{
        artifact_id: string;
        filename: string | null;
        media_type: string;
        size: string | number;
        sha256: string;
        storage_backend: 'postgres' | 'r2';
        storage_key: string;
        bytes: unknown;
      }>(GET_ARTIFACT_DOWNLOAD_SQL, [authResult.data.tenantId, idResult.data]);

      if ((result.rowCount ?? 0) === 0) {
        return null;
      }

      const row = result.rows[0]!;
      const expectedSize = Number(row.size);
      let bytes: Uint8Array;
      if (row.storage_backend === 'r2') {
        if (this.r2Bucket === undefined) {
          throw new DomainError(
            'DB_UNAVAILABLE',
            'r2 bucket binding missing for r2-backed artifact',
          );
        }
        bytes = await readR2Bytes(this.r2Bucket, row.storage_key, {
          size: expectedSize,
          sha256: row.sha256,
        });
      } else {
        bytes = decodePgBytea(row.bytes);
        if (bytes.byteLength !== expectedSize) {
          throw new DomainError('DB_UNAVAILABLE', 'artifact byte length mismatch');
        }
        const actualDigest = await sha256Hex(bytes);
        if (actualDigest !== row.sha256) {
          throw new DomainError('DB_UNAVAILABLE', 'artifact sha256 integrity verification failed');
        }
      }

      return Object.freeze({
        artifactId: row.artifact_id,
        filename: row.filename,
        mediaType: row.media_type,
        size: expectedSize,
        sha256: row.sha256,
        bytes,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async sweepExpiredUnboundUploads(now?: Date): Promise<{ readonly removed: number }> {
    try {
      const result = await this.pool.query<{
        storage_backend: 'postgres' | 'r2';
        storage_key: string | null;
      }>(SWEEP_EXPIRED_UPLOADS_SQL, [now ?? null]);
      const r2Keys = result.rows
        .filter((row) => row.storage_backend === 'r2' && row.storage_key !== null)
        .map((row) => row.storage_key!);
      if (r2Keys.length > 0) {
        await deleteR2Keys(this.r2Bucket, r2Keys);
      }
      return Object.freeze({ removed: result.rowCount ?? 0 });
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
