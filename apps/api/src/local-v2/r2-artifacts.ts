import type { R2BucketPort } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import {
  V2_MAX_INLINE_ARTIFACT_BYTES,
  v2ArtifactR2Key,
  type V2TaskOutputFileInput,
} from '@ember/runtime-v2';

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
  readonly stagedR2Keys: readonly string[];
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
      stagedR2Keys: [],
    };
  }

  const outputs: V2TaskOutputFileInput[] = [];
  const stagedR2Keys: string[] = [];
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
      stagedR2Keys.push(r2Key);
      outputs.push({
        artifactId,
        filename: file.filename,
        mediaType: file.mediaType,
        sizeBytes: file.bytes.byteLength,
        sha256,
        r2Key,
      });
    }
    return { outputs, stagedR2Keys };
  } catch (error) {
    await deleteV2R2KeysBestEffort(bucket, stagedR2Keys);
    throw error;
  }
}
