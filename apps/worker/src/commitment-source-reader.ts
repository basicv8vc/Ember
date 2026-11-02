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
import type {
  ConsentAuthority,
  SourceSnapshot,
  TrustedSourceAccessContext,
} from '@ember/contracts';
import { DomainError } from '@ember/domain';
import type { SourceReaderPort } from '@ember/execution';
import type { WorkerLogger } from './logger.js';

export interface CommitmentSourceReaderOptions {
  /**
   * Authoritative async consent verifier. Production must supply Lane C's durable implementation;
   * until it exists, the Worker composition root injects a deny-all authority.
   */
  readonly consent: ConsentAuthority;
  readonly logger?: WorkerLogger;
}

/**
 * Fail-closed placeholder for the missing Lane C durable consent implementation.
 * The production composition root uses it until Lane C supplies a persistent authority; tests
 * may inject a deterministic authority explicitly, but it is never backed by caller state.
 */
export function createUnavailableConsentAuthority(): ConsentAuthority {
  return {
    assertActive(): Promise<void> {
      return Promise.reject(
        new DomainError('POLICY_DENIED', 'Durable source consent authority is not configured'),
      );
    },
  };
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
  private readonly consent: ConsentAuthority;
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
  ): Promise<SourceSnapshot> {
    this.throwIfAborted(signal, 'before consent verification');

    await this.consent.assertActive(trustedContext.tenantId, profileId);

    const tenant = this.readerFor(trustedContext.tenantId);
    this.mirrorConsent(tenant.registry, trustedContext.tenantId, profileId, true);

    this.throwIfAborted(signal, 'after consent verification');

    const snapshot = await tenant.reader.readSnapshot(profileId, trustedContext, signal);

    this.throwIfAborted(signal, 'after the source read');

    try {
      await this.consent.assertActive(trustedContext.tenantId, profileId);
    } catch (error) {
      this.mirrorConsent(tenant.registry, trustedContext.tenantId, profileId, false);
      this.logger?.warn?.('Consent revoked while the source snapshot was in flight', {
        tenantId: trustedContext.tenantId,
        sourceProfileId: profileId,
      });
      throw new DomainError(
        'POLICY_DENIED',
        error instanceof DomainError ? error.message : 'consent is no longer active',
      );
    }

    this.throwIfAborted(signal, 'before returning the source snapshot');

    return snapshot;
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
