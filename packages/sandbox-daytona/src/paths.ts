import { InvalidArgumentError } from '@ember/domain';
import { DAYTONA_SANDBOX_LIMITS } from './limits.js';

/**
 * Confined path resolution for the PoC-only text file transfer extension.
 *
 * The adapter never accepts an absolute path from a caller. A caller supplies a *relative*
 * path inside the sandbox workspace root and the adapter composes the final path. This is the
 * only protection against a task writing to `/etc/ld.so.preload`, the Daytona toolbox socket,
 * or an agent-injected credential file.
 *
 * Known limitation (documented in the Gap Report): this is lexical confinement. It does not
 * resolve symlinks inside the sandbox, so a caller that is allowed to run `python3` can create
 * a symlink and then use `putTextFile` through it. The mitigations are the program allowlist
 * and the fact that no Ember secret is ever mounted into a sandbox.
 */
export function resolveConfinedPath(root: string, requested: string): string {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new InvalidArgumentError([{ path: 'path', code: 'too_small' }]);
  }

  if (requested.length > DAYTONA_SANDBOX_LIMITS.maxFilePathChars) {
    throw new InvalidArgumentError([{ path: 'path', code: 'too_big' }]);
  }

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(requested)) {
    throw new InvalidArgumentError([{ path: 'path', code: 'invalid_character' }]);
  }

  if (requested.includes('\\')) {
    throw new InvalidArgumentError([{ path: 'path', code: 'invalid_separator' }]);
  }

  if (requested.startsWith('/')) {
    throw new InvalidArgumentError([{ path: 'path', code: 'absolute_path_denied' }]);
  }

  const segments = requested.split('/');

  for (const segment of segments) {
    if (segment === '..' || segment === '.' || segment === '') {
      throw new InvalidArgumentError([{ path: 'path', code: 'path_traversal_denied' }]);
    }

    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new InvalidArgumentError([{ path: 'path', code: 'invalid_character' }]);
    }
  }

  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  const resolved = `${normalizedRoot}/${segments.join('/')}`;

  if (!resolved.startsWith(`${normalizedRoot}/`)) {
    throw new InvalidArgumentError([{ path: 'path', code: 'path_escape_denied' }]);
  }

  return resolved;
}

/**
 * Byte length of a UTF-8 string without allocating a Buffer for the common case.
 *
 * Used to enforce the stream-retention ceilings; a multi-byte payload must be measured in
 * bytes, not UTF-16 code units, or the ceiling silently doubles for CJK output.
 */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Truncates UTF-8 content to at most `maxBytes`, never splitting a code point. */
export function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');

  if (buffer.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }

  const slice = buffer.subarray(0, maxBytes);
  // Drop a trailing partial code point (0b10xxxxxx continuation bytes).
  let end = slice.length;
  while (end > 0 && ((slice[end - 1] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }

  return { text: slice.subarray(0, end).toString('utf8'), truncated: true };
}
