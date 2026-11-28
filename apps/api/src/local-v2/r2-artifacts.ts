import type { B3StagedUploadReceiptDto, R2BucketPort } from '@ember/contracts';
import { DomainError, isDomainError, type DomainErrorCode } from '@ember/domain';
import {
  V2_MAX_INLINE_ARTIFACT_BYTES,
  v2ArtifactR2Key,
  v2UploadR2Key,
  type V2CheckArtifactsCommittedDto,
  type V2PublishTaskOutputsResultDto,
  type V2TaskOutputFileInput,
} from '@ember/runtime-v2';

/**
 * Domain error codes guaranteed to abort before SQLite `INSERT` commits in `AgentHeadTaskArtifactService`.
 * Any other thrown error (including `DB_UNAVAILABLE` or dropped DO RPC transport) is ambiguous and
 * must be reconciled against DO state before deleting staged R2 objects.
 */
const DEFINITE_NON_COMMIT_DOMAIN_CODES: ReadonlySet<DomainErrorCode> = new Set([
  'INVALID_ARGUMENT',
  'BUDGET_EXCEEDED',
  'POLICY_DENIED',
  'STALE_LEASE',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
]);

export function isDefiniteNonCommitRejection(error: unknown): boolean {
  return isDomainError(error) && DEFINITE_NON_COMMIT_DOMAIN_CODES.has(error.code);
}

/** Edge-safe lowercase hex SHA-256 digest via Web Crypto. */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return globalThis.btoa(parts.join(''));
}

export function decodeBytesBase64(encoded: string): Uint8Array {
  const binary = globalThis.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function putV2R2Bytes(
  bucket: R2BucketPort,
  key: string,
  bytes: Uint8Array,
  mediaType: string,
  customMetadata?: Readonly<Record<string, string>>,
): Promise<void> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  await bucket.put(key, copy, {
    httpMetadata: { contentType: mediaType },
    ...(customMetadata === undefined ? {} : { customMetadata }),
  });
}

export async function readAndVerifyV2R2Bytes(
  bucket: R2BucketPort | undefined,
  key: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<Uint8Array> {
  if (bucket === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'r2 bucket binding missing for r2-backed artifact');
  }
  const obj = await bucket.get(key);
  if (obj === null) {
    throw new DomainError('DB_UNAVAILABLE', 'r2 artifact object missing');
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const actualSha = await sha256HexBytes(bytes);
  if (bytes.byteLength !== expectedSize || actualSha !== expectedSha256) {
    throw new DomainError('DB_UNAVAILABLE', 'r2 artifact integrity check failed');
  }
  return bytes;
}

export async function deleteV2R2KeysBestEffort(
  bucket: R2BucketPort | undefined,
  keys: readonly string[],
): Promise<void> {
  if (bucket === undefined || keys.length === 0) return;
  try {
    await bucket.delete([...keys]);
  } catch {
    // Cleanup is best-effort; committed metadata was never written or was already deleted.
  }
}

/**
 * Delete durably queued R2 keys and fail closed when `keys.length > 0` without an R2 binding
 * so `v2_r2_pending_deletes` keeps the records for retry after configuration recovery.
 */
export async function deleteV2R2KeysStrict(
  bucket: R2BucketPort | undefined,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  if (bucket === undefined) {
    throw new DomainError(
      'DB_UNAVAILABLE',
      'EMBER_BLOBS R2 bucket binding is missing for pending R2 deletion',
    );
  }
  await bucket.delete([...keys]);
}

/**
 * Reconcile staged R2 objects after a DO RPC error.
 * Deletes immediately on definite pre-commit rejections, verifies absence via `checkCommitted`
 * on ambiguous RPC errors, and retains objects if reconciliation itself is uncertain.
 */
export async function reconcileAndCleanupStagedR2OnRpcError(params: {
  readonly bucket: R2BucketPort | undefined;
  readonly staged: readonly { readonly id: string; readonly r2Key: string }[];
  readonly error: unknown;
  readonly checkCommitted: (ids: readonly string[]) => Promise<V2CheckArtifactsCommittedDto>;
}): Promise<void> {
  const { bucket, staged, error, checkCommitted } = params;
  if (bucket === undefined || staged.length === 0) return;

  if (isDefiniteNonCommitRejection(error)) {
    await deleteV2R2KeysBestEffort(
      bucket,
      staged.map((item) => item.r2Key),
    );
    return;
  }

  try {
    const check = await checkCommitted(staged.map((item) => item.id));
    const committedIds = new Set(check.existingIds.map((id) => id.toLowerCase()));
    const unreferencedKeys = staged
      .filter((item) => !committedIds.has(item.id.toLowerCase()))
      .map((item) => item.r2Key);
    await deleteV2R2KeysBestEffort(bucket, unreferencedKeys);
  } catch {
    // Retain R2 objects on ambiguous reconciliation so live DO metadata never points to missing blobs.
  }
}

export async function resolveV2StoredFileBytes(
  file: {
    readonly size: number;
    readonly sha256: string;
    readonly r2Key?: string;
    readonly contentBase64?: string;
  },
  bucket: R2BucketPort | undefined,
): Promise<Uint8Array> {
  if (file.r2Key !== undefined) {
    return readAndVerifyV2R2Bytes(bucket, file.r2Key, file.size, file.sha256);
  }
  if (file.contentBase64 === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'artifact payload missing');
  }
  return decodeBytesBase64(file.contentBase64);
}

/**
 * Stage a user upload into R2 (when bound) and register metadata in `AgentHeadDO` with
 * reconciliation-safe cleanup on RPC failures.
 */
export async function stageV2UploadWithR2(params: {
  readonly bucket: R2BucketPort;
  readonly tenantId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly registerInDo: (cmd: {
    readonly uploadId: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly r2Key: string;
  }) => Promise<B3StagedUploadReceiptDto>;
  readonly checkCommitted: (ids: readonly string[]) => Promise<V2CheckArtifactsCommittedDto>;
}): Promise<B3StagedUploadReceiptDto> {
  const { bucket, tenantId, filename, mediaType, bytes, registerInDo, checkCommitted } = params;
  const uploadId = globalThis.crypto.randomUUID();
  const sha256 = await sha256HexBytes(bytes);
  const r2Key = v2UploadR2Key(tenantId, uploadId);
  await putV2R2Bytes(bucket, r2Key, bytes, mediaType, {
    tenantId,
    uploadId,
    sha256,
  });

  try {
    return await registerInDo({
      uploadId,
      filename,
      mediaType,
      sizeBytes: bytes.byteLength,
      sha256,
      r2Key,
    });
  } catch (error) {
    await reconcileAndCleanupStagedR2OnRpcError({
      bucket,
      staged: [{ id: uploadId, r2Key }],
      error,
      checkCommitted,
    });
    throw error;
  }
}

/**
 * Prepare V2 task output artifacts for `publish_task_outputs`.
 * Writes bytes to R2 outside DO transactions when `bucket` is bound; falls back to bounded
 * inline base64 when no R2 bucket is configured (unit tests).
 */
export async function stageV2OutputFilesForPublish(params: {
  readonly bucket: R2BucketPort | undefined;
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly files: readonly {
    readonly filename: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }[];
}): Promise<{
  readonly outputs: readonly V2TaskOutputFileInput[];
  readonly staged: readonly { readonly id: string; readonly r2Key: string }[];
}> {
  const { bucket, tenantId, taskId, runId, files } = params;
  if (bucket === undefined) {
    for (const file of files) {
      if (file.bytes.byteLength > V2_MAX_INLINE_ARTIFACT_BYTES) {
        throw new DomainError('POLICY_DENIED', 'output artifact exceeds V2 inline limit');
      }
    }
    return {
      outputs: files.map((file) => ({
        filename: file.filename,
        mediaType: file.mediaType,
        contentBase64: encodeBytesBase64(file.bytes),
      })),
      staged: [],
    };
  }

  const outputs: V2TaskOutputFileInput[] = [];
  const staged: Array<{ readonly id: string; readonly r2Key: string }> = [];
  try {
    for (const file of files) {
      const artifactId = globalThis.crypto.randomUUID();
      const sha256 = await sha256HexBytes(file.bytes);
      const r2Key = v2ArtifactR2Key(tenantId, taskId, runId, artifactId);
      await putV2R2Bytes(bucket, r2Key, file.bytes, file.mediaType, {
        tenantId,
        taskId,
        runId,
        artifactId,
        sha256,
      });
      staged.push({ id: artifactId, r2Key });
      outputs.push({
        artifactId,
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: file.bytes.byteLength,
        sha256,
        r2Key,
      });
    }
    return { outputs, staged };
  } catch (error) {
    await deleteV2R2KeysBestEffort(
      bucket,
      staged.map((item) => item.r2Key),
    );
    throw error;
  }
}

export async function publishV2OutputsWithR2Reconciliation(params: {
  readonly bucket: R2BucketPort | undefined;
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly files: readonly {
    readonly filename: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }[];
  readonly publishInDo: (
    outputs: readonly V2TaskOutputFileInput[],
  ) => Promise<V2PublishTaskOutputsResultDto>;
  readonly checkCommitted: (ids: readonly string[]) => Promise<V2CheckArtifactsCommittedDto>;
}): Promise<V2PublishTaskOutputsResultDto> {
  const { bucket, tenantId, taskId, runId, files, publishInDo, checkCommitted } = params;
  const prepared = await stageV2OutputFilesForPublish({
    bucket,
    tenantId,
    taskId,
    runId,
    files,
  });

  let published: V2PublishTaskOutputsResultDto;
  try {
    published = await publishInDo(prepared.outputs);
  } catch (error) {
    await reconcileAndCleanupStagedR2OnRpcError({
      bucket,
      staged: prepared.staged,
      error,
      checkCommitted,
    });
    throw error;
  }

  if (!published.accepted) {
    await deleteV2R2KeysBestEffort(
      bucket,
      prepared.staged.map((item) => item.r2Key),
    );
  }
  return published;
}
