import {
  FakeSourceReader,
  FIXTURE_ALERTS_ITEMS,
  FIXTURE_PROFILE_ALERTS,
  FIXTURE_PROFILE_RELEASES,
  FIXTURE_RELEASES_ITEMS,
  GuardedSourceReader,
  InMemorySourceAuditSink,
  type ConsentAuthority,
  type ConsentGrant,
  type ConsentRegistry,
  type SourceAccessPolicy,
  type SourceProfile,
  type SourceSnapshot,
  type SourceSnapshotItem,
  type TrustedSourceAccessContext,
} from '@ember/connectors';
import { DomainError } from '@ember/domain';
import {
  consentDenied,
  isConsentAuthority,
  isConsentFenceAuthority,
  toConsentDenied,
  type ConsentAuthorizationFence,
  type ConsentFenceAuthority,
  type ConsentGrantSource,
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
   * Authoritative async consent verifier. Production must supply the durable implementation; until
   * it is merged, the Worker composition root injects a deny-all authority.
   */
  readonly consent: ConsentAuthority | ConsentFenceAuthority;
  /**
   * Authoritative grant read used as the connector boundary's policy source.
   *
   * This must be the SAME persistence the authority resolves generations from: the connector
   * evaluates `allowedOperations`/`scopes` against `registry.get()`, so a Worker-side copy (a
   * "mirror") would let the boundary authorize a read from terms the durable record never
   * approved. When it is absent, every read is denied instead of being served from a local guess.
   */
  readonly grants?: ConsentGrantSource;
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
    // Canonical C3C generation read. It rejects rather than returning `null` so an unconfigured
    // deployment can never be mistaken for "this tenant simply has no grant".
    resolveGeneration: denied,
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

interface TenantScope {
  readonly profiles: ReadonlyMap<string, SourceProfile>;
  readonly policy: SourceAccessPolicy;
}

/**
 * Tenant-scoped, consent-first `SourceReader` for the Worker runtime.
 *
 * Lane C's `GuardedSourceReader` is per-tenant by construction (`tenantId` on the profile and the
 * policy), while a Worker serves many tenants. This adapter builds a guarded reader per READ and
 * binds it to:
 *
 * - the SAME authoritative generation source the Worker gates use (`authority`), plus
 *   `requireAuthorizationFence`, so the canonical pre- and post-read gates of P0C3-C §5.2 run on
 *   the fence carried by `TrustedSourceAccessContext`;
 * - a snapshot of the authoritative grant record (`grants`), read fresh for this attempt and
 *   generation-bound by the fence. The connector evaluates `allowedOperations`/`scopes` against
 *   that record, so the policy inputs are the durable ones — never a Worker default and never a
 *   stale local copy from an earlier attempt;
 * - zero network access (Lane C fixtures only, no real connectors).
 *
 * Before the connector is called, the Worker additionally re-verifies the fence itself and refuses
 * a read the verified grant does not cover, and it repeats that verification after the read. That
 * is deliberately redundant: the Worker must not depend on the connector's policy engine to catch
 * a scope it never had, nor on it to notice a revocation that landed mid-read.
 */
export class CommitmentSourceReader implements SourceReaderPort {
  private readonly consent: ConsentAuthority | ConsentFenceAuthority;
  private readonly grants?: ConsentGrantSource;
  private readonly logger?: WorkerLogger;
  private readonly inner: FakeSourceReader;
  private readonly scopes = new Map<string, TenantScope>();

  constructor(options: CommitmentSourceReaderOptions) {
    this.consent = options.consent;
    this.grants = options.grants;
    this.logger = options.logger;
    this.inner = new FakeSourceReader({ fixtureMap: FIXTURE_ITEMS });
  }

  async readSnapshot(
    profileId: string,
    trustedContext: TrustedSourceAccessContext,
    signal: AbortSignal,
  ): Promise<SourceSnapshot> {
    this.throwIfAborted(signal, 'before consent verification');

    // The fence arrives inside the canonical trusted context: that is the authorization the
    // orchestrator minted for THIS attempt. A read without one has nothing to bind to.
    const fence = trustedContext.authorizationFence;

    if (fence === undefined) {
      throw consentDenied('Source read has no versioned Consent authorization fence');
    }

    const authorization = await this.verifyConsent(profileId, trustedContext, fence);

    // The connector boundary authorizes a read from `grant.allowedOperations`, so an authorization
    // that does not cover this operation must stop here instead of reaching the policy engine at
    // all.
    if (!authorization.allowedOperations.includes(SOURCE_READ_OPERATION)) {
      throw consentDenied(
        'Consent grant does not authorize a source snapshot read for this source profile',
      );
    }

    const grant = await this.readGrant(profileId, trustedContext);
    const tenant = this.readerFor(trustedContext.tenantId, grant);

    this.throwIfAborted(signal, 'after consent verification');

    const snapshot = await tenant.readSnapshot(profileId, trustedContext, signal);

    this.throwIfAborted(signal, 'after the source read');

    try {
      // Re-verify the *same* authorization after the read: a re-grant or revocation that landed
      // while the snapshot was in flight discards it instead of returning work that was read under
      // a generation which no longer exists.
      const latest = await this.verifyConsent(profileId, trustedContext, fence);

      if (!latest.allowedOperations.includes(SOURCE_READ_OPERATION)) {
        throw consentDenied(
          'Consent grant no longer authorizes a source snapshot read for this source profile',
        );
      }
    } catch (error) {
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
    fence: ConsentAuthorizationFence,
  ): Promise<ConsentReadAuthorization> {
    try {
      if (!isConsentFenceAuthority(this.consent)) {
        throw consentDenied(
          'Consent authority cannot verify the versioned authorization fence of this read',
        );
      }

      // The expected lineage comes from the trusted context, never from the fence: a fence from
      // another tenant or profile is rejected by the canonical validator (`TENANT_MISMATCH`).
      return await this.consent.assertFenceCurrent(fence, {
        tenantId: trustedContext.tenantId,
        sourceProfileId: profileId,
      });
    } catch (error) {
      throw toConsentDenied(error, 'Source Consent is not active for this source profile');
    }
  }

  /**
   * Builds the guarded reader for ONE read.
   *
   * The reader is not cached per tenant because the grant snapshot it evaluates policy against is
   * per attempt: sharing a mutable registry across concurrent reads of the same tenant could let
   * one attempt's grant answer another attempt's fence.
   */
  private readerFor(tenantId: string, grant: ConsentGrant): GuardedSourceReader {
    // Both halves of the authorization are mandatory at the connector boundary: the generation
    // source AND the grant the policy is evaluated against. Missing either one is a configuration
    // error that must deny the read, not a reason to read without consent.
    if (!isConsentAuthority(this.consent)) {
      throw consentDenied('Source read requires an authoritative Consent generation source');
    }

    const scope = this.scopeFor(tenantId);

    return new GuardedSourceReader({
      reader: this.inner,
      registry: snapshotRegistry(grant),
      profiles: scope.profiles,
      policy: scope.policy,
      auditSink: new InMemorySourceAuditSink(),
      authority: this.consent,
      // The orchestrator always attaches a fence, so a fence-less read is a defect, not a legacy
      // path: refuse it at the connector boundary too.
      requireAuthorizationFence: true,
    });
  }

  /** Per-tenant profile catalog and policy. Pure data, safe to cache across reads. */
  private scopeFor(tenantId: string): TenantScope {
    const existing = this.scopes.get(tenantId);

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

    const scope = { profiles, policy };
    this.scopes.set(tenantId, scope);
    return scope;
  }

  /**
   * Reads the authoritative grant this read is evaluated against.
   *
   * No fallback exists: an absent store or record denies the read. The returned record is bound to
   * the fence by `GuardedSourceReader` (`validateConsentGenerationBinding`), so a stale snapshot
   * cannot be used to authorize a newer generation.
   */
  private async readGrant(
    profileId: string,
    trustedContext: TrustedSourceAccessContext,
  ): Promise<ConsentGrant> {
    if (this.grants === undefined) {
      throw consentDenied(
        'Source read requires the authoritative Consent grant store to evaluate policy',
      );
    }

    let grant: ConsentGrant | null;

    try {
      grant = await this.grants.get(trustedContext.tenantId, profileId);
    } catch (error) {
      throw toConsentDenied(error, 'Source Consent grant could not be read');
    }

    if (grant === null || typeof grant !== 'object') {
      throw consentDenied('Source Consent grant is missing for this source profile');
    }

    return grant;
  }

  private throwIfAborted(signal: AbortSignal, stage: string): void {
    if (signal.aborted) {
      throw new DomainError('CANCELLED', `Source read was cancelled ${stage}`);
    }
  }
}

/**
 * Presents ONE authoritatively read grant record as the connector's `ConsentRegistry`.
 *
 * `GuardedSourceReader` evaluates policy (`allowedOperations`, `scopes`) against
 * `registry.get()`. Serving that from the durable record — read for this attempt, and bound to the
 * fence by the canonical generation-binding check — is what keeps the policy inputs real: there is
 * no default and no cross-attempt copy left to fabricate, widen or forget to revoke.
 *
 * The mutating half of the port is refused: the Worker may not write Consent through the read path.
 */
function snapshotRegistry(grant: ConsentGrant): ConsentRegistry {
  const refuse = (): never => {
    throw consentDenied('The Worker may not write Consent through the source-read boundary');
  };

  return {
    get: (tenantId: string, sourceProfileId: string): ConsentGrant => {
      if (grant.tenantId !== tenantId || grant.sourceProfileId !== sourceProfileId) {
        return refuse();
      }

      return grant;
    },
    grant: refuse,
    revoke: refuse,
    list: (): readonly ConsentGrant[] => [grant],
    clear: (): void => undefined,
  };
}
