/**
 * Content sanitization, bounds checking, and untrusted data defense for @ember/connectors.
 *
 * Implements:
 * - Control character stripping (null bytes, ANSI escape sequences, BiDi overrides).
 * - Metadata key blocklists to prevent leaking credential tokens or secrets.
 * - Strict length and UTF-8 byte limits per item and per snapshot.
 * - Treat all content as inert data.
 */

import { utf8ByteLength } from './canonical.js';
import { createInvalidArgumentError, createPolicyDeniedError } from './errors.js';
import { SOURCE_SNAPSHOT_LIMITS, type SourceSnapshotItem } from './types.js';

// Regex to detect ANSI escape codes
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// Regex to detect Unicode Bidirectional override controls (trojan source defense)
const BIDI_OVERRIDE_REGEX = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Null byte regex
const NULL_BYTE_REGEX = /\0/g;

// Blocklisted metadata keys that might carry credentials or authentication tokens
const FORBIDDEN_METADATA_KEY_REGEX =
  /^(authorization|bearer|token|access_token|refresh_token|secret|password|passwd|cookie|set-cookie|credential|credentials|api_key|apikey|private_key|privkey|cert|certificate)$/i;

/**
 * Sanitizes an untrusted text string by removing null bytes, ANSI escapes,
 * and dangerous BiDi overrides. Preserves normal unicode text and whitespace.
 */
export function sanitizeText(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }
  return text
    .replace(NULL_BYTE_REGEX, '')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(BIDI_OVERRIDE_REGEX, '');
}

/**
 * Validates and sanitizes a single SourceSnapshotItem.
 * Ensures all ceilings are strictly adhered to.
 */
export function sanitizeSnapshotItem(rawItem: unknown, index: number): SourceSnapshotItem {
  if (!rawItem || typeof rawItem !== 'object') {
    throw createInvalidArgumentError(`Snapshot item at index ${index} must be an object`);
  }

  const item = rawItem as Record<string, unknown>;

  // Validate itemId
  if (typeof item.itemId !== 'string' || item.itemId.trim() === '') {
    throw createInvalidArgumentError(`Snapshot item at index ${index} missing non-empty itemId`);
  }
  const itemId = sanitizeText(item.itemId.trim());
  if (itemId.length > SOURCE_SNAPSHOT_LIMITS.itemIdMaxChars) {
    throw createInvalidArgumentError(
      `Snapshot item at index ${index} itemId exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.itemIdMaxChars}`,
    );
  }

  // Validate title
  if (typeof item.title !== 'string') {
    throw createInvalidArgumentError(`Snapshot item at index ${index} missing title string`);
  }
  const title = sanitizeText(item.title);
  if (title.length > SOURCE_SNAPSHOT_LIMITS.itemTitleMaxChars) {
    throw createInvalidArgumentError(
      `Snapshot item at index ${index} title exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.itemTitleMaxChars}`,
    );
  }

  // Validate content
  if (typeof item.content !== 'string') {
    throw createInvalidArgumentError(`Snapshot item at index ${index} missing content string`);
  }
  const content = sanitizeText(item.content);
  if (content.length > SOURCE_SNAPSHOT_LIMITS.itemContentSnippetMaxChars) {
    throw createInvalidArgumentError(
      `Snapshot item at index ${index} content exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.itemContentSnippetMaxChars}`,
    );
  }

  // Validate publishedAt
  let publishedAt: string | null = null;
  if (item.publishedAt !== undefined && item.publishedAt !== null) {
    if (typeof item.publishedAt !== 'string') {
      throw createInvalidArgumentError(
        `Snapshot item at index ${index} publishedAt must be a string or null`,
      );
    }
    publishedAt = item.publishedAt.trim();
  }

  // Validate and sanitize metadata
  const safeMetadata: Record<string, string | number | boolean> = {};
  if (item.metadata !== undefined && item.metadata !== null) {
    if (typeof item.metadata !== 'object' || Array.isArray(item.metadata)) {
      throw createInvalidArgumentError(
        `Snapshot item at index ${index} metadata must be a record object`,
      );
    }

    const metadataRecord = item.metadata as Record<string, unknown>;
    const keys = Object.keys(metadataRecord);
    if (keys.length > SOURCE_SNAPSHOT_LIMITS.maxMetadataKeys) {
      throw createInvalidArgumentError(
        `Snapshot item at index ${index} metadata exceeds maximum of ${SOURCE_SNAPSHOT_LIMITS.maxMetadataKeys} keys`,
      );
    }

    for (const key of keys) {
      const sanitizedKey = sanitizeText(key.trim());
      if (
        sanitizedKey.length === 0 ||
        sanitizedKey.length > SOURCE_SNAPSHOT_LIMITS.maxMetadataKeyChars
      ) {
        throw createInvalidArgumentError(
          `Snapshot item at index ${index} metadata key length out of bounds: 1..${SOURCE_SNAPSHOT_LIMITS.maxMetadataKeyChars}`,
        );
      }

      // Check blocklist
      if (FORBIDDEN_METADATA_KEY_REGEX.test(sanitizedKey)) {
        throw createPolicyDeniedError(
          `Snapshot item at index ${index} metadata contains forbidden security-sensitive key`,
          'UNTRUSTED_CONTENT_DETECTED',
        );
      }

      const val = metadataRecord[key];
      if (typeof val === 'string') {
        const sanitizedVal = sanitizeText(val);
        if (sanitizedVal.length > SOURCE_SNAPSHOT_LIMITS.maxMetadataValueChars) {
          throw createInvalidArgumentError(
            `Snapshot item at index ${index} metadata value exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.maxMetadataValueChars}`,
          );
        }
        safeMetadata[sanitizedKey] = sanitizedVal;
      } else if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
          throw createInvalidArgumentError(
            `Snapshot item at index ${index} metadata value must be a finite number`,
          );
        }
        safeMetadata[sanitizedKey] = val;
      } else if (typeof val === 'boolean') {
        safeMetadata[sanitizedKey] = val;
      } else {
        throw createInvalidArgumentError(
          `Snapshot item at index ${index} metadata value must be string, number, or boolean`,
        );
      }
    }
  }

  return Object.freeze({
    itemId,
    title,
    content,
    publishedAt,
    metadata: Object.freeze(safeMetadata),
  });
}

/**
 * Validates a list of snapshot items against total item count and UTF-8 byte bounds.
 */
export function validateSnapshotBounds(
  items: readonly SourceSnapshotItem[],
  maxItems: number = SOURCE_SNAPSHOT_LIMITS.maxItems,
  maxPayloadBytes: number = SOURCE_SNAPSHOT_LIMITS.maxPayloadBytes,
): void {
  if (items.length > maxItems) {
    throw createPolicyDeniedError(
      `Snapshot exceeds maximum allowed items (${items.length} > ${maxItems})`,
      'PAYLOAD_LIMIT_EXCEEDED',
    );
  }

  let totalBytes = 0;
  for (const item of items) {
    totalBytes += utf8ByteLength(item.itemId);
    totalBytes += utf8ByteLength(item.title);
    totalBytes += utf8ByteLength(item.content);
    if (item.publishedAt) {
      totalBytes += utf8ByteLength(item.publishedAt);
    }
    for (const [k, v] of Object.entries(item.metadata)) {
      totalBytes += utf8ByteLength(k);
      totalBytes += utf8ByteLength(String(v));
    }
  }

  if (totalBytes > maxPayloadBytes) {
    throw createPolicyDeniedError(
      `Snapshot total payload bytes exceed limit (${totalBytes} > ${maxPayloadBytes})`,
      'PAYLOAD_LIMIT_EXCEEDED',
    );
  }
}
