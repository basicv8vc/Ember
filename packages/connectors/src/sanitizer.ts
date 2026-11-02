/**
 * Content sanitization, bounds checking, and untrusted data defense for @ember/connectors.
 *
 * Implements:
 * - Control character stripping (null bytes, ANSI escape sequences, BiDi overrides).
 * - Strict length and UTF-8 byte limits per item and per snapshot (P0-C3-0 §2.1 & §5.1).
 * - Treat all content as inert data.
 */

import { computeCanonicalDigest, deepFreeze, utf8ByteLength } from './canonical.js';
import { createInvalidArgumentError, createPolicyDeniedError } from './errors.js';
import { SOURCE_SNAPSHOT_LIMITS, type SourceSnapshot, type SourceSnapshotItem } from './types.js';

// Regex to detect ANSI escape codes
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// Regex to detect Unicode Bidirectional override controls (trojan source defense)
const BIDI_OVERRIDE_REGEX = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Null byte regex
const NULL_BYTE_REGEX = /\0/g;

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
 * Validates and sanitizes a single SourceSnapshotItem conforming to P0-C3-0 §5.1.
 * Ensures all ceilings are strictly adhered to.
 */
export function sanitizeSnapshotItem(rawItem: unknown, index: number): SourceSnapshotItem {
  if (!rawItem || typeof rawItem !== 'object') {
    throw createInvalidArgumentError(`Snapshot item at index ${index} must be an object`);
  }

  const item = rawItem as Record<string, unknown>;

  // Validate id
  if (typeof item.id !== 'string' || item.id.trim() === '') {
    throw createInvalidArgumentError(`Snapshot item at index ${index} missing non-empty id`);
  }
  const id = sanitizeText(item.id.trim());
  if (id.length > SOURCE_SNAPSHOT_LIMITS.itemIdMaxChars) {
    throw createInvalidArgumentError(
      `Snapshot item at index ${index} id exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.itemIdMaxChars}`,
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

  // Validate contentSnippet
  if (typeof item.contentSnippet !== 'string') {
    throw createInvalidArgumentError(
      `Snapshot item at index ${index} missing contentSnippet string`,
    );
  }
  const contentSnippet = sanitizeText(item.contentSnippet);
  if (contentSnippet.length > SOURCE_SNAPSHOT_LIMITS.itemContentSnippetMaxChars) {
    throw createInvalidArgumentError(
      `Snapshot item at index ${index} contentSnippet exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.itemContentSnippetMaxChars}`,
    );
  }

  // Validate observedAt (RFC 3339)
  if (typeof item.observedAt !== 'string' || item.observedAt.trim() === '') {
    throw createInvalidArgumentError(
      `Snapshot item at index ${index} missing observedAt timestamp`,
    );
  }
  const observedAtDate = new Date(item.observedAt);
  if (Number.isNaN(observedAtDate.getTime())) {
    throw createInvalidArgumentError(
      `Snapshot item at index ${index} observedAt must be a valid RFC 3339 timestamp`,
    );
  }
  const observedAt = observedAtDate.toISOString();

  return Object.freeze({
    id,
    title,
    contentSnippet,
    observedAt,
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
    totalBytes += utf8ByteLength(item.id);
    totalBytes += utf8ByteLength(item.title);
    totalBytes += utf8ByteLength(item.contentSnippet);
    totalBytes += utf8ByteLength(item.observedAt);
  }

  if (totalBytes > maxPayloadBytes) {
    throw createPolicyDeniedError(
      `Snapshot total payload bytes exceed limit (${totalBytes} > ${maxPayloadBytes})`,
      'PAYLOAD_LIMIT_EXCEEDED',
    );
  }
}

/**
 * Rigorously validates and freezes a raw snapshot returned by an untrusted or external reader.
 * Enforces:
 * - Matching sourceProfileId
 * - Valid RFC 3339 observedAt
 * - Bounded safe items (array, item count <= maxItems)
 * - Strict schema on each item (id <= 128, title <= 256, snippet <= 1000)
 * - Total UTF-8 bytes <= maxPayloadBytes
 * - Cryptographic digest integrity: recomputed canonical SHA-256 matches snapshot.digest
 * - Deep immutability via deepFreeze
 */
export function validateReaderReturnedSnapshot(
  raw: unknown,
  expectedProfileId: string,
  maxItems: number = SOURCE_SNAPSHOT_LIMITS.maxItems,
  maxPayloadBytes: number = SOURCE_SNAPSHOT_LIMITS.maxPayloadBytes,
): SourceSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw createPolicyDeniedError(
      'Source reader returned invalid snapshot: must be an object',
      'UNTRUSTED_CONTENT_DETECTED',
    );
  }

  const obj = raw as Record<string, unknown>;

  if (obj.sourceProfileId !== expectedProfileId) {
    throw createPolicyDeniedError(
      'Source reader returned mismatched sourceProfileId',
      'UNTRUSTED_CONTENT_DETECTED',
    );
  }

  if (
    typeof obj.observedAt !== 'string' ||
    obj.observedAt.trim() === '' ||
    Number.isNaN(Date.parse(obj.observedAt))
  ) {
    throw createPolicyDeniedError(
      'Source reader returned invalid observedAt timestamp',
      'UNTRUSTED_CONTENT_DETECTED',
    );
  }

  if (typeof obj.digest !== 'string' || !/^[a-f0-9]{64}$/.test(obj.digest)) {
    throw createPolicyDeniedError(
      'Source reader returned invalid digest format: must be 64-char lowercase hex string',
      'UNTRUSTED_CONTENT_DETECTED',
    );
  }

  if (!Array.isArray(obj.boundedSafeItems)) {
    throw createPolicyDeniedError(
      'Source reader returned invalid boundedSafeItems: must be an array',
      'UNTRUSTED_CONTENT_DETECTED',
    );
  }

  const rawItems = obj.boundedSafeItems as readonly unknown[];

  if (rawItems.length > maxItems) {
    throw createPolicyDeniedError(
      `Snapshot exceeds maximum allowed items (${rawItems.length} > ${maxItems})`,
      'PAYLOAD_LIMIT_EXCEEDED',
    );
  }

  const validatedItems: SourceSnapshotItem[] = [];
  let totalBytes = 0;

  for (let idx = 0; idx < rawItems.length; idx++) {
    const rawItem = rawItems[idx];
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw createPolicyDeniedError(
        `Snapshot item at index ${idx} is invalid: must be an object`,
        'UNTRUSTED_CONTENT_DETECTED',
      );
    }

    const item = rawItem as Record<string, unknown>;

    if (typeof item.id !== 'string' || item.id.trim() === '') {
      throw createPolicyDeniedError(
        `Snapshot item at index ${idx} missing non-empty id`,
        'UNTRUSTED_CONTENT_DETECTED',
      );
    }
    if (item.id.length > SOURCE_SNAPSHOT_LIMITS.itemIdMaxChars) {
      throw createPolicyDeniedError(
        `Snapshot item at index ${idx} id exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.itemIdMaxChars}`,
        'PAYLOAD_LIMIT_EXCEEDED',
      );
    }

    if (typeof item.title !== 'string') {
      throw createPolicyDeniedError(
        `Snapshot item at index ${idx} missing title string`,
        'UNTRUSTED_CONTENT_DETECTED',
      );
    }
    if (item.title.length > SOURCE_SNAPSHOT_LIMITS.itemTitleMaxChars) {
      throw createPolicyDeniedError(
        `Snapshot item at index ${idx} title exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.itemTitleMaxChars}`,
        'PAYLOAD_LIMIT_EXCEEDED',
      );
    }

    if (typeof item.contentSnippet !== 'string') {
      throw createPolicyDeniedError(
        `Snapshot item at index ${idx} missing contentSnippet string`,
        'UNTRUSTED_CONTENT_DETECTED',
      );
    }
    if (item.contentSnippet.length > SOURCE_SNAPSHOT_LIMITS.itemContentSnippetMaxChars) {
      throw createPolicyDeniedError(
        `Snapshot item at index ${idx} contentSnippet exceeds maximum length of ${SOURCE_SNAPSHOT_LIMITS.itemContentSnippetMaxChars}`,
        'PAYLOAD_LIMIT_EXCEEDED',
      );
    }

    if (
      typeof item.observedAt !== 'string' ||
      item.observedAt.trim() === '' ||
      Number.isNaN(Date.parse(item.observedAt))
    ) {
      throw createPolicyDeniedError(
        `Snapshot item at index ${idx} observedAt must be a valid RFC 3339 timestamp`,
        'UNTRUSTED_CONTENT_DETECTED',
      );
    }

    const cleanId = sanitizeText(item.id.trim());
    const cleanTitle = sanitizeText(item.title);
    const cleanSnippet = sanitizeText(item.contentSnippet);
    const cleanObservedAt = new Date(item.observedAt).toISOString();

    totalBytes += utf8ByteLength(cleanId);
    totalBytes += utf8ByteLength(cleanTitle);
    totalBytes += utf8ByteLength(cleanSnippet);
    totalBytes += utf8ByteLength(cleanObservedAt);

    validatedItems.push({
      id: cleanId,
      title: cleanTitle,
      contentSnippet: cleanSnippet,
      observedAt: cleanObservedAt,
    });
  }

  if (totalBytes > maxPayloadBytes) {
    throw createPolicyDeniedError(
      `Snapshot total payload bytes exceed limit (${totalBytes} > ${maxPayloadBytes})`,
      'PAYLOAD_LIMIT_EXCEEDED',
    );
  }

  // Digest verification: ensure raw digest matches recomputed canonical digest
  const expectedDigest = computeCanonicalDigest({
    sourceProfileId: expectedProfileId,
    boundedSafeItems: validatedItems,
  });

  if (obj.digest !== expectedDigest) {
    throw createPolicyDeniedError(
      'Source reader returned corrupted or forged digest',
      'UNTRUSTED_CONTENT_DETECTED',
    );
  }

  const validSnapshot: SourceSnapshot = {
    sourceProfileId: expectedProfileId,
    observedAt: new Date(obj.observedAt).toISOString(),
    digest: expectedDigest,
    boundedSafeItems: validatedItems,
  };

  return deepFreeze(validSnapshot);
}
