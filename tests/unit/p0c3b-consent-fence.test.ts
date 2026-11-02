import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_PROFILE_RELEASES } from '@ember/connectors';
import { DomainError, type Id } from '@ember/domain';
import {
  CommitmentOrchestrator,
  createDefaultSentinelPolicy,
  fromResolvedGenerationConsent,
  isConsentFenceAuthority,
  isResolvedGenerationConsentAuthority,
  parseConsentFence,
  type AppendOutcomeCommand,
  type AuthorizedConsentGenerationView,
  type ConsentAuthorizationFence,
  type ConsentFenceAuthority,
  type OutcomeResultStatus,
  type SourceSnapshot,
  type WorkerLeaseGrant,
} from '@ember/execution';
import {
  createCommitmentConsentPublicationGuard,
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
 * P0-C3B Consent authorization fence.
 *
 * The Worker authorizes a source read, the read takes time, and the Outcome is published
 * afterwards. These tests pin the property that matters: publication is bound to the *exact*
 * grant version that authorized the read, so a revocation that lands while the read is in flight
 * discards the work instead of publishing an unattributable Outcome.
 */

const SOURCE_PROFILE_ID = FIXTURE_PROFILE_RELEASES.sourceProfileId;
const TENANT_ID = randomUUID();
const LIVE_SIGNAL = new AbortController().signal;

const SNAPSHOT: SourceSnapshot = {
  sourceProfileId: SOURCE_PROFILE_ID,
  observedAt: '2026-11-02T12:00:00.000Z',
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

/**
 * Fenced authority double, shaped after the P0-C3C consent contract.
 *
 * `grantId` + `version` model the durable store's authorization generation: bumping either is
 * exactly what a revoke-plus-regrant looks like to the Worker. A verdict-only double cannot
 * express this, which is the whole point of the fence.
 */
class ScriptedConsent implements ConsentFenceAuthority {
  public version = 1;
  public grantId = 'grant-primary';
  public active = true;
  public authorizeCalls = 0;
  public assertFenceCurrentCalls = 0;
  /** Number of `assertFenceCurrent` calls that may succeed before the grant is reported stale. */
  public fenceCurrentSucceeds = Number.POSITIVE_INFINITY;

  constructor(
    private readonly recorder: Recorder,
    private readonly tenantId: Id = TENANT_ID,
  ) {}

  grantFence(sourceProfileId: string): ConsentAuthorizationFence {
    return {
      tenantId: this.tenantId,
      sourceProfileId,
      grantId: this.grantId,
      grantVersion: this.version,
      issuedAt: '2026-11-02T11:59:00.000Z',
      // Well-formed but unsigned: the digest is an integrity check, never an authorization input.
      digest: '0'.repeat(64),
    };
  }

  authorizeFence(tenantId: Id, sourceProfileId: string): Promise<ConsentAuthorizationFence> {
    this.authorizeCalls++;
    this.recorder.events.push('consent.authorizeFence');

    if (!this.active) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Source Consent is not active'));
    }

    return Promise.resolve({ ...this.grantFence(sourceProfileId), tenantId });
  }

  assertFenceCurrent(fence: ConsentAuthorizationFence): Promise<void> {
    this.assertFenceCurrentCalls++;
    this.recorder.events.push('consent.assertFenceCurrent');

    if (this.assertFenceCurrentCalls > this.fenceCurrentSucceeds) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Source Consent was revoked'));
    }

    if (!this.active) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Source Consent is not active'));
    }

    // Generation identity, not just the number: a re-grant mints a new `grantId`, and a version
    // restart on the same lineage must still invalidate the old fence.
    if (fence.grantId !== this.grantId || fence.grantVersion !== this.version) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Source Consent was re-granted'));
    }

    return Promise.resolve();
  }

  assertActive(): Promise<void> {
    this.recorder.events.push('consent.assertActive');

    if (!this.active) {
      return Promise.reject(new DomainError('POLICY_DENIED', 'Source Consent is not active'));
    }

    return Promise.resolve();
  }
}

/** Minimal legacy authority: verdict only, no version. Must never satisfy the fence contract. */
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
  public receivedFence: ConsentAuthorizationFence | undefined;

  constructor(
    private readonly recorder: Recorder,
    private readonly onRead?: () => void,
  ) {}

  readSnapshot(
    _profileId: string,
    _trustedContext: unknown,
    _signal: AbortSignal,
    fence?: ConsentAuthorizationFence,
  ): Promise<SourceSnapshot> {
    this.recorder.events.push('source.read');
    this.readCalls++;
    this.receivedFence = fence;
    this.onRead?.();
    return Promise.resolve(SNAPSHOT);
  }
}

function buildGrant(): WorkerLeaseGrant {
  return {
    tenantId: TENANT_ID,
    taskId: randomUUID(),
    runId: randomUUID(),
    attempt: 1,
    leaseEpoch: 1,
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
  };
}

function trustedContext(tenantId: Id) {
  return {
    tenantId,
    commitmentId: randomUUID(),
    taskId: randomUUID(),
    runId: randomUUID(),
    leaseEpoch: 1,
    authorizedAt: '2026-11-02T12:00:00.000Z',
  };
}

function placeholderFence(): ConsentAuthorizationFence {
  return {
    tenantId: TENANT_ID,
    sourceProfileId: SOURCE_PROFILE_ID,
    grantId: 'grant-primary',
    grantVersion: 1,
    issuedAt: '2026-11-02T12:00:00.000Z',
    digest: '0'.repeat(64),
  };
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

    // The reader is handed the *same* version that authorized the read, never a fresh verdict.
    expect(sourceReader.receivedFence?.grantVersion).toBe(1);
    expect(sourceReader.receivedFence?.sourceProfileId).toBe(SOURCE_PROFILE_ID);
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
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));

    expect(sourceReader.readCalls).toBe(1);
    expect(store.appendCallCount).toBe(0);
    expect(recorder.events).not.toContain('store.appendOutcome');
  });

  it('discards the outcome when the grant is re-issued with a new version mid-flight', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const store = new RecordingStore(recorder);

    // A re-grant leaves Consent active, so a boolean check would still pass. Only the version
    // comparison can tell that the read was authorized under a different grant.
    const sourceReader = new RecordingSourceReader(recorder, () => {
      consent.version = 2;
    });

    const orchestrator = buildOrchestrator({ store, sourceReader, consent });

    await expect(
      orchestrator.execute(buildGrant(), buildContext(), LIVE_SIGNAL),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));

    expect(store.appendCallCount).toBe(0);
  });

  it('rejects a verdict-only consent dependency at construction instead of at publication', () => {
    const recorder: Recorder = { events: [] };
    const store = new RecordingStore(recorder);
    const sourceReader = new RecordingSourceReader(recorder);

    expect(() =>
      buildOrchestrator({
        store,
        sourceReader,
        // A verdict-only authority cannot attribute an Outcome to a grant version.
        consent: legacyConsent as unknown as ConsentFenceAuthority,
      }),
    ).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));

    expect(sourceReader.readCalls).toBe(0);
    expect(store.appendCallCount).toBe(0);
  });
});

describe('P0-C3B: fence re-verification inside the source reader', () => {
  it('denies the read when the fence names another tenant (0 reader callbacks)', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent });

    await expect(
      reader.readSnapshot(SOURCE_PROFILE_ID, trustedContext(TENANT_ID), LIVE_SIGNAL, {
        ...consent.grantFence(SOURCE_PROFILE_ID),
        tenantId: randomUUID(),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));

    expect(consent.assertFenceCurrentCalls).toBe(0);
  });

  it('denies the read when the fence names another source profile', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(TENANT_ID),
        LIVE_SIGNAL,
        consent.grantFence('sp_some_other_profile'),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));

    expect(consent.assertFenceCurrentCalls).toBe(0);
  });

  it('refuses a fence-aware read from an authority that cannot verify fences', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const reader = new CommitmentSourceReader({ consent: legacyConsent });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(TENANT_ID),
        LIVE_SIGNAL,
        consent.grantFence(SOURCE_PROFILE_ID),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('rejects a snapshot whose consent went stale between the two read gates', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    // First verification passes, the post-read verification reports a revocation.
    consent.fenceCurrentSucceeds = 1;

    const reader = new CommitmentSourceReader({ consent });

    await expect(
      reader.readSnapshot(
        SOURCE_PROFILE_ID,
        trustedContext(TENANT_ID),
        LIVE_SIGNAL,
        consent.grantFence(SOURCE_PROFILE_ID),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));

    expect(consent.assertFenceCurrentCalls).toBe(2);
  });

  it('still reads under a verdict-only authority when no fence is supplied (legacy path)', async () => {
    const assertActive = vi.fn((): Promise<void> => Promise.resolve());
    const reader = new CommitmentSourceReader({ consent: { assertActive } });

    const snapshot = await reader.readSnapshot(
      SOURCE_PROFILE_ID,
      trustedContext(TENANT_ID),
      LIVE_SIGNAL,
    );

    expect(snapshot.sourceProfileId).toBe(SOURCE_PROFILE_ID);
    expect(assertActive).toHaveBeenCalled();
  });
});

describe('P0-C3B: deny-all Consent placeholder', () => {
  it('is fence-shaped, branded, and rejects every entry point', async () => {
    const placeholder = createUnavailableConsentAuthority();

    expect(isConsentFenceAuthority(placeholder)).toBe(true);
    expect(isUnavailableConsentAuthority(placeholder)).toBe(true);
    expect(isUnavailableConsentAuthority(createUnavailableConsentAuthority())).toBe(true);
    expect(isUnavailableConsentAuthority(legacyConsent)).toBe(false);

    await expect(placeholder.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
    await expect(placeholder.assertFenceCurrent(placeholderFence())).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
    await expect(placeholder.assertActive(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
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
    expect(() => requireCommitmentConsentAuthority(legacyConsent, 'worker')).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
    expect(() =>
      requireCommitmentConsentAuthority(createUnavailableConsentAuthority(), 'worker'),
    ).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });
});

describe('P0-C3B: transaction-scoped Consent publication guard', () => {
  it('denies publication while consent is inactive', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    consent.active = false;

    const guard = createCommitmentConsentPublicationGuard(consent);

    await expect(
      guard.authorizeFence({} as never, {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('normalizes a driver failure into a terminal, content-free POLICY_DENIED', async () => {
    const guard = createCommitmentConsentPublicationGuard({
      assertActive(): Promise<void> {
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      },
      authorizeFence(): Promise<never> {
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      },
      assertFenceCurrent(): Promise<void> {
        return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      },
    });

    const rejection = await guard
      .authorizeFence({} as never, { tenantId: TENANT_ID, sourceProfileId: SOURCE_PROFILE_ID })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DomainError);
    expect((rejection as DomainError).code).toBe('POLICY_DENIED');
    expect((rejection as DomainError).message).not.toContain('ECONNREFUSED');
  });

  it('records the active generation as the dispatch fence', async () => {
    const recorder: Recorder = { events: [] };
    const consent = new ScriptedConsent(recorder);
    const guard = createCommitmentConsentPublicationGuard(consent);

    await expect(
      guard.authorizeFence({} as never, {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
      }),
    ).resolves.toEqual({ grantId: consent.grantId, version: consent.version });
  });

  it('denies publication when the occurrence recorded no generation fence', async () => {
    const recorder: Recorder = { events: [] };
    const guard = createCommitmentConsentPublicationGuard(new ScriptedConsent(recorder));

    await expect(
      guard.assertFenceCurrent({} as never, {
        tenantId: TENANT_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
        fence: null,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
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
 * P0-C3C (`@ember/connectors`) owns the Consent contract and exposes a single read port,
 * `ConsentAuthority.resolveGeneration`. P0-C3B must not invent a second authority contract, so
 * `fromResolvedGenerationConsent` adapts that port to the Worker's fence gates. These tests pin
 * that the adapter is (a) the only binding needed for Agent A's durable store and (b) strict
 * enough that a generation change always invalidates a fence, even when the version number does
 * not move.
 */
describe('P0-C3B: P0-C3C resolveGeneration binding', () => {
  /** Controllable stand-in for Agent A's durable repository / FakeConsentRegistry. */
  class ScriptedGenerationStore {
    public generation: AuthorizedConsentGenerationView | null = {
      grantId: 'grant-a',
      version: 1,
      tenantId: TENANT_ID,
      sourceProfileId: SOURCE_PROFILE_ID,
      status: 'active',
      expiresAt: null,
    };

    public reads = 0;

    resolveGeneration(
      tenantId: string,
      sourceProfileId: string,
    ): AuthorizedConsentGenerationView | null {
      this.reads++;

      if (this.generation === null) {
        return null;
      }

      // A real store resolves per lineage; anything else is not this lineage's generation.
      if (
        this.generation.tenantId !== tenantId ||
        this.generation.sourceProfileId !== sourceProfileId
      ) {
        return null;
      }

      return this.generation;
    }
  }

  it('mints a fence from the resolved generation, not from caller state', async () => {
    const store = new ScriptedGenerationStore();
    const authority = fromResolvedGenerationConsent(store, {
      now: () => new Date('2026-11-02T12:00:00.000Z'),
    });

    expect(isConsentFenceAuthority(authority)).toBe(true);
    expect(isResolvedGenerationConsentAuthority(store)).toBe(true);
    expect(isResolvedGenerationConsentAuthority(legacyConsent)).toBe(false);

    const fence = await authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);

    expect(fence).toEqual({
      tenantId: TENANT_ID,
      sourceProfileId: SOURCE_PROFILE_ID,
      grantId: 'grant-a',
      grantVersion: 1,
      issuedAt: '2026-11-02T12:00:00.000Z',
      // The canonical contract always mints the integrity digest; it is never authorization.
      digest: fence.digest,
    });
    expect(fence.digest).toMatch(/^[0-9a-f]{64}$/);

    await expect(authority.assertFenceCurrent(fence)).resolves.toBeUndefined();
  });

  it('rejects a fence whose generation was replaced even when the version restarted', async () => {
    const store = new ScriptedGenerationStore();
    const authority = fromResolvedGenerationConsent(store);

    const fence = await authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID);

    // Revoke + re-grant that restarts the counter at 1: a version-only fence would still match.
    store.generation = {
      grantId: 'grant-b',
      version: 1,
      tenantId: TENANT_ID,
      sourceProfileId: SOURCE_PROFILE_ID,
      status: 'active',
      expiresAt: null,
    };

    await expect(authority.assertFenceCurrent(fence)).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
  });

  it('fails closed when the generation is missing, revoked, or expired', async () => {
    const store = new ScriptedGenerationStore();
    const authority = fromResolvedGenerationConsent(store);

    store.generation = null;
    await expect(authority.assertActive(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );

    store.generation = {
      grantId: 'grant-a',
      version: 1,
      tenantId: TENANT_ID,
      sourceProfileId: SOURCE_PROFILE_ID,
      status: 'revoked',
      expiresAt: null,
    };
    await expect(authority.authorizeFence(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );

    store.generation = {
      grantId: 'grant-a',
      version: 1,
      tenantId: TENANT_ID,
      sourceProfileId: SOURCE_PROFILE_ID,
      status: 'expired',
      expiresAt: '2026-11-01T00:00:00.000Z',
    };
    await expect(authority.assertActive(TENANT_ID, SOURCE_PROFILE_ID)).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
  });

  it('never resolves another lineage through a resolved generation', async () => {
    const store = new ScriptedGenerationStore();
    const authority = fromResolvedGenerationConsent(store);

    await expect(authority.authorizeFence(TENANT_ID, 'other-profile-v1')).rejects.toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
  });

  it('arms the scheduler gate and publication guard without further wiring', async () => {
    const store = new ScriptedGenerationStore();
    const authority = fromResolvedGenerationConsent(store);

    expect(evaluateSchedulerConsentGate(authority).ready).toBe(true);

    const guard = createCommitmentConsentPublicationGuard(authority);
    const fence = await guard.authorizeFence({} as never, {
      tenantId: TENANT_ID,
      sourceProfileId: SOURCE_PROFILE_ID,
    });

    expect(fence.grantId).toEqual(expect.any(String));
    expect(fence.version).toBe(1);
  });

  it('normalizes a store failure into a terminal, content-free POLICY_DENIED', async () => {
    const authority = fromResolvedGenerationConsent({
      resolveGeneration(): Promise<AuthorizedConsentGenerationView> {
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

describe('P0-C3B: fence parsing at the trust boundary', () => {
  const baseFence = (): Record<string, unknown> => ({
    tenantId: TENANT_ID,
    sourceProfileId: SOURCE_PROFILE_ID,
    grantId: 'grant-a',
    grantVersion: 1,
    issuedAt: '2026-11-02T12:00:00.000Z',
  });

  it('accepts a P0-C3C shaped fence and preserves its integrity digest', () => {
    const digest = 'f'.repeat(64);
    const parsed = parseConsentFence({ ...baseFence(), digest });

    expect(parsed.grantId).toBe('grant-a');
    expect(parsed.grantVersion).toBe(1);
    expect(parsed.digest).toBe(digest);
  });

  it('rejects a missing generation identity and a non-integer version', () => {
    const { grantId: _grantId, ...withoutGrant } = baseFence();

    expect(() => parseConsentFence(withoutGrant)).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
    expect(() => parseConsentFence({ ...baseFence(), grantVersion: 0 })).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
    expect(() => parseConsentFence({ ...baseFence(), grantVersion: 1.5 })).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
  });

  it('rejects a malformed integrity digest instead of trusting it', () => {
    expect(() => parseConsentFence({ ...baseFence(), digest: 'not-a-digest' })).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
  });
});
