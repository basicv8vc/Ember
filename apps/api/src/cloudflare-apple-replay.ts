import { createHash } from 'node:crypto';
import { DomainError } from '@ember/domain';
import type { Pool } from '@ember/postgres/b1-worker';
import type {
  IdentityAssertion,
  IdentityVerifier,
  VerifiedIdentity,
} from './auth/identity-verifier.js';

const REPLAY_RETENTION_MINUTES = 80;

const DELETE_EXPIRED_NONCES_SQL = `
DELETE FROM ember_private.apple_identity_nonce_replays
 WHERE expires_at <= clock_timestamp()
`;

const INSERT_NONCE_SQL = `
INSERT INTO ember_private.apple_identity_nonce_replays (nonce_digest, expires_at)
VALUES ($1, clock_timestamp() + interval '${REPLAY_RETENTION_MINUTES} minutes')
ON CONFLICT (nonce_digest) DO NOTHING
RETURNING nonce_digest
`;

export interface AppleNonceReplayStore {
  consume(rawNonce: string): Promise<boolean>;
}

/**
 * Worker-only replay fence over the frozen Apple verifier. Only SHA-256 of the client nonce is
 * stored, never the raw nonce or JWT. The 80-minute retention covers the verifier's maximum
 * one-hour token age plus ten minutes of clock tolerance on either side of issuance.
 */
export function createCloudflareAppleNonceReplayStore(
  pool: Pick<Pool, 'query'>,
): AppleNonceReplayStore {
  return Object.freeze({
    async consume(rawNonce: string): Promise<boolean> {
      const digest = createHash('sha256').update(rawNonce, 'utf8').digest();

      try {
        // The table's unique digest constraint makes concurrent replay attempts single-use.
        await pool.query(DELETE_EXPIRED_NONCES_SQL);
        const inserted = await pool.query<{ nonce_digest: Buffer }>(INSERT_NONCE_SQL, [digest]);
        return inserted.rows.length === 1;
      } catch {
        // Driver diagnostics may contain SQL or connection details.
        throw new DomainError('DB_UNAVAILABLE', 'Apple nonce replay check is unavailable');
      }
    },
  });
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
