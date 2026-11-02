import {
  FakeConsentRegistry,
  FakeSourceReader,
  FIXTURE_ALERTS_ITEMS,
  FIXTURE_PROFILE_ALERTS,
  FIXTURE_PROFILE_RELEASES,
  FIXTURE_RELEASES_ITEMS,
  GuardedSourceReader,
  InMemorySourceAuditSink,
  type ConsentRegistry,
  type SourceAccessPolicy,
  type SourceProfile,
  type SourceSnapshotItem,
} from '@ember/connectors';
import type { ConsentReadGate, SourceSnapshot, TrustedSourceAccessContext } from '@ember/contracts';
import { DomainError } from '@ember/domain';
import {
  assertFenceMatches,
  consentDenied,
  isConsentFenceAuthority,
  parseConsentFence,
  toConsentDenied,
  type ConsentAuthorizationFence,
  type ConsentFenceAuthority,
  type SourceReaderPort,
} from '@ember/execution';
import type { WorkerLogger } from './logger.js';

/**
 * Marker for the fail-closed placeholder authority.
 *
 * The placeholder is structurally fence-capable (it rejects everything), so a structural check
 * cannot tell it apart from a real durable authority. Startup gates therefore test this brand
 * explicitly instead of inferring readiness from the shape of the object.
 */
const UNAVAILABLE_CONSENT_AUTHORITY: unique symbol = Symbol('ember.worker.consent.unavailable');

export interface UnavailableConsentAuthority extends ConsentFenceAuthority {
  readonly [UNAVAILABLE_CONSENT_AUTHORITY]: true;
}

export interface CommitmentSourceReaderOptions {
  /**
   * Authoritative async consent verifier. Production must supply Lane C's durable implementation;
   * until it exists, the Worker composition root injects a deny-all authority.
   */
  readonly consent: ConsentReadGate | ConsentFenceAuthority;
  readonly logger?: WorkerLogger;
}

/**
 * Fail-closed placeholder for the missing Lane C durable consent implementation.
 * The production composition root uses it until Lane C supplies a persistent authority; tests
 * may inject a deterministic authority explicitly, but it is never backed by caller state.
 *
 * It implements the full fenced contract so that no caller can mistake "Consent is unavailable"
 * for "Consent is a legacy boolean check": every entry point rejects with `POLICY_DENIED`.
 */
export function createUnavailableConsentAuthority(): UnavailableConsentAuthority {
  const denied = (): Promise<never> =>
    Promise.reject(
      new DomainError('POLICY_DENIED', 'Durable source consent authority is not configured'),
    );

  return Object.freeze({
    [UNAVAILABLE_CONSENT_AUTHORITY]: true as const,
    assertActive: denied,
    authorizeFence: denied,
    assertFenceCurrent: denied,
  });
}

/** True only for the deny-all placeholder produced by `createUnavailableConsentAuthority`. */
export function isUnavailableConsentAuthority(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  return (value as Record<symbol, unknown>)[UNAVAILABLE_CONSENT_AUTHORITY] === true;
}

const FIXTURE_ITEMS = new Map<string, readonly SourceSnapshotItem[]>([
  [FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_RELEASES_ITEMS],
  [FIXTURE_PROFILE_ALERTS.sourceProfileId, FIXTURE_ALERTS_ITEMS],
]);

const TEMPLATE_PROFILES: readonly SourceProfile[] = [
  FIXTURE_PROFILE_RELEASES,
  FIXTURE_PROFILE_ALERTS,
];

interface TenantReader {
  readonly reader: GuardedSourceReader;
  readonly registry: ConsentRegistry;
}

/**
 * Tenant-scoped, consent-first `SourceReader` for the Worker runtime.
 *
 * Lane C's `GuardedSourceReader` is per-tenant by construction (`tenantId` on the profile and
 * the policy), while a Worker serves many tenants. This adapter builds one guarded reader per
 * tenant from Lane C's deterministic fixtures and mirrors the injected consent verdict into
 * Lane C's process-local registry, so:
 *
 * - the injected authority is checked before and after every read;
 * - Lane C's `FakeConsentRegistry` remains only the connector boundary adapter;
 * - the pre-read and post-read gates of P0C3-C §5.2 both run;
 * - zero network access is possible (Lane C fixtures only, no real connectors).
 */
export class CommitmentSourceReader implements SourceReaderPort {
  private readonly consent: ConsentReadGate | ConsentFenceAuthority;
  private readonly logger?: WorkerLogger;
  private readonly inner: FakeSourceReader;
  private readonly tenants = new Map<string, TenantReader>();

  constructor(options: CommitmentSourceReaderOptions) {
    this.consent = options.consent;
    this.logger = options.logger;
    this.inner = new FakeSourceReader({ fixtureMap: FIXTURE_ITEMS });
  }

  async readSnapshot(
    profileId: string,
    trustedContext: TrustedSourceAccessContext,
    signal: AbortSignal,
    fence?: ConsentAuthorizationFence,
  ): Promise<SourceSnapshot> {
    this.throwIfAborted(signal, 'before consent verification');

    await this.verifyConsent(profileId, trustedContext, fence);

    const tenant = this.readerFor(trustedContext.tenantId);
    this.mirrorConsent(tenant.registry, trustedContext.tenantId, profileId, true);

    this.throwIfAborted(signal, 'after consent verification');

    const snapshot = await tenant.reader.readSnapshot(profileId, trustedContext, signal);

    this.throwIfAborted(signal, 'after the source read');

    try {
      // Re-verify the *same* authorization after the read. Passing the fence down keeps a
      // re-granted profile from validating a snapshot that was read under the old grant.
      await this.verifyConsent(profileId, trustedContext, fence);
    } catch (error) {
      this.mirrorConsent(tenant.registry, trustedContext.tenantId, profileId, false);
      this.logger?.warn?.('Consent revoked while the source snapshot was in flight', {
        tenantId: trustedContext.tenantId,
        sourceProfileId: profileId,
      });
      throw toConsentDenied(
        error,
        error instanceof DomainError ? error.message : 'consent is no longer active',
      );
    }

    this.throwIfAborted(signal, 'before returning the source snapshot');

    return snapshot;
  }

  /**
   * Consent verification at one read boundary.
   *
   * With a fence, the check is a *versioned* comparison: the reader must be able to ask the
   * authority whether the exact grant version that authorized this read is still current. A
   * reader wired to an authority that cannot do that fails closed instead of downgrading to a
   * boolean verdict.
   */
  private async verifyConsent(
    profileId: string,
    trustedContext: TrustedSourceAccessContext,
    fence: ConsentAuthorizationFence | undefined,
  ): Promise<void> {
    try {
      if (fence !== undefined) {
        if (!isConsentFenceAuthority(this.consent)) {
          throw consentDenied(
            'Consent authority cannot verify the versioned authorization fence of this read',
          );
        }

        const parsed = parseConsentFence(fence);

        assertFenceMatches(parsed, {
          tenantId: trustedContext.tenantId,
          sourceProfileId: profileId,
        });

        await this.consent.assertFenceCurrent(parsed);
        return;
      }

      await this.consent.assertActive(trustedContext.tenantId, profileId);
    } catch (error) {
      throw toConsentDenied(error, 'Source Consent is not active for this source profile');
    }
  }

  private readerFor(tenantId: string): TenantReader {
    const existing = this.tenants.get(tenantId);

    if (existing !== undefined) {
      return existing;
    }

    const profiles = new Map<string, SourceProfile>();
    for (const template of TEMPLATE_PROFILES) {
      profiles.set(template.sourceProfileId, Object.freeze({ ...template, tenantId }));
    }

    const policy: SourceAccessPolicy = {
      version: 1,
      tenantId,
      allowedSourceProfileIds: [...profiles.keys()],
      allowedOperations: ['read_snapshot'],
      defaultAction: 'deny',
    };

    const registry = new FakeConsentRegistry();
    const reader = new GuardedSourceReader({
      reader: this.inner,
      registry,
      profiles,
      policy,
      auditSink: new InMemorySourceAuditSink(),
    });

    const tenant = { reader, registry };
    this.tenants.set(tenantId, tenant);
    return tenant;
  }

  /** Mirror the durable consent verdict into Lane C's process-local registry. */
  private mirrorConsent(
    registry: ConsentRegistry,
    tenantId: string,
    sourceProfileId: string,
    active: boolean,
  ): void {
    try {
      if (active) {
        registry.grant({ tenantId, sourceProfileId });
      } else {
        registry.revoke(tenantId, sourceProfileId);
      }
    } catch {
      // The mirror is best-effort: the database remains the authority for every read.
    }
  }

  private throwIfAborted(signal: AbortSignal, stage: string): void {
    if (signal.aborted) {
      throw new DomainError('CANCELLED', `Source read was cancelled ${stage}`);
    }
  }
}
