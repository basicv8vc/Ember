import { InvalidArgumentError, type Id } from '@ember/domain';

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
export const STAGING_KEY_PATTERN = /^staging\/[0-9a-f-]{36}\/[0-9a-f]{64}$/;
export const BLOB_KEY_PATTERN = /^blobs\/[0-9a-f-]{36}\/[0-9a-f]{64}$/;

export interface InstalledFile {
  readonly storageKey: string;
  readonly sha256: string;
  readonly size: number;
}

function invalid(field: string, code: string): never {
  throw new InvalidArgumentError([{ path: field, code }]);
}

export function parseTenantId(tenantId: Id): string {
  if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
    invalid('tenantId', 'invalid_id');
  }

  return tenantId;
}

export function parseMediaType(mediaType: string): string {
  if (typeof mediaType !== 'string' || !MEDIA_TYPE_PATTERN.test(mediaType)) {
    invalid('mediaType', 'invalid_media_type');
  }

  return mediaType;
}

export function parseDigest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    invalid('sha256', 'invalid_digest');
  }

  return value;
}

export function stagingKeyFor(tenantId: Id, sha256: string): string {
  return `staging/${parseTenantId(tenantId)}/${parseDigest(sha256)}`;
}

export function blobKeyFor(tenantId: Id, sha256: string): string {
  return `blobs/${parseTenantId(tenantId)}/${parseDigest(sha256)}`;
}

/** Parse a stored key and prove it matches the namespace the caller expects. */
export function parseStorageKey(value: unknown, namespace: 'staging' | 'blobs'): string {
  if (typeof value !== 'string') {
    invalid('storageKey', 'not_a_string');
  }

  const pattern = namespace === 'staging' ? STAGING_KEY_PATTERN : BLOB_KEY_PATTERN;

  if (!pattern.test(value)) {
    invalid('storageKey', 'invalid_storage_key');
  }

  return value;
}
