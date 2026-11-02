import type { ConsentAuthority } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type { ConsentPublicationGuard } from '@ember/postgres';

/**
 * Process-local test fixture only. It is intentionally not a PostgreSQL persistence adapter and
 * cannot verify consent revocation races. The durable Lane C implementation remains a merge
 * blocker; this fixture only allows unrelated commitment/Task/Run persistence scenarios to run.
 */
export class InMemoryTestConsentAuthority implements ConsentAuthority {
  private readonly active = new Set<string>();

  grant(params: { readonly tenantId: Id; readonly sourceProfileId: string }): Promise<void> {
    this.active.add(this.key(params.tenantId, params.sourceProfileId));
    return Promise.resolve();
  }

  revoke(tenantId: Id, sourceProfileId: string): Promise<void> {
    this.active.delete(this.key(tenantId, sourceProfileId));
    return Promise.resolve();
  }

  assertActive(tenantId: Id, sourceProfileId: string): Promise<void> {
    if (!this.active.has(this.key(tenantId, sourceProfileId))) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Test Source Consent is not active'));
    }

    return Promise.resolve();
  }

  private key(tenantId: Id, sourceProfileId: string): string {
    return `${tenantId}\u0000${sourceProfileId}`;
  }
}

/**
 * Explicitly test-only publication gate that shares state with `InMemoryTestConsentAuthority`.
 * It runs during the PostgreSQL transaction callback but does not read or lock database rows.
 */
export function createTestConsentPublicationGuard(
  authority: InMemoryTestConsentAuthority,
): ConsentPublicationGuard {
  return {
    async assertActive(_client, params): Promise<void> {
      await authority.assertActive(params.tenantId, params.sourceProfileId);
    },
  };
}

/** Used only by legacy persistence tests that do not exercise source access or consent. */
export const allowTestConsentPublication: ConsentPublicationGuard = Object.freeze({
  assertActive(): Promise<void> {
    return Promise.resolve();
  },
});
