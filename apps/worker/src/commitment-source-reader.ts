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
import {
  assertFenceMatches,
  consentDenied,
  isConsentFenceAuthority,
  parseConsentFence,
  toConsentDenied,
  type ConsentAuthorizationFence,
  type ConsentFenceAuthority,
  type ConsentReadAuthorization,
  type SourceReaderPort,
} from '@ember/execution';
import type { WorkerLogger } from './logger.js';

/**
 * The only operation this Worker performs against a Source Profile.
 *
 * `evaluateSourceAccess` authorizes a read from `grant.allowedOperations`, so the operation the
 * Worker asks for and the operation it mirrors into the registry have to be the same constant.
 */
const SOURCE_READ_OPERATION = 'read_snapshot';

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
  readonly consent: ConsentAuthority | ConsentFenceAuthority;
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
 * tenant from Lane C's deterministic fixtures and mirrors the *authorized operations* of the
 * resolved consent generation into Lane C's process-local registry, so:
 *
 * - the injected authority is checked before and after every read;
 * - the mirrored grant carries exactly the operations the durable Consent record approved, never
 *   a Worker default (a read the grant does not cover is refused before the connector is called);
 * - Lane C's `FakeConsentRegistry` remains only the connector boundary adapter;
 * - the pre-read and post-read gates of P0C3-C §5.2 both run;
 * - zero network access is possible (Lane C fixtures only, no real connectors).
 */
export class CommitmentSourceReader implements SourceReaderPort {
  private readonly consent: ConsentAuthority | ConsentFenceAuthority;
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

    const authorization = await this.verifyConsent(profileId, trustedContext, fence);

    // The connector boundary authorizes a read from `grant.allowedOperations`, so an authorization
    // that does not cover this operation must stop here instead of being mirrored and retried by
    // the policy engine with a fabricated default.
    if (!authorization.allowedOperations.includes(SOURCE_READ_OPERATION)) {
      throw consentDenied(
        'Consent grant does not authorize a source snapshot read for this source profile',
      );
    }

    const tenant = this.readerFor(trustedContext.tenantId);
    this.mirrorAuthorization(tenant.registry, trustedContext.tenantId, profileId, authorization);

    this.throwIfAborted(signal, 'after consent verification');

    const snapshot = await tenant.reader.readSnapshot(profileId, trustedContext, signal);

    this.throwIfAborted(signal, 'after the source read');

    try {
      // Re-verify the *same* authorization after the read. Passing the fence down keeps a
      // re-granted profile from validating a snapshot that was read under the old grant, and the
      // returned operations keep the mirror honest if the grant was replaced mid-read.
      const latest = await this.verifyConsent(profileId, trustedContext, fence);

      if (!latest.allowedOperations.includes(SOURCE_READ_OPERATION)) {
        throw consentDenied(
          'Consent grant no longer authorizes a source snapshot read for this source profile',
        );
      }

      this.mirrorAuthorization(tenant.registry, trustedContext.tenantId, profileId, latest);
    } catch (error) {
      this.revokeMirror(tenant.registry, trustedContext.tenantId, profileId);
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
   * The check is a *versioned* comparison: the reader asks the authority whether the exact grant
   * generation that authorized this read is still current, and gets back the operations that
   * generation approves. A reader wired to an authority that cannot do that fails closed instead
   * of downgrading to a boolean verdict.
   */
  private async verifyConsent(
    profileId: string,
    trustedContext: TrustedSourceAccessContext,
    fence: ConsentAuthorizationFence | undefined,
  ): Promise<ConsentReadAuthorization> {
    try {
      if (fence === undefined) {
        // A verdict-only authority cannot say what the grant authorizes, and mirroring a default
        // would grant `read_snapshot` to a grant that never included it. Refuse the read instead.
        throw consentDenied(
          'Consent authority cannot report the operations authorized for this read',
        );
      }

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

      return await this.consent.assertFenceCurrent(parsed);
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

  /**
   * Mirror the *authorized* operations into Lane C's process-local registry.
   *
   * The mirrored record must describe what the durable Consent record approved. Granting with
   * defaults here would fabricate `read_snapshot` / `source.readonly` for a grant that never
   * included them, and `evaluateSourceAccess` reads exactly those arrays to decide the read.
   */
  private mirrorAuthorization(
    registry: ConsentRegistry,
    tenantId: string,
    sourceProfileId: string,
    authorization: ConsentReadAuthorization,
  ): void {
    try {
      registry.grant({
        tenantId,
        sourceProfileId,
        allowedOperations: [...authorization.allowedOperations],
        scopes: [...authorization.scopes],
      });
    } catch {
      // The mirror is best-effort: the durable authority remains the authority for every read.
      // A failing mirror cannot widen access, because the read has already been checked against
      // `authorization.allowedOperations` and the connector gate re-evaluates the registry.
    }
  }

  /** Withdraw the mirror so a stale local grant cannot authorize a later read. */
  private revokeMirror(registry: ConsentRegistry, tenantId: string, sourceProfileId: string): void {
    try {
      registry.revoke(tenantId, sourceProfileId);
    } catch {
      // Best-effort: an unmirrorable revocation still fails the read closed above.
    }
  }

  private throwIfAborted(signal: AbortSignal, stage: string): void {
    if (signal.aborted) {
      throw new DomainError('CANCELLED', `Source read was cancelled ${stage}`);
    }
  }
}
