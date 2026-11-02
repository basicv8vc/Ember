import { randomUUID } from 'node:crypto';
import {
  deriveConsentStatus,
  type AuthorizedConsentGeneration,
  type ConsentAuthority,
  type ConsentGrant,
  type ConsentRegistry,
  type GrantConsentParams,
  type SourceProfileId,
} from '@ember/connectors';
import { DomainError } from '@ember/domain';
import type { ConsentFenceAuthority } from '@ember/execution';
import type { ConsentDispatchFence, ConsentPublicationGuard } from '@ember/postgres';

/**
 * Operations and scopes this fixture grants by default.
 *
 * Explicit on purpose: the Worker is not allowed to invent these, so a test that wants a narrower
 * grant has to pass its own arrays. These constants make the fixture's intent readable at the call
 * site instead of hiding it inside the production mirror.
 */
export const TEST_CONSENT_OPERATIONS: readonly string[] = Object.freeze(['read_snapshot']);
export const TEST_CONSENT_SCOPES: readonly string[] = Object.freeze(['source.readonly']);

/** Kept as a named alias so call sites read as "the terms of this test grant". */
export type TestGrantParams = GrantConsentParams;

/**
 * Process-local test STORE, shaped exactly like the durable one the Worker expects to be wired.
 *
 * It implements both canonical C3C ports:
 *
 * - `ConsentAuthority.resolveGeneration` — the authoritative generation read the Worker gates and
 *   the connector boundary resolve against;
 * - `ConsentRegistry` — the grant record, which is where the authorized operations/scopes come
 *   from. No scope is ever defaulted by production code; a test that wants a narrow grant passes
 *   `allowedOperations`.
 *
 * Generation semantics mirror the frozen contract: a first grant mints `version` 1, an identical
 * re-affirmation keeps the generation, and any explicit re-grant (changed terms, or after
 * revocation/expiry) mints a NEW `grantId` with an incremented `version`. Revocation is terminal
 * and bumps the version exactly once, so a fence captured earlier can never become valid again.
 *
 * This is a fixture, not a persistence adapter: it cannot verify revocation races across database
 * connections. Those remain P0-C3D's acceptance criterion (#84).
 */
export class InMemoryTestConsentStore implements ConsentAuthority, ConsentRegistry {
  private readonly grants = new Map<string, ConsentGrant>();

  grant(params: GrantConsentParams, now: Date = new Date()): ConsentGrant {
    const key = this.key(params.tenantId, params.sourceProfileId);
    const existing = this.grants.get(key);
    const operations = Object.freeze([...(params.allowedOperations ?? TEST_CONSENT_OPERATIONS)]);
    const scopes = Object.freeze([...(params.scopes ?? TEST_CONSENT_SCOPES)]);
    const expiresAt = params.expiresAt ?? null;

    if (existing !== undefined && deriveConsentStatus(existing, now) === 'active') {
      // Identical re-affirmation keeps the generation; changed terms replace it.
      if (
        sameList(existing.allowedOperations, operations) &&
        sameList(existing.scopes, scopes) &&
        existing.expiresAt === expiresAt
      ) {
        return existing;
      }

      return this.store(key, {
        ...existing,
        allowedOperations: operations,
        scopes,
        expiresAt,
        grantedAt: now.toISOString(),
        version: existing.version + 1,
      });
    }

    return this.store(key, {
      grantId: randomUUID(),
      tenantId: params.tenantId,
      sourceProfileId: params.sourceProfileId,
      status: 'active',
      allowedOperations: operations,
      scopes,
      grantedAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
      version: existing === undefined ? 1 : existing.version + 1,
    });
  }

  get(tenantId: string, sourceProfileId: SourceProfileId, now: Date = new Date()): ConsentGrant {
    const record = this.grants.get(this.key(tenantId, sourceProfileId));

    if (record === undefined) {
      throw new DomainError('NOT_FOUND', 'Test Source Consent does not exist');
    }

    return effective(record, now);
  }

  revoke(tenantId: string, sourceProfileId: SourceProfileId, now: Date = new Date()): ConsentGrant {
    const key = this.key(tenantId, sourceProfileId);
    const record = this.grants.get(key);

    if (record === undefined) {
      throw new DomainError('NOT_FOUND', 'Test Source Consent does not exist');
    }

    if (record.status === 'revoked') {
      return record;
    }

    // Terminal, and it bumps the version exactly once: the generation that was fenced is dead.
    return this.store(key, {
      ...record,
      status: 'revoked',
      revokedAt: now.toISOString(),
      version: record.version + 1,
    });
  }

  list(tenantId: string, now: Date = new Date()): readonly ConsentGrant[] {
    return [...this.grants.values()]
      .filter((record) => record.tenantId === tenantId)
      .map((record) => effective(record, now));
  }

  clear(): void {
    this.grants.clear();
  }

  /**
   * Authoritative generation read (P0-C3C `ConsentAuthority`).
   *
   * Returns `null` only when the lineage has no record at all. A revoked or elapsed record is
   * returned with its EFFECTIVE status so the caller fails closed instead of guessing.
   */
  resolveGeneration(
    tenantId: string,
    sourceProfileId: SourceProfileId,
    now: Date = new Date(),
  ): AuthorizedConsentGeneration | null {
    const record = this.grants.get(this.key(tenantId, sourceProfileId));

    if (record === undefined) {
      return null;
    }

    return {
      tenantId: record.tenantId,
      sourceProfileId: record.sourceProfileId,
      grantId: record.grantId,
      version: record.version,
      status: deriveConsentStatus(record, now),
      expiresAt: record.expiresAt,
    };
  }

  private store(key: string, record: ConsentGrant): ConsentGrant {
    this.grants.set(key, Object.freeze(record));
    return record;
  }

  private key(tenantId: string, sourceProfileId: string): string {
    return `${tenantId}\u0000${sourceProfileId}`;
  }
}

/** Projects a stored record onto its effective, point-in-time view. */
function effective(record: ConsentGrant, now: Date): ConsentGrant {
  return Object.freeze({ ...record, status: deriveConsentStatus(record, now) });
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Test-only publication gate that shares state with the fixture store.
 *
 * It runs inside the PostgreSQL transaction callback but does not read or lock database rows: the
 * durable, transaction-scoped guard is `PostgresConsentPublicationGuard` (P0-C3D, #84), and it is
 * what the consent integration suite uses. This double exists for the commitment suites that only
 * need the gates armed, so it keeps the SAME contract as the durable one — both methods receive the
 * repository's client, both compare the generation, and a missing fence is denied — instead of a
 * weaker `assertActive`-only shape that could hide a stolen revocation window.
 */
export function createTestConsentPublicationGuard(
  authority: Pick<ConsentFenceAuthority, 'assertActive' | 'authorizeFence'>,
): ConsentPublicationGuard {
  return {
    async authorizeFence(_client, params): Promise<ConsentDispatchFence> {
      await authority.assertActive(params.tenantId, params.sourceProfileId);

      const fence = await authority.authorizeFence(params.tenantId, params.sourceProfileId);

      return { grantId: fence.grantId, version: fence.grantVersion };
    },
    async assertFenceCurrent(_client, params): Promise<void> {
      if (params.fence === null) {
        throw new DomainError('POLICY_DENIED', 'the occurrence records no Consent generation');
      }

      const current = await authority.authorizeFence(params.tenantId, params.sourceProfileId);

      if (
        current.grantId !== params.fence.grantId ||
        current.grantVersion !== params.fence.version
      ) {
        throw new DomainError('POLICY_DENIED', 'Source Consent generation is no longer current');
      }
    },
  };
}

/** Used only by legacy persistence tests that do not exercise source access or consent. */
export const allowTestConsentPublication: ConsentPublicationGuard = {
  authorizeFence(_client, _params): Promise<ConsentDispatchFence> {
    return Promise.resolve({ grantId: randomUUID(), version: 1 });
  },
  assertFenceCurrent(_client, params): Promise<void> {
    return params.fence === null
      ? Promise.reject(
          new DomainError('POLICY_DENIED', 'the occurrence records no Consent generation'),
        )
      : Promise.resolve();
  },
};
