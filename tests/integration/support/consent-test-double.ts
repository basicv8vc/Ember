import type {
  AuthorizedConsentGeneration,
  ConsentAuthorizationFence,
  ConsentAuthority,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type { ConsentDispatchFence, ConsentPublicationGuard } from '@ember/postgres';

/** Structural mirror of the repository's guard parameters. */
interface ConsentGuardParams {
  readonly tenantId: Id;
  readonly sourceProfileId: string;
  readonly fence: ConsentDispatchFence | null;
}

/**
 * Process-local test fixture only. It is intentionally not a PostgreSQL persistence adapter and
 * cannot verify consent revocation races; `tests/integration/p0c3d-consent-postgres.test.ts` does
 * that against the durable store. This fixture exists so unrelated commitment/Task/Run persistence
 * scenarios can run without a real grant, while still satisfying the generation-fence contract:
 * every dispatch gets a generation identity, and publication must present the same one.
 */
export class InMemoryTestConsentAuthority implements ConsentAuthority {
  private readonly generations = new Map<
    string,
    { readonly grantId: string; readonly version: number; readonly revoked: boolean }
  >();

  private counter = 0;

  grant(params: { readonly tenantId: Id; readonly sourceProfileId: string }): Promise<void> {
    this.counter += 1;
    this.generations.set(this.key(params.tenantId, params.sourceProfileId), {
      grantId: `test-grant-${this.counter}`,
      version: this.counter,
      revoked: false,
    });

    return Promise.resolve();
  }

  revoke(tenantId: Id, sourceProfileId: string): Promise<void> {
    const current = this.generations.get(this.key(tenantId, sourceProfileId));

    if (current !== undefined) {
      this.generations.set(this.key(tenantId, sourceProfileId), { ...current, revoked: true });
    }

    return Promise.resolve();
  }

  get active(): boolean {
    return [...this.generations.values()].some((entry) => !entry.revoked);
  }

  resolveGeneration(tenantId: Id, sourceProfileId: string): AuthorizedConsentGeneration | null {
    const current = this.generations.get(this.key(tenantId, sourceProfileId));

    if (current === undefined) {
      return null;
    }

    return {
      tenantId,
      sourceProfileId,
      grantId: current.grantId,
      version: current.version,
      status: current.revoked ? 'revoked' : 'active',
      expiresAt: null,
    };
  }

  async assertActive(tenantId: Id, sourceProfileId: string): Promise<void> {
    await this.authorizeFence(tenantId, sourceProfileId);
  }

  authorizeFence(tenantId: Id, sourceProfileId: string): Promise<ConsentAuthorizationFence> {
    // Wrapped in `then` so a missing/revoked grant REJECTS, exactly like the durable authority.
    return Promise.resolve().then(() => this.mintFence(tenantId, sourceProfileId));
  }

  assertFenceCurrent(fence: ConsentAuthorizationFence): Promise<void> {
    return Promise.resolve().then(() => {
      const current = this.mintFence(fence.tenantId, fence.sourceProfileId);

      if (current.grantId !== fence.grantId || current.grantVersion !== fence.grantVersion) {
        throw new DomainError('POLICY_DENIED', 'Test Source Consent generation moved');
      }
    });
  }

  /** Synchronous fence mint, so the async faces above need no database round trip. */
  private mintFence(tenantId: Id, sourceProfileId: string): ConsentAuthorizationFence {
    const generation = this.resolveGeneration(tenantId, sourceProfileId);

    if (generation === null || generation.status !== 'active') {
      throw new DomainError('POLICY_DENIED', 'Test Source Consent is not active');
    }

    return {
      tenantId,
      sourceProfileId,
      grantId: generation.grantId,
      grantVersion: generation.version,
      issuedAt: new Date(0).toISOString(),
      digest: '0'.repeat(64),
    };
  }

  private key(tenantId: Id, sourceProfileId: string): string {
    return `${tenantId}\u0000${sourceProfileId}`;
  }
}

/**
 * Test-only publication gate that shares state with `InMemoryTestConsentAuthority`.
 *
 * It runs inside the PostgreSQL transaction callback but does not read or lock consent rows, so it
 * can express "consent moved" and "consent is gone" but never proves transaction-level behaviour.
 */
export function createTestConsentPublicationGuard(
  authority: InMemoryTestConsentAuthority,
): ConsentPublicationGuard {
  return {
    async authorizeFence(_client, params): Promise<ConsentDispatchFence> {
      const fence = await authority.authorizeFence(params.tenantId, params.sourceProfileId);

      return { grantId: fence.grantId, version: fence.grantVersion };
    },

    async assertFenceCurrent(_client, params): Promise<void> {
      if (params.fence === null) {
        throw new DomainError('POLICY_DENIED', 'No consent generation fence was recorded');
      }

      const current = await authority.authorizeFence(params.tenantId, params.sourceProfileId);

      if (
        current.grantId !== params.fence.grantId ||
        current.grantVersion !== params.fence.version
      ) {
        throw new DomainError('POLICY_DENIED', 'Test Source Consent generation moved');
      }
    },
  };
}

/**
 * Fixed-generation gate for suites that exercise Commitment persistence rather than consent.
 *
 * It is still a FENCE gate: dispatch records `{grantId, version}` and publication must present the
 * same pair, so an occurrence without a recorded generation is refused here too. It just never
 * revokes, which keeps unrelated assertions readable.
 */
export const allowTestConsentPublication: ConsentPublicationGuard = Object.freeze({
  authorizeFence(): Promise<ConsentDispatchFence> {
    return Promise.resolve({ grantId: 'test-consent-generation', version: 1 });
  },
  assertFenceCurrent(_client: unknown, params: ConsentGuardParams): Promise<void> {
    const matches =
      params.fence !== null &&
      params.fence.grantId === 'test-consent-generation' &&
      params.fence.version === 1;

    if (!matches) {
      return Promise.reject(
        new DomainError(
          'POLICY_DENIED',
          'Test occurrence has no matching consent generation fence',
        ),
      );
    }

    return Promise.resolve();
  },
});
