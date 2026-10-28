import { createHash } from 'node:crypto';

/**
 * Compute a lowercase hexadecimal SHA-256 of the UTF-8 encoding of `text`.
 *
 * This is ordinary in-process hashing. It never spawns a process, never opens a file and
 * never touches the network.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Deterministic RFC 9562 UUID-shaped identifier derived from the supplied parts.
 *
 * Used for in-memory simulation handles (for example a FakeSandbox output reference) so a
 * test can assert that the same simulation input always produces the same handle. It is
 * **not** an authorization token and it is **not** a durable artifact identifier.
 */
export function simulatedId(...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
  const variantNibble = ((Number.parseInt(digest.charAt(16), 16) & 0x3) | 0x8).toString(16);

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    // Version 8 (custom) keeps the value inside the UUID grammar accepted by `z.uuid()`.
    `8${digest.slice(13, 16)}`,
    `${variantNibble}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}
