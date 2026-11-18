import { DomainError, type Id } from '@ember/domain';
import { UUID_PATTERN, parseTenantId } from './validation.js';

export const UPLOAD_KEY_PATTERN = /^uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

/** Structural R2 object body returned by `R2Bucket.get()`. */
export interface R2ObjectBodyPort {
  readonly size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Structural R2 put options subset used by Ember storage adapters. */
export interface R2PutOptionsPort {
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/**
 * Structural Cloudflare R2 bucket contract (edge-safe, zero `@cloudflare/workers-types` or `node:*` deps).
 */
export interface R2BucketPort {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string | Blob,
    options?: R2PutOptionsPort,
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyPort | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** Build the deterministic tenant-scoped R2 object key for a staged upload. */
export function uploadKeyFor(tenantId: Id, uploadId: Id): string {
  const tenant = parseTenantId(tenantId);
  if (typeof uploadId !== 'string' || !UUID_PATTERN.test(uploadId)) {
    throw new DomainError('INVALID_ARGUMENT', 'uploadId must be a UUID');
  }
  return `uploads/${tenant}/${uploadId}`;
}

/** Compute lowercase hex SHA-256 digest using Web Crypto (edge-safe). */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
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

/** Write a bounded `Uint8Array` into Cloudflare R2 with deterministic headers & custom metadata. */
export async function putR2Bytes(
  bucket: R2BucketPort,
  key: string,
  bytes: Uint8Array,
  options: R2PutOptionsPort = {},
): Promise<void> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  await bucket.put(key, copy, options);
}

/** Read and optionally verify exact byte length and SHA-256 digest of an R2 object. */
export async function readR2Bytes(
  bucket: R2BucketPort,
  key: string,
  expected?: { readonly size?: number; readonly sha256?: string },
): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (object === null) {
    throw new DomainError('NOT_FOUND', 'r2 blob bytes are missing');
  }

  const bytes = new Uint8Array(await object.arrayBuffer());

  if (expected?.size !== undefined && bytes.byteLength !== expected.size) {
    throw new DomainError('DB_UNAVAILABLE', 'r2 blob byte length mismatch');
  }

  if (expected?.sha256 !== undefined) {
    const actualSha = await sha256HexBytes(bytes);
    if (actualSha !== expected.sha256) {
      throw new DomainError('DB_UNAVAILABLE', 'r2 blob sha256 integrity verification failed');
    }
  }

  return bytes;
}

/** Best-effort deletion of one or more keys from Cloudflare R2. */
export async function deleteR2Keys(
  bucket: R2BucketPort | undefined,
  keys: readonly string[],
): Promise<void> {
  if (bucket === undefined || keys.length === 0) {
    return;
  }

  const unique = [...new Set(keys)];
  try {
    await bucket.delete(unique);
  } catch {
    // Best-effort cleanup; expired/orphaned keys remain unreachable once DB metadata is deleted.
  }
}
