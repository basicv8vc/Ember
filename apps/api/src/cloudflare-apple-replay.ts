import type {
  IdentityAssertion,
  IdentityVerifier,
  VerifiedIdentity,
} from './auth/identity-verifier.js';

export interface AppleNonceReplayStore {
  consume(rawNonce: string): Promise<boolean>;
}

export function createCloudflareAppleNonceVerifier(
  verifier: IdentityVerifier,
  store: AppleNonceReplayStore,
): IdentityVerifier {
  return Object.freeze({
    provider: 'apple' as const,
    async verify(assertion: IdentityAssertion): Promise<VerifiedIdentity | null> {
      const identity = await verifier.verify(assertion);
      if (identity === null) {
        return null;
      }

      return (await store.consume(assertion.nonce)) ? identity : null;
    },
  });
}
