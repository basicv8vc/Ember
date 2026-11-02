import { randomUUID } from 'node:crypto';
import type { ConsentAuthority } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type {
  ConsentAuthorizationFence,
  ConsentFenceAuthority,
  ConsentReadAuthorization,
} from '@ember/execution';
import type { ConsentPublicationGuard } from '@ember/postgres';

/**
 * Operations and scopes this fixture grants by default.
 *
 * Explicit on purpose: the Worker is not allowed to invent these, so a test that wants a narrower
 * grant has to pass its own arrays. These constants make the fixture's intent readable at the call
 * site instead of hiding it inside the production mirror.
 */
export const TEST_CONSENT_OPERATIONS: readonly string[] = Object.freeze(['read_snapshot']);
export const TEST_CONSENT_SCOPES: readonly string[] = Object.freeze(['source.readonly']);

export interface TestGrantParams {
  readonly tenantId: Id;
  readonly sourceProfileId: string;
  readonly allowedOperations?: readonly string[];
  readonly scopes?: readonly string[];
}

interface TestGrant {
  readonly grantId: string;
  readonly version: number;
  readonly allowedOperations: readonly string[];
  readonly scopes: readonly string[];
  readonly active: boolean;
}

/**
 * Process-local test fixture only. It is intentionally not a PostgreSQL persistence adapter and
 * cannot verify consent revocation races. The durable Lane C implementation remains a merge
 * blocker; this fixture only allows unrelated commitment/Task/Run persistence scenarios to run.
 *
 * It is fence-shaped (`grantId` + `version`) because the Worker refuses to authorize a read or a
 * publication from a verdict-only authority: without a generation there is nothing to bind the
 * read to, and without the authorized operations there is no scope to mirror.
 */
export class InMemoryTestConsentAuthority implements ConsentFenceAuthority {
  private readonly grants = new Map<string, TestGrant>();

  grant(params: TestGrantParams): Promise<void> {
    const key = this.key(params.tenantId, params.sourceProfileId);
    const existing = this.grants.get(key);

    // A re-grant of a revoked lineage starts a NEW generation (new id, version restarted), which
    // is exactly what a fence minted before the re-grant must fail against.
    this.grants.set(key, {
      grantId: existing !== undefined && existing.active ? existing.grantId : randomUUID(),
      version: existing !== undefined && existing.active ? existing.version + 1 : 1,
      allowedOperations: Object.freeze([...(params.allowedOperations ?? TEST_CONSENT_OPERATIONS)]),
      scopes: Object.freeze([...(params.scopes ?? TEST_CONSENT_SCOPES)]),
      active: true,
    });

    return Promise.resolve();
  }

  revoke(tenantId: Id, sourceProfileId: string): Promise<void> {
    const key = this.key(tenantId, sourceProfileId);
    const existing = this.grants.get(key);

    if (existing !== undefined) {
      this.grants.set(key, { ...existing, active: false });
    }

    return Promise.resolve();
  }

  assertActive(tenantId: Id, sourceProfileId: string): Promise<void> {
    if (this.activeGrant(tenantId, sourceProfileId) === null) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Test Source Consent is not active'));
    }

    return Promise.resolve();
  }

  authorizeFence(tenantId: Id, sourceProfileId: string): Promise<ConsentAuthorizationFence> {
    const grant = this.activeGrant(tenantId, sourceProfileId);

    if (grant === null) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Test Source Consent is not active'));
    }

    return Promise.resolve({
      tenantId,
      sourceProfileId,
      grantId: grant.grantId,
      grantVersion: grant.version,
      issuedAt: new Date().toISOString(),
    });
  }

  assertFenceCurrent(fence: ConsentAuthorizationFence): Promise<ConsentReadAuthorization> {
    const grant = this.activeGrant(fence.tenantId, fence.sourceProfileId);

    if (grant === null) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Test Source Consent is not active'));
    }

    // Generation identity, not just the counter: a re-granted lineage restarts its version.
    if (grant.grantId !== fence.grantId || grant.version !== fence.grantVersion) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Test Source Consent was re-granted'));
    }

    return Promise.resolve({
      allowedOperations: grant.allowedOperations,
      scopes: grant.scopes,
    });
  }

  private activeGrant(tenantId: Id, sourceProfileId: string): TestGrant | null {
    const grant = this.grants.get(this.key(tenantId, sourceProfileId));

    return grant !== undefined && grant.active ? grant : null;
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
  authority: ConsentAuthority,
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
