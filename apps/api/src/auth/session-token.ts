import { createHash, randomBytes } from 'node:crypto';
import { parseBearerToken, type AuthFailureReason } from './bearer-authenticator.js';

/**
 * Ember session tokens (ADR-0004 I-5 / annex §5.1).
 *
 * `ems_` + base64url(32 CSPRNG bytes) = 256 bits of entropy. The raw token exists only in
 * the HTTP response and this module; repositories receive only its SHA-256 digest.
 */
export const SESSION_TOKEN_PREFIX = 'ems_';
export const SESSION_TOKEN_ENTROPY_BYTES = 32;
export const SESSION_TOKEN_DIGEST_BYTES = 32;
export const SESSION_TOKEN_PATTERN = /^ems_[A-Za-z0-9_-]{43}$/;

export function generateSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(SESSION_TOKEN_ENTROPY_BYTES).toString('base64url')}`;
}

/** The only representation allowed to cross the persistence boundary. */
export function digestSessionToken(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
}

export type SessionBearerResult =
  | { readonly ok: true; readonly token: string; readonly digest: Uint8Array }
  | { readonly ok: false; readonly reason: AuthFailureReason };

/** Parse an `Authorization: Bearer ems_...` header without trusting any other credential. */
export function parseSessionBearer(header: string | undefined): SessionBearerResult {
  const parsed = parseBearerToken(header);

  if (!parsed.ok) {
    return parsed;
  }

  if (!SESSION_TOKEN_PATTERN.test(parsed.token)) {
    // Dev bearer tokens and provider assertions are not Ember session credentials (I-7).
    return { ok: false, reason: 'malformed_authorization' };
  }

  return { ok: true, token: parsed.token, digest: digestSessionToken(parsed.token) };
}
