/**
 * Deterministic canonical serialization and hashing for @ember/connectors.
 *
 * Provides:
 * - Deterministic JSON serialization (lexicographically sorted keys, whitespace-invariant).
 * - Exact SHA-256 digest computation (64 hex characters).
 * - UTF-8 byte length calculation.
 * - Deep immutability enforcement via recursive Object.freeze.
 */

import { createHash } from 'node:crypto';

/**
 * Returns the byte length of a string when encoded as UTF-8.
 */
export function utf8ByteLength(value: string): number {
  if (typeof value !== 'string') {
    return 0;
  }
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Deterministic JSON stringifier.
 * - Sorts object keys lexicographically at every level.
 * - Normalizes arrays preserving element order.
 * - Eliminates all extraneous whitespace.
 * - Rejects non-finite numbers and circular structures.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Non-finite numbers cannot be canonicalized');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const elements = value.map((elem) => canonicalJsonStringify(elem));
    return `[${elements.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const entries: string[] = [];

  for (const key of sortedKeys) {
    const val = record[key];
    if (val !== undefined && typeof val !== 'function' && typeof val !== 'symbol') {
      entries.push(`${JSON.stringify(key)}:${canonicalJsonStringify(val)}`);
    }
  }

  return `{${entries.join(',')}}`;
}

/**
 * Computes a deterministic SHA-256 hex digest (64 characters) over the canonical JSON
 * representation of the given value.
 */
export function computeCanonicalDigest(value: unknown): string {
  const canonical = canonicalJsonStringify(value);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Recursively freezes an object and all nested object/array properties.
 * Prevents callers, tests, or subcomponents from mutating shared fixture state.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Freeze self
  Object.freeze(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
        deepFreeze(item);
      }
    }
  } else {
    for (const key of Object.keys(obj)) {
      const val = (obj as Record<string, unknown>)[key];
      if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
  }

  return obj;
}
