import { createHash } from 'node:crypto';

/**
 * B1-2B identity-verification boundary (ADR-0004 §5.2 / annex §5.1 I-3).
 *
 * A verifier turns a provider assertion into exactly one value: the stable provider subject.
 * Email, display name and every other claim are deliberately not part of `VerifiedIdentity`,
 * so no caller can accidentally treat them as identity. Verification failure is a single
 * `null` result: the HTTP layer cannot distinguish a bad signature from an unknown user.
 */
export type IdentityProvider = 'apple' | 'dev';

export interface VerifiedIdentity {
  readonly provider: IdentityProvider;
  readonly providerSubject: string;
}

export interface IdentityAssertion {
  /** Raw provider assertion. Never logged, echoed or persisted. */
  readonly identityToken: string;
  /** Client nonce. Apple verification binds it; the dev verifier ignores it (§5.2). */
  readonly nonce: string;
}

export interface IdentityVerifier {
  readonly provider: IdentityProvider;
  verify(assertion: IdentityAssertion): Promise<VerifiedIdentity | null>;
}

/** Prefix that keeps dev subjects disjoint from any real Apple `sub` value. */
export const DEV_SUBJECT_PREFIX = 'dev:';

/** The whole request body is capped at 8 KiB, so a dev assertion cannot be unbounded. */
const DEV_ASSERTION_MAX_BYTES = 8_192;

/**
 * Deterministic development verifier (annex §5.5).
 *
 * It is *only* a subject mapper. Whether this verifier may be reached at all is decided by
 * `DevProviderPolicy` (R-9), never by this function and never by a request header.
 */
export function createDevIdentityVerifier(): IdentityVerifier {
  return {
    provider: 'dev',
    verify({ identityToken }): Promise<VerifiedIdentity | null> {
      if (
        identityToken.length === 0 ||
        Buffer.byteLength(identityToken, 'utf8') > DEV_ASSERTION_MAX_BYTES
      ) {
        return Promise.resolve(null);
      }

      const digest = createHash('sha256').update(identityToken, 'utf8').digest('hex');
      return Promise.resolve(
        Object.freeze({
          provider: 'dev' as const,
          providerSubject: `${DEV_SUBJECT_PREFIX}${digest}`,
        }),
      );
    },
  };
}
