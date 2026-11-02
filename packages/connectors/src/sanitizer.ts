/**
 * Content sanitization, bounds checking, and untrusted data defense for @ember/connectors.
 *
 * Implements:
 * - Control character stripping (null bytes, ANSI escape sequences, BiDi overrides).
 * - Strict length and UTF-8 byte limits per item and per snapshot (P0-C3-0 §2.1 & §5.1).
 * - Treat all content as inert data.
 * - Exception-safe inspection of reader-returned objects: throwing getters and hostile Proxies
 *   are converted into fixed, attacker-independent rejection codes and never re-thrown.
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
 * Fixed, attacker-independent rejection diagnostics for snapshots returned by a source reader.
 * These are compile-time constants: no untrusted value is ever interpolated into them.
 */
export const SAFE_SNAPSHOT_REJECTION_DIAGNOSTICS = Object.freeze({
  UNTRUSTED_CONTENT_DETECTED: 'Source reader returned invalid snapshot',
  PAYLOAD_LIMIT_EXCEEDED: 'Source reader returned snapshot exceeding bounds',
} as const);

export type ReaderSnapshotRejectionCode = keyof typeof SAFE_SNAPSHOT_REJECTION_DIAGNOSTICS;

/**
 * Discriminated, always-trustworthy outcome of inspecting a reader-returned snapshot.
 * Both variants are plain objects created by this module, so consumers may read them directly.
 */
export type ReaderSnapshotInspection =
  | { readonly ok: true; readonly snapshot: SourceSnapshot }
  | { readonly ok: false; readonly denialCode: ReaderSnapshotRejectionCode };

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

function rejectSnapshot(code: ReaderSnapshotRejectionCode): ReaderSnapshotInspection {
  return { ok: false, denialCode: code };
}

/**
 * Inspects a raw snapshot returned by an untrusted reader.
 *
 * Trust boundary rules:
 * - `raw` and everything reachable from it is UNTRUSTED. Every property read can execute
 *   attacker-controlled code (throwing getters, hostile Proxies), so each property is read
 *   exactly once and all reads happen inside a single `try`/`catch`.
 * - The caught value is NEVER inspected. It may be a Proxy that throws on `instanceof`,
 *   prototype lookup, or property access, and it may carry secrets in `message`, `stack`,
 *   `code`, `name`, or `diagnostic`.
 * - Every failure is expressed as a fixed {@link ReaderSnapshotRejectionCode} chosen purely by
 *   trusted control flow in this module. Reader-supplied metadata can never influence it.
 * - This function never throws.
 */
export function inspectReaderReturnedSnapshot(
  raw: unknown,
  expectedProfileId: string,
  maxItems: number = SOURCE_SNAPSHOT_LIMITS.maxItems,
  maxPayloadBytes: number = SOURCE_SNAPSHOT_LIMITS.maxPayloadBytes,
): ReaderSnapshotInspection {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
    }

    const obj = raw as Record<string, unknown>;

    if (obj.sourceProfileId !== expectedProfileId) {
      return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
    }

    const rawObservedAt = obj.observedAt;
    if (
      typeof rawObservedAt !== 'string' ||
      rawObservedAt.trim() === '' ||
      Number.isNaN(Date.parse(rawObservedAt))
    ) {
      return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
    }

    const rawDigest = obj.digest;
    if (typeof rawDigest !== 'string' || !SHA256_HEX_REGEX.test(rawDigest)) {
      return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
    }

    const rawItems = obj.boundedSafeItems;
    if (!Array.isArray(rawItems)) {
      return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
    }

    // Read the length once: a hostile Proxy could otherwise report a changing length and either
    // stall the loop or bypass the ceiling.
    const itemCount = rawItems.length;
    if (typeof itemCount !== 'number' || !Number.isSafeInteger(itemCount) || itemCount < 0) {
      return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
    }
    if (itemCount > maxItems) {
      return rejectSnapshot('PAYLOAD_LIMIT_EXCEEDED');
    }

    const validatedItems: SourceSnapshotItem[] = [];
    let totalBytes = 0;

    for (let idx = 0; idx < itemCount; idx++) {
      const rawItem: unknown = rawItems[idx];
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
      }

      const item = rawItem as Record<string, unknown>;

      // One read per untrusted property: no time-of-check/time-of-use gap for hostile getters.
      const rawId: unknown = item.id;
      if (typeof rawId !== 'string' || rawId.trim() === '') {
        return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
      }
      if (rawId.length > SOURCE_SNAPSHOT_LIMITS.itemIdMaxChars) {
        return rejectSnapshot('PAYLOAD_LIMIT_EXCEEDED');
      }

      const rawTitle: unknown = item.title;
      if (typeof rawTitle !== 'string') {
        return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
      }
      if (rawTitle.length > SOURCE_SNAPSHOT_LIMITS.itemTitleMaxChars) {
        return rejectSnapshot('PAYLOAD_LIMIT_EXCEEDED');
      }

      const rawSnippet: unknown = item.contentSnippet;
      if (typeof rawSnippet !== 'string') {
        return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
      }
      if (rawSnippet.length > SOURCE_SNAPSHOT_LIMITS.itemContentSnippetMaxChars) {
        return rejectSnapshot('PAYLOAD_LIMIT_EXCEEDED');
      }

      const rawItemObservedAt: unknown = item.observedAt;
      if (
        typeof rawItemObservedAt !== 'string' ||
        rawItemObservedAt.trim() === '' ||
        Number.isNaN(Date.parse(rawItemObservedAt))
      ) {
        return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
      }

      const cleanId = sanitizeText(rawId.trim());
      const cleanTitle = sanitizeText(rawTitle);
      const cleanSnippet = sanitizeText(rawSnippet);
      const cleanObservedAt = new Date(rawItemObservedAt).toISOString();

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
      return rejectSnapshot('PAYLOAD_LIMIT_EXCEEDED');
    }

    // The digest is recomputed from the freshly copied, sanitized items: forged or corrupted
    // digests cannot pass, and the reader cannot influence the trusted snapshot via that field.
    const expectedDigest = computeCanonicalDigest({
      sourceProfileId: expectedProfileId,
      boundedSafeItems: validatedItems,
    });

    if (rawDigest !== expectedDigest) {
      return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
    }

    const validSnapshot: SourceSnapshot = {
      sourceProfileId: expectedProfileId,
      observedAt: new Date(rawObservedAt).toISOString(),
      digest: expectedDigest,
      boundedSafeItems: validatedItems,
    };

    return { ok: true, snapshot: deepFreeze(validSnapshot) };
  } catch {
    // A hostile getter or Proxy trap threw. The thrown value is deliberately not bound and never
    // read: it may itself be a Proxy, may throw on `instanceof` or property access, and may carry
    // secrets. Nothing from it can reach the caller.
    return rejectSnapshot('UNTRUSTED_CONTENT_DETECTED');
  }
}

/**
 * Throwing façade over {@link inspectReaderReturnedSnapshot}.
 *
 * Every failure — including exceptions raised by hostile getters or Proxy traps while the returned
 * object is inspected — is converted into a fixed, safe `POLICY_DENIED` DomainError. The original
 * thrown value is never re-thrown, wrapped, or read, so no untrusted message, stack, name, code,
 * or diagnostic can leak to the caller.
 */
export function validateReaderReturnedSnapshot(
  raw: unknown,
  expectedProfileId: string,
  maxItems: number = SOURCE_SNAPSHOT_LIMITS.maxItems,
  maxPayloadBytes: number = SOURCE_SNAPSHOT_LIMITS.maxPayloadBytes,
): SourceSnapshot {
  const inspection = inspectReaderReturnedSnapshot(
    raw,
    expectedProfileId,
    maxItems,
    maxPayloadBytes,
  );

  if (!inspection.ok) {
    throw createPolicyDeniedError(
      SAFE_SNAPSHOT_REJECTION_DIAGNOSTICS[inspection.denialCode],
      inspection.denialCode,
    );
  }

  return inspection.snapshot;
}
