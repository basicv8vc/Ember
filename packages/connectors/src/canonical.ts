/**
 * Deterministic canonical serialization and hashing for @ember/connectors.
 *
 * The algorithm itself lives in `@ember/contracts` (`canonical.ts`) so the Consent fence digest a
 * connector computes is byte-identical to the one the Worker mints and the durable store
 * re-verifies. This module only adds the connector-local UTF-8 length helper.
 */

/**
 * Returns the byte length of a string when encoded as UTF-8.
 */
export function utf8ByteLength(value: string): number {
  if (typeof value !== 'string') {
    return 0;
  }
  return Buffer.byteLength(value, 'utf8');
}

export { canonicalJsonStringify, computeCanonicalDigest, deepFreeze } from '@ember/contracts';
