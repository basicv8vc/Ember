import type { ConsentRepository } from '@ember/contracts';
import { DomainError } from '@ember/domain';

/**
 * HTTP-facing consent store (P0-C3D).
 *
 * The API depends on the contract, never on `PostgresConsentRepository`, exactly like
 * `CommitmentStore` / `ApprovalHttpStore`. A process started without a database gets a store
 * whose every method fails closed with `DB_UNAVAILABLE` (503) instead of a crash at startup.
 */
export type ConsentHttpStore = ConsentRepository;

export function unconfiguredConsentStore(): ConsentHttpStore {
  const unavailable = (): never => {
    throw new DomainError('DB_UNAVAILABLE', 'consent storage is not configured for this process');
  };

  return {
    grant: () => unavailable(),
    revoke: () => unavailable(),
    get: () => unavailable(),
    list: () => unavailable(),
  };
}
