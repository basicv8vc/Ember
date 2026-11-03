import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeConsentFenceDigest,
  deriveConsentStatus,
  FIXTURE_PROFILE_RELEASES,
  validateConsentAuthorizationFence,
  type AuthorizedConsentGeneration,
  type ConsentGrant,
  type TrustedSourceAccessContext,
} from '@ember/connectors';
import { DomainError, type Id } from '@ember/domain';
import {
  CommitmentOrchestrator,
  createDefaultSentinelPolicy,
  fromResolvedGenerationConsent,
  isConsentAuthority,
  isConsentFenceAuthority,
  type AppendOutcomeCommand,
  type ConsentAuthorizationFence,
  type ConsentFenceAuthority,
  type ConsentGrantSource,
  type ConsentReadAuthorization,
  type OutcomeResultStatus,
  type SourceSnapshot,
  type WorkerLeaseGrant,
} from '@ember/execution';
import {
  evaluateSchedulerConsentGate,
  requireCommitmentConsentAuthority,
} from '../../apps/worker/src/commitment-consent.js';
import {
  CommitmentSourceReader,
  createUnavailableConsentAuthority,
  isUnavailableConsentAuthority,
} from '../../apps/worker/src/commitment-source-reader.js';
import { startCommitmentScheduler } from '../../apps/worker/src/commitment-scheduler-runtime.js';
import type { WorkerConfig } from '../../apps/worker/src/config.js';
import type { WorkerLogger } from '../../apps/worker/src/logger.js';
import type { createPool } from '@ember/postgres';

/**
 * P0-C3B / P0-C3C Consent authorization fence.
 *
 * The Worker authorizes a source read, the read takes time, and the Outcome is published
 * afterwards. These tests pin the property that matters: publication is bound to the *exact*
 * generation that authorized the read, so a revocation or re-grant that lands while the read is in
 * flight discards the work instead of publishing an unattributable Outcome.
 *
 * The fence type, the digest and every validation decision come from `@ember/connectors`
 * (P0-C3C). Nothing here — and nothing in `@ember/execution` — re-implements them.
 */

const SOURCE_PROFILE_ID = FIXTURE_PROFILE_RELEASES.sourceProfileId;
const TENANT_ID = randomUUID();
const LIVE_SIGNAL = new AbortController().signal;
const ISSUED_AT = '2026-11-02T11:59:00.000Z';
const NOW = new Date('2026-11-02T12:00:00.000Z');

const SNAPSHOT: SourceSnapshot = {
  sourceProfileId: SOURCE_PROFILE_ID,
  observedAt: NOW.toISOString(),
  digest: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  boundedSafeItems: [
    {
      id: 'item-1',
      title: 'Release 1.2.0',
      contentSnippet: 'Deterministic fixture item.',
      observedAt: '2026-11-02T11:50:00.000Z',
    },
  ],
};

/** Shared ordering log: proves the gates run in the documented order, not just that they ran. */
interface Recorder {
  readonly events: string[];
}

/** Builds a canonical fence (with digest) for one generation. */
function fenceFor(
  tenantId: string,
  sourceProfileId: string,
  grantId: string,
  grantVersion: number,
  issuedAt: string = ISSUED_AT,
): ConsentAuthorizationFence {
  const body = { tenantId, sourceProfileId, grantId, grantVersion, issuedAt };
  return Object.freeze({ ...body, digest: computeConsentFenceDigest(body) });
}

/**
 * Fenced authority double, shaped after the canonical P0-C3C contract.
 *
 * `grantId` + `version` model the durable store's authorization generation: bumping either is
 * exactly what a revoke-plus-regrant looks like to the Worker. A verdict-only double cannot
 * express this, which is the whole point of the fence.
 *
 * It validates through the canonical helper rather than re-deriving the rules, so the double and
 * production agree on what "stale", "revoked" and "tampered" mean.
 */
class ScriptedConsent implements ConsentFenceAuthority {
  public version = 1;
  public grantId = 'grant-primary';
  public active = true;
  public authorizeCalls = 0;
  public assertFenceCurrentCalls = 0;
  /** Operations the durable grant approves. Read access requires `read_snapshot`. */
  public allowedOperations: readonly string[] = ['read_snapshot'];
  /** Scopes the durable grant approves. Mirrored verbatim, never defaulted by the Worker. */
  public scopes: readonly string[] = ['source.readonly'];
  /** Number of `assertFenceCurrent` calls that may succeed before the grant is reported stale. */
  public fenceCurrentSucceeds = Number.POSITIVE_INFINITY;
  /** Issuance counter: every attempt mints its own fence, so distinct attempts differ. */
  private issued = 0;

  constructor(
    private readonly recorder: Recorder,
    private readonly tenantId: Id = TENANT_ID,
  ) {}

  resolveGeneration(tenantId: string, sourceProfileId: string): AuthorizedConsentGeneration | null {
    if (tenantId !== this.tenantId || sourceProfileId !== SOURCE_PROFILE_ID) {
      return null;
    }

    return {
      tenantId: this.tenantId,
      sourceProfileId: SOURCE_PROFILE_ID,
      grantId: this.grantId,
      version: this.version,
      status: this.active ? 'active' : 'revoked',
      expiresAt: null,
    };
  }

  grantFence(sourceProfileId: string = SOURCE_PROFILE_ID): ConsentAuthorizationFence {
    return fenceFor(this.tenantId, sourceProfileId, this.grantId, this.version);
  }

  authorizeFence(tenantId: Id, sourceProfileId: string): Promise<ConsentAuthorizationFence> {
    this.authorizeCalls++;
    this.issued++;
    this.recorder.events.push('consent.authorizeFence');

    if (!this.active) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Source Consent is not active'));
    }

    return Promise.resolve(
      fenceFor(tenantId, sourceProfileId, this.grantId, this.version, this.issuedAt()),
    );
  }

  assertFenceCurrent(
    fence: ConsentAuthorizationFence,
    expected: { readonly tenantId: Id; readonly sourceProfileId: string },
  ): Promise<ConsentReadAuthorization> {
    this.assertFenceCurrentCalls++;
    this.recorder.events.push('consent.assertFenceCurrent');

    if (this.assertFenceCurrentCalls > this.fenceCurrentSucceeds) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Source Consent was revoked'));
    }

    const validation = validateConsentAuthorizationFence({
      fence,
      tenantId: expected.tenantId,
      sourceProfileId: expected.sourceProfileId,
      authoritative: this.resolveGeneration(expected.tenantId, expected.sourceProfileId),
      now: NOW,
    });

    if (!validation.valid) {
      return Promise.reject(
        new DomainError('POLICY_DENIED', `Source Consent fence rejected: ${validation.code}`),
      );
    }

    return Promise.resolve({
      allowedOperations: [...this.allowedOperations],
      scopes: [...this.scopes],
    });
  }

  assertActive(tenantId: Id, sourceProfileId: string): Promise<void> {
    this.recorder.events.push('consent.assertActive');

    if (this.resolveGeneration(tenantId, sourceProfileId)?.status !== 'active') {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Source Consent is not active'));
    }

    return Promise.resolve();
  }

  private issuedAt(): string {
    return new Date(NOW.getTime() - 60_000 + this.issued * 1_000).toISOString();
  }
}

/** Minimal legacy authority: verdict only, no generation. Must never satisfy the fence contract. */
const legacyConsent = {
  assertActive(): Promise<void> {
    return Promise.resolve();
  },
};

class RecordingStore {
  public appendCallCount = 0;

  constructor(private readonly recorder: Recorder) {}

  findAuthoritativeOutcome(): Promise<{
    readonly resultStatus: OutcomeResultStatus;
    readonly summary: string;
  } | null> {
    this.recorder.events.push('store.findOutcome');
    return Promise.resolve(null);
  }

  appendOutcomeIfAbsent(_grant: WorkerLeaseGrant, _cmd: AppendOutcomeCommand): Promise<boolean> {
    this.recorder.events.push('store.appendOutcome');
    this.appendCallCount++;
    return Promise.resolve(true);
  }
}

class RecordingSourceReader {
  public readCalls = 0;
  public readonly receivedFences: Array<ConsentAuthorizationFence | undefined> = [];
  public readonly receivedEpochs: number[] = [];

  constructor(
    private readonly recorder: Recorder,
    private readonly onRead?: () => void,
  ) {}

  readSnapshot(
    _profileId: string,
    trustedContext: TrustedSourceAccessContext,
    _signal: AbortSignal,
  ): Promise<SourceSnapshot> {
    this.recorder.events.push('source.read');
    this.readCalls++;
    // The fence has to arrive inside the canonical trusted context: this is what the connector
    // boundary validates, so a reader that receives it any other way is not conformant.
    this.receivedFences.push(trustedContext.authorizationFence);
    this.receivedEpochs.push(trustedContext.leaseEpoch);
    this.onRead?.();
    return Promise.resolve(SNAPSHOT);
  }
}

function buildGrant(attempt = 1, leaseEpoch = 1): WorkerLeaseGrant {
  return {
    tenantId: TENANT_ID,
    taskId: randomUUID(),
    runId: randomUUID(),
    attempt,
    leaseEpoch,
    workerId: 'worker-fence-test',
  };
}

function buildContext() {
  return {
    tenantId: TENANT_ID,
    agentId: randomUUID(),
    commitmentId: randomUUID(),
    occurrenceId: randomUUID(),
    sourceProfileId: SOURCE_PROFILE_ID,
    scheduleKind: 'once' as const,
    policyVersion: 1,
    // P0-C3D: the Occurrence's persisted generation is what execution is bound to. The orchestrator
    // refuses an Occurrence that records none, and refuses one whose generation the authority no
    // longer reports — so every fence assertion below is decided against this identity, not
    // against today's grant.
    consentGeneration: { grantId: 'grant-primary', version: 1 },
  };
}

function trustedContext(
  tenantId: Id = TENANT_ID,
  fence?: ConsentAuthorizationFence,
): TrustedSourceAccessContext {
  return {
    tenantId,
    commitmentId: randomUUID(),
    taskId: randomUUID(),
    runId: randomUUID(),
    leaseEpoch: 1,
    authorizedAt: NOW.toISOString(),
    ...(fence === undefined ? {} : { authorizationFence: fence }),
  };
}

function placeholderFence(): ConsentAuthorizationFence {
  return fenceFor(TENANT_ID, SOURCE_PROFILE_ID, 'grant-primary', 1);
}

function buildOrchestrator(options: {
  readonly store: RecordingStore;
  readonly sourceReader: RecordingSourceReader;
  readonly consent?: ConsentFenceAuthority;
}): CommitmentOrchestrator {
  return new CommitmentOrchestrator({
    store: options.store,
    sourceReader: options.sourceReader,
    sentinelPolicy: createDefaultSentinelPolicy({
      policyId: 'fence-test-policy',
      policyVersion: 1,
      tenantId: TENANT_ID,
      allowedActions: ['mock.read', 'mock.compute'],
    }),
    ...(options.consent === undefined ? {} : { consent: options.consent }),
  });
}

/** Presents the scripted authority's grant as the connector-boundary policy source. */
function grantsOf(consent: ScriptedConsent): ConsentGrantSource {
  return {
    get(tenantId: string, sourceProfileId: string): ConsentGrant | null {
      if (tenantId !== TENANT_ID || sourceProfileId !== SOURCE_PROFILE_ID) {
        return null;
      }

      return {
        grantId: consent.grantId,
        tenantId,
        sourceProfileId,
        status: consent.active ? 'active' : 'revoked',
        allowedOperations: [...consent.allowedOperations],
        scopes: [...consent.scopes],
        grantedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: null,
        revokedAt: consent.active ? null : '2026-11-01T12:00:00.000Z',
        version: consent.version,
      };
    },
  };
}

const policyDenied = (): Error => {
  const matcher: unknown = expect.objectContaining({ code: 'POLICY_DENIED' });
  return matcher as Error;
};

describe('P0-C3B: versioned Consent authorization fence', () => {
  it('captures the fence before the read and re-verifies it immediately before publication', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const store = new RecordingStore(recorder);
    const sourceReader = new RecordingSourceReader(recorder);

    const orchestrator = buildOrchestrator({ store, sourceReader, consent });

    const result = await orchestrator.execute(buildGrant(), buildContext(), LIVE_SIGNAL);

    expect(result.outcomeCommitted).toBe(true);

    // Ordering invariant: authorize -> read -> re-verify -> publish.
    expect(recorder.events).toEqual([
      'store.findOutcome',
      'consent.authorizeFence',
      'source.read',
      'consent.assertFenceCurrent',
      'store.appendOutcome',
    ]);

    // The reader is handed the *same* generation that authorized the read, inside the canonical
    // trusted context, never as a fresh verdict or an extra argument.
    expect(sourceReader.receivedFences[0]?.grantId).toBe(consent.grantId);
    expect(sourceReader.receivedFences[0]?.grantVersion).toBe(1);
    expect(sourceReader.receivedFences[0]?.sourceProfileId).toBe(SOURCE_PROFILE_ID);
    // The fence always carries the canonical digest, and it validates against the authority.
    expect(sourceReader.receivedFences[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      validateConsentAuthorizationFence({
        fence: sourceReader.receivedFences[0],
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
        authoritative: consent.resolveGeneration(TENANT_ID, SOURCE_PROFILE_ID),
        now: NOW,
      }).valid,
    ).toBe(true);
  });

  it('discards the outcome when consent is revoked while the source read is in flight', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const store = new RecordingStore(recorder);

    // The read succeeds and then the grant is revoked before the re-verification: this is the
    // exact race the fence exists for.
    const sourceReader = new RecordingSourceReader(recorder, () => {
      consent.active = false;
    });

    const orchestrator = buildOrchestrator({ store, sourceReader, consent });

    await expect(
      orchestrator.execute(buildGrant(), buildContext(), LIVE_SIGNAL),
    ).rejects.toThrowError(policyDenied());

    expect(sourceReader.readCalls).toBe(1);
    expect(store.appendCallCount).toBe(0);
    expect(recorder.events).not.toContain('store.appendOutcome');
  });

  it('discards the outcome when the grant is re-issued with a new version mid-flight', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const store = new RecordingStore(recorder);

    // A re-grant leaves Consent active, so a boolean check would still pass. Only the generation
    // comparison can tell that the read was authorized under a different grant.
    const sourceReader = new RecordingSourceReader(recorder, () => {
      consent.version = 2;
    });

    const orchestrator = buildOrchestrator({ store, sourceReader, consent });

    await expect(
      orchestrator.execute(buildGrant(), buildContext(), LIVE_SIGNAL),
    ).rejects.toThrowError(policyDenied());

    expect(store.appendCallCount).toBe(0);
  });

  it('mints a distinct fence for every attempt and never reuses one across attempts', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const store = new RecordingStore(recorder);
    const sourceReader = new RecordingSourceReader(recorder);

    const orchestrator = buildOrchestrator({ store, sourceReader, consent });

    await orchestrator.execute(buildGrant(1, 1), buildContext(), LIVE_SIGNAL);
    await orchestrator.execute(buildGrant(2, 2), buildContext(), LIVE_SIGNAL);

    expect(consent.authorizeCalls).toBe(2);
    expect(sourceReader.receivedFences).toHaveLength(2);
    expect(sourceReader.receivedEpochs).toEqual([1, 2]);

    const [first, second] = sourceReader.receivedFences;
    // A retry is a NEW attempt: it must carry its own authorization, not the previous one.
    expect(second).not.toEqual(first);
    expect(second?.issuedAt).not.toBe(first?.issuedAt);
    expect(second?.digest).not.toBe(first?.digest);
  });

  it('refuses to publish attempt N+1 under the fence of attempt N', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const store = new RecordingStore(recorder);

    const orchestrator = buildOrchestrator({
      store,
      sourceReader: new RecordingSourceReader(recorder),
      consent,
    });

    await orchestrator.execute(buildGrant(1, 1), buildContext(), LIVE_SIGNAL);
    const capturedFence = await consent.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);

    // Revoke + re-grant between attempts: the captured authorization is now a dead generation.
    consent.grantId = 'grant-regranted';
    consent.version = 2;

    await expect(
      consent.assertFenceCurrent(capturedFence, {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      }),
    ).rejects.toThrowError(policyDenied());
  });

  it('rejects a verdict-only consent dependency at construction instead of at publication', () => {
    const recorder: Recorder = { events: [] };
    const store = new RecordingStore(recorder);
    const sourceReader = new RecordingSourceReader(recorder);

    expect(() =>
      buildOrchestrator({
        store,
        sourceReader,
        // A verdict-only authority cannot attribute an Outcome to a generation.
        consent: legacyConsent as unknown as ConsentFenceAuthority,
      }),
    ).toThrowError(policyDenied());

    expect(sourceReader.readCalls).toBe(0);
    expect(store.appendCallCount).toBe(0);
  });
});

describe('P0-C3B: fence re-verification inside the source reader', () => {
  it('reads only with the fence carried by the canonical trusted context', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent, grants: grantsOf(consent) });

    const snapshot = await reader.readSnapshot(
      SOURCE_PROFILE_ID,
      trustedContext(TENANT_ID, consent.grantFence()),
      LIVE_SIGNAL,
    );

    expect(snapshot.sourceProfileId).toBe(SOURCE_PROFILE_ID);
    expect(consent.assertFenceCurrentCalls).toBe(2);
  });

  it('denies a read whose trusted context carries no fence (0 reader callbacks)', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent, grants: grantsOf(consent) });

    await expect(
      reader.readSnapshot(SOURCE_PROFILE_ID, trustedContext(TENANT_ID), LIVE_SIGNAL),
    ).rejects.toThrowError(policyDenied());

    expect(consent.assertFenceCurrentCalls).toBe(0);
    expect(consent.authorizeCalls).toBe(0);
  });

  it('denies the read when the fence names another tenant (0 reader callbacks)', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent, grants: grantsOf(consent) });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(randomUUID(), {
          ...consent.grantFence(),
          tenantId: randomUUID(),
        }),
        LIVE_SIGNAL,
      ),
    ).rejects.toThrowError(policyDenied());

    expect(consent.assertFenceCurrentCalls).toBe(1);
  });

  it('denies the read when the trusted context belongs to another tenant', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent, grants: grantsOf(consent) });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(randomUUID(), consent.grantFence()),
        LIVE_SIGNAL,
      ),
    ).rejects.toThrowError(policyDenied());

    expect(consent.assertFenceCurrentCalls).toBe(1);
  });

  it('denies the read when the fence names another source profile', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent, grants: grantsOf(consent) });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(TENANT_ID, consent.grantFence('sp_some_other_profile')),
        LIVE_SIGNAL,
      ),
    ).rejects.toThrowError(policyDenied());

    expect(consent.assertFenceCurrentCalls).toBe(1);
  });

  it('refuses a fence-aware read from an authority that cannot verify fences', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent: legacyConsent as never });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(TENANT_ID, consent.grantFence()),
        LIVE_SIGNAL,
      ),
    ).rejects.toThrowError(policyDenied());
  });

  it('rejects a snapshot whose consent went stale between the two read gates', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    // First verification passes, the post-read verification reports a revocation.
    consent.fenceCurrentSucceeds = 1;

    const reader = new CommitmentSourceReader({ consent, grants: grantsOf(consent) });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(TENANT_ID, consent.grantFence()),
        LIVE_SIGNAL,
      ),
    ).rejects.toThrowError(policyDenied());

    expect(consent.assertFenceCurrentCalls).toBe(2);
  });

  it('denies a read the durable grant does not authorize, without fabricating the operation', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    // The grant is active for this profile, but it authorizes metadata only. The previous mirror
    // granted `read_snapshot` by default, so this read used to succeed.
    consent.allowedOperations = ['read_metadata'];

    const reader = new CommitmentSourceReader({ consent, grants: grantsOf(consent) });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(TENANT_ID, consent.grantFence()),
        LIVE_SIGNAL,
      ),
    ).rejects.toThrowError(policyDenied());

    // Pre-read gate only: the connector is never reached, so nothing is read under the grant.
    expect(consent.assertFenceCurrentCalls).toBe(1);
  });

  it('reads when the durable grant authorizes read_snapshot', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    consent.allowedOperations = ['read_snapshot', 'read_metadata'];
    consent.scopes = ['source.readonly', 'source.metadata'];

    const reader = new CommitmentSourceReader({ consent, grants: grantsOf(consent) });

    const snapshot = await reader.readSnapshot(
      SOURCE_PROFILE_ID,
      trustedContext(TENANT_ID, consent.grantFence()),
      LIVE_SIGNAL,
    );

    expect(snapshot.sourceProfileId).toBe(SOURCE_PROFILE_ID);
    expect(consent.assertFenceCurrentCalls).toBe(2);
  });
});

describe('P0-C3B: deny-all Consent placeholder', () => {
  it('is fence-shaped, branded, and rejects every entry point', async () => {
    const placeholder = createUnavailableConsentAuthority();

    expect(isConsentFenceAuthority(placeholder)).toBe(true);
    expect(isConsentAuthority(placeholder)).toBe(true);
    expect(isUnavailableConsentAuthority(placeholder)).toBe(true);
    expect(isUnavailableConsentAuthority(createUnavailableConsentAuthority())).toBe(true);
    expect(isUnavailableConsentAuthority(legacyConsent)).toBe(false);

    await expect(placeholder.resolveGeneration(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
    await expect(placeholder.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
    await expect(
      placeholder.assertFenceCurrent(placeholderFence(), {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      }),
    ).rejects.toThrowError(policyDenied());
    await expect(placeholder.assertActive(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
  });

  it('is not mistaken for a wired durable authority by the scheduler gate', () => {
    const gate = evaluateSchedulerConsentGate(createUnavailableConsentAuthority());

    expect(gate.ready).toBe(false);
    expect(gate.reason).toContain('placeholder');

    expect(evaluateSchedulerConsentGate(undefined).ready).toBe(false);
    expect(evaluateSchedulerConsentGate(legacyConsent).ready).toBe(false);

    const recorder: Recorder = { events: [] };
    expect(evaluateSchedulerConsentGate(new ScriptedConsent(recorder)).ready).toBe(true);
  });

  it('refuses to hand out a non-attributable authority as if it were a durable one', () => {
    expect(() => requireCommitmentConsentAuthority(legacyConsent as never, 'worker')).toThrowError(
      policyDenied(),
    );
    expect(() =>
      requireCommitmentConsentAuthority(createUnavailableConsentAuthority(), 'worker'),
    ).toThrowError(policyDenied());
  });
});

describe('P0-C3B: the publication gate is the durable, transaction-scoped one', () => {
  // P0-C3D (#84) deleted the Worker-local publication-guard factory: it called `assertActive()`
  // outside the append transaction, so a revocation committed between the check and the Outcome
  // INSERT could slip through. `PostgresConsentPublicationGuard` replaced it, and its coverage is
  // integration-level because the whole point is the row lock on the publishing connection —
  // see `tests/integration/p0c3d-consent-postgres.test.ts`.
  it('exposes no Worker-side publication guard that could bypass the append transaction', async () => {
    const module = await import('../../apps/worker/src/commitment-consent.js');

    expect('createCommitmentConsentPublicationGuard' in module).toBe(false);
  });
});

describe('P0-C3B: scheduler startup gate', () => {
  interface CapturedLogs {
    readonly logger: WorkerLogger;
    readonly messages: string[];
  }

  const buildLogger = (): CapturedLogs => {
    const messages: string[] = [];
    const record = (message: string): void => {
      messages.push(message);
    };

    return { messages, logger: { debug: record, info: record, warn: record, error: record } };
  };

  const buildConfig = (enabled: boolean): WorkerConfig =>
    ({
      mode: 'poll',
      scheduler: {
        enabled,
        intervalMs: 1_000,
        batchSize: 1,
        concurrency: 1,
        stalledTimeoutSeconds: 60,
      },
      errorBackoffMs: 1_000,
      workerId: 'worker-fence-test',
    }) as unknown as WorkerConfig;

  const unusablePool = {} as unknown as ReturnType<typeof createPool>;

  it('refuses to start when only the deny-all placeholder authority is wired', async () => {
    const { logger, messages } = buildLogger();

    await expect(
      startCommitmentScheduler({
        config: buildConfig(true),
        pool: unusablePool,
        logger,
        signal: LIVE_SIGNAL,
        consent: createUnavailableConsentAuthority(),
      }),
    ).resolves.toBeUndefined();

    expect(messages).toContain('commitment scheduler refused to start');
  });

  it('refuses to start with no Consent authority wired at all', async () => {
    const { logger, messages } = buildLogger();

    await startCommitmentScheduler({
      config: buildConfig(true),
      pool: unusablePool,
      logger,
      signal: LIVE_SIGNAL,
    });

    expect(messages).toContain('commitment scheduler refused to start');
  });

  it('stays idle when the scheduler is disabled', async () => {
    const { logger, messages } = buildLogger();

    await startCommitmentScheduler({
      config: buildConfig(false),
      pool: unusablePool,
      logger,
      signal: LIVE_SIGNAL,
    });

    expect(messages).toEqual(['commitment scheduler disabled']);
  });
});

/**
 * P0-C3C binding.
 *
 * `@ember/connectors` owns the Consent contract and exposes the canonical authority,
 * `ConsentAuthority.resolveGeneration`. `fromResolvedGenerationConsent` is the only adapter the
 * Worker needs: it mints the canonical fence (tenant, profile, generation, issuedAt, digest) and
 * delegates every decision to `validateConsentAuthorizationFence` /
 * `validateConsentGenerationBinding`.
 */
function buildRecord(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return Object.freeze({
    grantId: 'grant-a',
    tenantId: TENANT_ID,
    sourceProfileId: SOURCE_PROFILE_ID,
    status: 'active',
    allowedOperations: Object.freeze(['read_snapshot']),
    scopes: Object.freeze(['source.readonly']),
    grantedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    version: 1,
    ...overrides,
  });
}

/** Stand-in for Agent A's durable repository: a generation read plus the grant record. */
class ScriptedConsentStore implements ConsentGrantSource {
  public record: ConsentGrant | null = buildRecord();
  public generationReads = 0;

  resolveGeneration(
    tenantId: string,
    sourceProfileId: string,
    now: Date = NOW,
  ): AuthorizedConsentGeneration | null {
    this.generationReads++;

    if (this.record === null) {
      return null;
    }

    if (this.record.tenantId !== tenantId || this.record.sourceProfileId !== sourceProfileId) {
      return null;
    }

    return {
      tenantId: this.record.tenantId,
      sourceProfileId: this.record.sourceProfileId,
      grantId: this.record.grantId,
      version: this.record.version,
      // The durable store reports the EFFECTIVE status: expiry is derived, never written down.
      status: deriveConsentStatus(this.record, now),
      expiresAt: this.record.expiresAt,
    };
  }

  get(tenantId: string, sourceProfileId: string): ConsentGrant | null {
    if (this.record === null) {
      return null;
    }

    if (this.record.tenantId !== tenantId || this.record.sourceProfileId !== sourceProfileId) {
      return null;
    }

    return this.record;
  }
}

const ADAPTER_NOW = { now: (): Date => NOW };

describe('P0-C3B: P0-C3C resolveGeneration binding', () => {
  const bind = (store: ScriptedConsentStore): ConsentFenceAuthority =>
    fromResolvedGenerationConsent(store, { ...ADAPTER_NOW, grants: store });

  it('mints a canonical fence from the resolved generation, not from caller state', async () => {
    const store = new ScriptedConsentStore();
    const authority = bind(store);

    expect(isConsentFenceAuthority(authority)).toBe(true);
    expect(isConsentAuthority(authority)).toBe(true);

    const fence = await authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);

    expect(fence).toEqual({
      tenantId: TENANT_ID,
      sourceProfileId: SOURCE_PROFILE_ID,
      grantId: 'grant-a',
      grantVersion: 1,
      issuedAt: NOW.toISOString(),
      // The canonical fence REQUIRES a digest; P0-C3C owns the algorithm.
      digest: computeConsentFenceDigest({
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
        grantId: 'grant-a',
        grantVersion: 1,
        issuedAt: NOW.toISOString(),
      }),
    });

    await expect(
      authority.assertFenceCurrent(fence, {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      }),
    ).resolves.toEqual({
      allowedOperations: ['read_snapshot'],
      scopes: ['source.readonly'],
    });
  });

  it('produces a fence the canonical C3C validator accepts', async () => {
    const store = new ScriptedConsentStore();
    const authority = bind(store);

    const fence = await authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);

    expect(
      validateConsentAuthorizationFence({
        fence,
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
        authoritative: store.resolveGeneration(TENANT_ID, SOURCE_PROFILE_ID),
        now: NOW,
      }),
    ).toEqual({ valid: true, code: 'VALID', denialCode: null });
  });

  it('rejects a tampered fence instead of trusting its digest', async () => {
    const store = new ScriptedConsentStore();
    const authority = bind(store);

    const fence = await authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);

    await expect(
      authority.assertFenceCurrent(
        { ...fence, grantVersion: 2 },
        { tenantId: TENANT_ID, sourceProfileId: SOURCE_PROFILE_ID },
      ),
    ).rejects.toThrowError(policyDenied());
  });

  it('denies instead of inventing the authorized operations when the store omits them', async () => {
    const store = new ScriptedConsentStore();
    // A store that reports the generation but not what it authorizes cannot authorize a read: the
    // Worker would have to assume `read_snapshot`, which is exactly the laundering the connector
    // boundary would then spend.
    store.record = buildRecord({ allowedOperations: Object.freeze([]) });

    const authority = bind(store);
    const fence = await authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);

    // Minting succeeds (the generation is active); the READ is what must be refused, because the
    // grant reports no operation the Worker could mirror.
    await expect(
      authority.assertFenceCurrent(fence, {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      }),
    ).rejects.toThrowError(policyDenied());
  });

  it('denies every read when no grant source is wired at all', async () => {
    const store = new ScriptedConsentStore();
    const authority = fromResolvedGenerationConsent(store, ADAPTER_NOW);

    await expect(authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
  });

  it('rejects a grant that reports a non-string operation', async () => {
    const store = new ScriptedConsentStore();
    store.record = buildRecord({
      allowedOperations: Object.freeze(['read_snapshot', 7 as unknown as string]),
    });

    const authority = bind(store);

    // A malformed grant cannot even be fenced: the canonical minting helper refuses it, and the
    // adapter reports that as a consent denial rather than an internal error.
    await expect(authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
  });

  it('rejects a fence whose generation was replaced even when the version restarted', async () => {
    const store = new ScriptedConsentStore();
    const authority = bind(store);

    const fence = await authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);

    // Revoke + re-grant that restarts the counter at 1: a version-only fence would still match.
    store.record = buildRecord({ grantId: 'grant-b', version: 1 });

    await expect(
      authority.assertFenceCurrent(fence, {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      }),
    ).rejects.toThrowError(policyDenied());
  });

  it('denies a missing, revoked and expired generation alike', async () => {
    const store = new ScriptedConsentStore();
    const bound = bind(store);

    store.record = null;
    await expect(bound.assertActive(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
    await expect(bound.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );

    store.record = buildRecord({ status: 'revoked', revokedAt: '2026-11-01T12:00:00.000Z' });
    await expect(bound.assertActive(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
    await expect(bound.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );

    store.record = buildRecord({ expiresAt: '2026-11-01T00:00:00.000Z' });
    await expect(bound.assertActive(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
    await expect(bound.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      policyDenied(),
    );
  });

  it('never resolves another lineage through a resolved generation', async () => {
    const authority = bind(new ScriptedConsentStore());

    await expect(authority.authorizeFence(TENANT_ID, 'other-profile-v1')).rejects.toThrowError(
      policyDenied(),
    );
  });

  it('arms the scheduler gate and the publication check without further wiring', async () => {
    const authority = bind(new ScriptedConsentStore());

    expect(evaluateSchedulerConsentGate(authority).ready).toBe(true);

    // The publication check now runs through the same authority inside the repository's
    // transaction, so the only capability the wiring has to provide is the fence assertion.
    await expect(authority.assertActive(TENANT_ID, SOURCE_PROFILE_ID)).resolves.toBeUndefined();

    const fence = await authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);
    await expect(
      authority.assertFenceCurrent(fence, {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      }),
    ).resolves.toEqual({
      allowedOperations: ['read_snapshot'],
      scopes: ['source.readonly'],
    });
  });

  it('normalizes a store failure into a terminal, content-free policyDenied()', async () => {
    const authority = fromResolvedGenerationConsent({
      resolveGeneration(): Promise<AuthorizedConsentGeneration> {
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      },
    });

    const rejection = await authority
      .assertActive(TENANT_ID, SOURCE_PROFILE_ID)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DomainError);
    expect((rejection as DomainError).code).toBe('POLICY_DENIED');
    expect((rejection as DomainError).message).not.toContain('ECONNREFUSED');
  });
});
