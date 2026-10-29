import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '@ember/domain';
import type { DevTenantCredential } from './dev-auth-config.js';

/**
 * Bearer-token authentication for local development (P0B-07a).
 *
 * A presented token is mapped to exactly one configured tenant. The mapping is a lookup
 * over SHA-256 digests compared with `timingSafeEqual`, so:
 * - no token value is compared with `===` (no early-exit timing signal per character);
 * - every configured entry is compared for every request (no short-circuit on match);
 * - the raw token never leaves this module: callers only receive an `AuthContext`.
 *
 * Failure reasons are a closed enum so a log line can explain a rejection without ever
 * containing the presented credential.
 */

/** Why a request was rejected. Logged as metadata; never returned to the client. */
export const AUTH_FAILURE_REASONS = [
  'missing_authorization',
  'malformed_authorization',
  'unknown_token',
] as const;

export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

export type AuthResult =
  | { readonly ok: true; readonly context: AuthContext }
  | { readonly ok: false; readonly reason: AuthFailureReason };

export interface DevAuthenticator {
  /** Resolve a verified identity from a raw `Authorization` header. */
  authenticate(authorizationHeader: string | undefined): AuthResult;
}

/**
 * `Bearer` plus at least one space, case-insensitive (RFC 7235 schemes are case-insensitive).
 * Deliberately strict about everything else: no comma, no extra credentials, no tabs.
 */
const BEARER_SCHEME = /^Bearer +/i;

/** Sanity bound for a presented token before hashing. Matches the configured maximum. */
const PRESENTED_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,256}$/;

export type BearerTokenParseResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: AuthFailureReason };

/**
 * Extract the credential from an `Authorization` header without trusting its shape.
 *
 * Note that the parsed token is only ever consumed by `createDevTokenAuthenticator`; it is
 * never logged, returned in a response, or placed in a `DomainError`.
 */
export function parseBearerToken(header: string | undefined): BearerTokenParseResult {
  if (header === undefined) {
    return { ok: false, reason: 'missing_authorization' };
  }

  const trimmed = header.trim();

  if (trimmed === '') {
    return { ok: false, reason: 'missing_authorization' };
  }

  if (!BEARER_SCHEME.test(trimmed)) {
    return { ok: false, reason: 'malformed_authorization' };
  }

  const token = trimmed.replace(BEARER_SCHEME, '');

  if (!PRESENTED_TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: 'malformed_authorization' };
  }

  return { ok: true, token };
}

function digestOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function toContext(credential: DevTenantCredential): AuthContext {
  return Object.freeze({
    tenantId: credential.tenantId,
    principalId: credential.principalId,
    policyVersion: credential.policyVersion,
  });
}

/**
 * Build an authenticator from validated credentials.
 *
 * An empty credential list is legal and fail-closed: every request is rejected with
 * `unknown_token` (or a header-shape reason) and never reaches a repository.
 */
export function createDevTokenAuthenticator(
  credentials: readonly DevTenantCredential[],
): DevAuthenticator {
  const entries = credentials.map((credential) => ({
    digest: digestOf(credential.token),
    context: toContext(credential),
  }));

  return {
    authenticate(authorizationHeader) {
      const parsed = parseBearerToken(authorizationHeader);

      if (!parsed.ok) {
        return parsed;
      }

      const presented = digestOf(parsed.token);
      let matched: AuthContext | undefined;

      // Compare against every configured entry; do not return early on a match.
      for (const entry of entries) {
        if (timingSafeEqual(presented, entry.digest)) {
          matched ??= entry.context;
        }
      }

      if (matched === undefined) {
        return { ok: false, reason: 'unknown_token' };
      }

      // A fresh object: callers cannot mutate the immutable configured identity.
      return { ok: true, context: { ...matched } };
    },
  };
}
