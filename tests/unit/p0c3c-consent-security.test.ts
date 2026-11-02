import { describe, expect, it, vi } from 'vitest';
import {
  createConsentAuthorizationFence,
  FakeConsentRegistry,
  FakeSourceReader,
  FIXTURE_INJECTION_ITEMS,
  FIXTURE_PROFILE_RELEASES,
  GuardedSourceReader,
  InMemorySourceAuditSink,
  SOURCE_READ_OPERATION,
  SOURCE_READ_SCOPE,
  TEST_TENANT_A,
  TEST_TENANT_B,
  validateConsentGenerationBinding,
  type ConsentAuthorizationFence,
  type ConsentAuthority,
  type ConsentGrant,
  type SourceAuditRecord,
  type SourceAccessPolicy,
  type SourceProfile,
  type SourceReader,
  type SourceSnapshot,
  type TrustedSourceAccessContext,
} from '@ember/connectors';

/**
 * P0-C3C: Consent Contract & Security Conformance.
 *
 * Every case here treats the worker-supplied authorization fence, the reader, and the reader's
 * output as UNTRUSTED. The only authority is persisted consent state.
 */
const CLOCK = new Date('2026-11-01T12:00:00.000Z');
const PROFILE_ID = FIXTURE_PROFILE_RELEASES.sourceProfileId;

const POLICY: SourceAccessPolicy = {
  version: 1,
  allowedSourceProfileIds: [PROFILE_ID],
  allowedOperations: [SOURCE_READ_OPERATION],
  defaultAction: 'deny',
};

const TRUSTED_CONTEXT_BASE = {
  commitmentId: 'comm_11111111-1111-1111-1111-111111111111',
  taskId: 'task_11111111-1111-1111-1111-111111111111',
  runId: 'run_11111111-1111-1111-1111-111111111111',
  leaseEpoch: 1,
  authorizedAt: CLOCK.toISOString(),
} as const;

function buildContext(
  fence?: ConsentAuthorizationFence | null,
  tenantId: string = TEST_TENANT_A,
): TrustedSourceAccessContext {
  const base: TrustedSourceAccessContext = { tenantId, ...TRUSTED_CONTEXT_BASE };
  return fence === undefined || fence === null ? base : { ...base, authorizationFence: fence };
}

/** Reader wrapper that records invocations so "zero reader calls on deny" is provable. */
class RecordingReader implements SourceReader {
  calls = 0;
  readonly receivedSignals: AbortSignal[] = [];

  constructor(
    private readonly inner: SourceReader,
    private readonly beforeDelegate?: () => void | Promise<void>,
  ) {}

  async readSnapshot(
    sourceProfileId: string,
    context: TrustedSourceAccessContext,
    signal: AbortSignal,
  ): Promise<SourceSnapshot> {
    this.calls += 1;
    this.receivedSignals.push(signal);
    if (this.beforeDelegate) {
      await this.beforeDelegate();
    }
    return this.inner.readSnapshot(sourceProfileId, context, signal);
  }
}

function grantConsent(
  registry: FakeConsentRegistry,
  overrides: Partial<{
    tenantId: string;
    scopes: readonly string[];
    allowedOperations: readonly string[];
    expiresAt: string | null;
  }> = {},
  now: Date = CLOCK,
) {
  return registry.grant(
    {
      tenantId: overrides.tenantId ?? TEST_TENANT_A,
      sourceProfileId: PROFILE_ID,
      scopes: overrides.scopes ?? [SOURCE_READ_SCOPE],
      allowedOperations: overrides.allowedOperations ?? [SOURCE_READ_OPERATION],
      ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    },
    now,
  );
}

function createHarness(
  options: {
    readonly reader?: SourceReader;
    readonly now?: () => Date;
    readonly requireAuthorizationFence?: boolean;
    readonly authority?: ConsentAuthority;
  } = {},
) {
  const registry = new FakeConsentRegistry();
  const auditSink = new InMemorySourceAuditSink();
  const profiles = new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]);
  const reader = options.reader ?? new FakeSourceReader();

  const guardedReader = new GuardedSourceReader({
    reader,
    registry,
    profiles,
    policy: POLICY,
    auditSink,
    nowProvider: options.now ?? (() => CLOCK),
    authority: options.authority,
    requireAuthorizationFence: options.requireAuthorizationFence,
  });

  return { registry, auditSink, reader, guardedReader };
}

/** Captures a denial without asserting on untrusted error internals. */
async function captureDenial(promise: Promise<unknown>): Promise<{
  readonly code: string;
  readonly diagnostic: string;
}> {
  try {
    await promise;
  } catch (error) {
    const candidate = error as { code?: unknown; diagnostic?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : '',
      diagnostic: typeof candidate.diagnostic === 'string' ? candidate.diagnostic : '',
    };
  }
  throw new Error('Expected the guarded read to be denied, but it resolved');
}

function recordsOf(auditSink: InMemorySourceAuditSink): readonly SourceAuditRecord[] {
  return auditSink.getRecords();
}

function readSignal(): AbortSignal {
  return new AbortController().signal;
}

/**
 * Authority double backed by its OWN registry, so a test can make the authority and the perimeter's
 * registry disagree (the split-brain condition the generation binding invariant guards against).
 */
function pinnedAuthority(registry: FakeConsentRegistry): ConsentAuthority {
  return {
    resolveGeneration: (tenantId, sourceProfileId, now) =>
      registry.resolveGeneration(tenantId, sourceProfileId, now),
  };
}

describe('P0-C3C: authorization fence security conformance', () => {
  it('accepts a fence minted for the current active generation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { registry, auditSink, guardedReader } = createHarness();
    const grant = grantConsent(registry);
    const fence = createConsentAuthorizationFence(grant, CLOCK);

    const snapshot = await guardedReader.readSnapshot(
      PROFILE_ID,
      buildContext(fence),
      readSignal(),
    );

    expect(snapshot.sourceProfileId).toBe(PROFILE_ID);
    expect(snapshot.boundedSafeItems.length).toBeGreaterThan(0);
    expect(Object.isFrozen(snapshot)).toBe(true);

    const records = recordsOf(auditSink);
    expect(records).toHaveLength(1);
    expect(records[0]?.decision).toBe('ALLOWED');
    expect(records[0]?.networkCallsMade).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('denies a missing fence when fences are required, without invoking the reader', async () => {
    const { registry, auditSink, reader, guardedReader } = createHarness({
      requireAuthorizationFence: true,
      reader: new RecordingReader(new FakeSourceReader()),
    });
    grantConsent(registry);

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(), readSignal()),
    );

    expect(denial.code).toBe('POLICY_DENIED');
    expect(denial.diagnostic).toContain('[code: CONSENT_FENCE_MISSING]');
    expect((reader as RecordingReader).calls).toBe(0);
    expect(recordsOf(auditSink)[0]?.denialCode).toBe('CONSENT_FENCE_MISSING');
  });

  it('still accepts a fence-less read when fences are optional (backward compatibility)', async () => {
    const { registry, reader, guardedReader } = createHarness({
      reader: new RecordingReader(new FakeSourceReader()),
    });
    grantConsent(registry);

    await guardedReader.readSnapshot(PROFILE_ID, buildContext(), readSignal());

    expect((reader as RecordingReader).calls).toBe(1);
  });

  it('denies a tampered fence whose digest no longer matches the canonical body', async () => {
    const { registry, auditSink, reader, guardedReader } = createHarness({
      reader: new RecordingReader(new FakeSourceReader()),
    });
    const grant = grantConsent(registry);
    const fence = createConsentAuthorizationFence(grant, CLOCK);
    const tampered: ConsentAuthorizationFence = { ...fence, grantVersion: fence.grantVersion + 1 };

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(tampered), readSignal()),
    );

    expect(denial.code).toBe('POLICY_DENIED');
    expect(denial.diagnostic).toContain('[code: CONSENT_FENCE_INVALID]');
    expect((reader as RecordingReader).calls).toBe(0);
    expect(recordsOf(auditSink)[0]?.denialCode).toBe('CONSENT_FENCE_INVALID');
  });

  it('denies a stale fence after revoke and re-grant', async () => {
    const { registry, reader, guardedReader } = createHarness({
      reader: new RecordingReader(new FakeSourceReader()),
    });
    const firstGrant = grantConsent(registry);
    const staleFence = createConsentAuthorizationFence(firstGrant, CLOCK);

    registry.revoke(TEST_TENANT_A, PROFILE_ID, CLOCK);
    grantConsent(registry, {}, CLOCK);

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(staleFence), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: CONSENT_FENCE_STALE]');
    expect((reader as RecordingReader).calls).toBe(0);
  });

  it('denies a cross-tenant fence even when both tenants hold a valid grant', async () => {
    const { registry, reader, guardedReader } = createHarness({
      reader: new RecordingReader(new FakeSourceReader()),
    });
    grantConsent(registry);
    const foreignGrant = grantConsent(registry, { tenantId: TEST_TENANT_B });
    const foreignFence = createConsentAuthorizationFence(foreignGrant, CLOCK);

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(foreignFence), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: TENANT_MISMATCH]');
    expect((reader as RecordingReader).calls).toBe(0);
  });

  it('fails closed when the authority cannot resolve any generation', async () => {
    const { registry, guardedReader } = createHarness({
      authority: { resolveGeneration: () => null },
    });
    const grant = grantConsent(registry);
    const fence = createConsentAuthorizationFence(grant, CLOCK);

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: CONSENT_NOT_FOUND]');
  });

  it('fails closed when the authority itself throws', async () => {
    const { registry, reader, guardedReader } = createHarness({
      authority: {
        resolveGeneration: () => {
          throw new Error('connection reset by peer');
        },
      },
      reader: new RecordingReader(new FakeSourceReader()),
    });
    const grant = grantConsent(registry);
    const fence = createConsentAuthorizationFence(grant, CLOCK);

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.code).toBe('POLICY_DENIED');
    // Uniform agnosticism: an unavailable authority is indistinguishable from "no consent".
    expect(denial.diagnostic).toContain('[code: CONSENT_NOT_FOUND]');
    expect(denial.diagnostic).not.toContain('connection reset by peer');
    expect((reader as RecordingReader).calls).toBe(0);
  });
});

describe('P0-C3C: double-check invariant (consent cannot be revoked under a running read)', () => {
  it('never invokes the reader when the fenced generation is already revoked', async () => {
    const { registry, reader, guardedReader } = createHarness({
      reader: new RecordingReader(new FakeSourceReader()),
    });
    const grant = grantConsent(registry);
    const fence = createConsentAuthorizationFence(grant, CLOCK);
    registry.revoke(TEST_TENANT_A, PROFILE_ID, CLOCK);

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.code).toBe('POLICY_DENIED');
    expect(denial.diagnostic).toContain('[code: CONSENT_REVOKED]');
    expect((reader as RecordingReader).calls).toBe(0);
  });

  it('discards the snapshot when consent is revoked mid-read', async () => {
    const registry = new FakeConsentRegistry();
    const reader = new RecordingReader(new FakeSourceReader(), () => {
      registry.revoke(TEST_TENANT_A, PROFILE_ID, CLOCK);
    });
    const auditSink = new InMemorySourceAuditSink();
    const guardedReader = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]),
      policy: POLICY,
      auditSink,
      nowProvider: () => CLOCK,
    });
    const grant = grantConsent(registry);
    const fence = createConsentAuthorizationFence(grant, CLOCK);

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: REVOKED_DURING_EXECUTION]');
    expect(reader.calls).toBe(1);
    expect(recordsOf(auditSink).at(-1)?.denialCode).toBe('REVOKED_DURING_EXECUTION');
  });

  it('discards the snapshot when the grant expires during the read', async () => {
    let currentNow = CLOCK;
    const registry = new FakeConsentRegistry();
    const expiresAt = new Date(CLOCK.getTime() + 30_000).toISOString();
    const grant = grantConsent(registry, { expiresAt }, CLOCK);
    const fence = createConsentAuthorizationFence(grant, CLOCK);

    const reader = new RecordingReader(new FakeSourceReader(), () => {
      currentNow = new Date(CLOCK.getTime() + 60_000);
    });
    const guardedReader = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]),
      policy: POLICY,
      nowProvider: () => currentNow,
      requireAuthorizationFence: true,
    });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: REVOKED_DURING_EXECUTION]');
    expect(reader.calls).toBe(1);
  });

  it('discards the snapshot when the generation is superseded mid-read (revoke + re-grant)', async () => {
    const registry = new FakeConsentRegistry();
    const firstGrant = grantConsent(registry);
    const fence = createConsentAuthorizationFence(firstGrant, CLOCK);

    const reader = new RecordingReader(new FakeSourceReader(), () => {
      registry.revoke(TEST_TENANT_A, PROFILE_ID, CLOCK);
      grantConsent(registry, {}, CLOCK);
    });
    const auditSink = new InMemorySourceAuditSink();
    const guardedReader = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]),
      policy: POLICY,
      auditSink,
      nowProvider: () => CLOCK,
      requireAuthorizationFence: true,
    });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    // Consent is active again, but the fenced generation is no longer authoritative.
    expect(denial.diagnostic).toContain('[code: REVOKED_DURING_EXECUTION]');
    expect(reader.calls).toBe(1);
    expect(recordsOf(auditSink).at(-1)?.denialCode).toBe('REVOKED_DURING_EXECUTION');
  });
});

describe('P0-C3C: scope binding and untrusted reader hardening', () => {
  it('denies a grant that does not carry the required read scope', async () => {
    const { registry, reader, guardedReader } = createHarness({
      reader: new RecordingReader(new FakeSourceReader()),
    });
    grantConsent(registry, { scopes: ['source.readwrite'] });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: SCOPE_NOT_GRANTED]');
    expect((reader as RecordingReader).calls).toBe(0);
  });

  it('denies a grant that does not allow the read operation', async () => {
    const { registry, reader, guardedReader } = createHarness({
      reader: new RecordingReader(new FakeSourceReader()),
    });
    grantConsent(registry, { allowedOperations: ['list_profiles'] });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: OPERATION_NOT_ALLOWED]');
    expect((reader as RecordingReader).calls).toBe(0);
  });

  it('sanitizes an untrusted reader exception without leaking its details', async () => {
    const exploding: SourceReader = {
      readSnapshot: () => Promise.reject(new Error('postgres://admin:hunter2@db.internal/ember')),
    };
    const { registry, guardedReader } = createHarness({ reader: exploding });
    grantConsent(registry);

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(), readSignal()),
    );

    expect(denial.code).toBe('POLICY_DENIED');
    expect(denial.diagnostic).toBe(
      'Source reader execution failed; untrusted exception sanitized [code: POLICY_DENIED]',
    );
    expect(denial.diagnostic).not.toContain('hunter2');
  });

  it('propagates cooperative cancellation as CANCELLED without returning a snapshot', async () => {
    const { registry, auditSink, guardedReader } = createHarness({
      reader: new FakeSourceReader({ simulatedLatencyMs: 50 }),
    });
    grantConsent(registry);

    const controller = new AbortController();
    const pending = guardedReader.readSnapshot(PROFILE_ID, buildContext(), controller.signal);
    setTimeout(() => controller.abort(), 5);

    const denial = await captureDenial(pending);
    expect(denial.code).toBe('CANCELLED');
    expect(recordsOf(auditSink).at(-1)?.denialCode).toBe('READ_ABORTED');
  });

  it('treats prompt-injection payloads as inert data and makes zero network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const reader = new FakeSourceReader({
      fixtureMap: new Map([[PROFILE_ID, FIXTURE_INJECTION_ITEMS]]),
    });
    const { registry, auditSink, guardedReader } = createHarness({ reader });
    const grant = grantConsent(registry);
    const fence = createConsentAuthorizationFence(grant, CLOCK);

    const snapshot = await guardedReader.readSnapshot(
      PROFILE_ID,
      buildContext(fence),
      readSignal(),
    );

    expect(snapshot.boundedSafeItems).toHaveLength(1);
    const item = snapshot.boundedSafeItems[0];
    // Returned strictly as inert data: never executed, never able to mutate policy state.
    expect(item?.contentSnippet).toContain('Ignore all previous instructions');
    expect(Object.isFrozen(item)).toBe(true);
    expect(recordsOf(auditSink)[0]?.networkCallsMade).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('P0-C3C: generation binding (the grant policy evaluates must BE the fenced generation)', () => {
  /**
   * CTO round 2, P1: the reader used the registry grant for policy evaluation and, independently,
   * validated the fence against the authority. A registry still serving G1 while the authority (and
   * the fence) name G2 would authorize a read using G1's terms under a G2 fence.
   */
  it('denies a read whose terms came from G1 while the fence and authority name G2', async () => {
    const authorityRegistry = new FakeConsentRegistry();
    const authoritativeGeneration = grantConsent(authorityRegistry);
    const fence = createConsentAuthorizationFence(authoritativeGeneration, CLOCK);

    // Split brain: the perimeter's registry still serves the OLD generation G1.
    const registry = new FakeConsentRegistry();
    const servedGeneration = grantConsent(registry);
    expect(servedGeneration.grantId).not.toBe(authoritativeGeneration.grantId);

    const reader = new RecordingReader(new FakeSourceReader());
    const auditSink = new InMemorySourceAuditSink();
    const guardedReader = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]),
      policy: POLICY,
      auditSink,
      nowProvider: () => CLOCK,
      authority: pinnedAuthority(authorityRegistry),
      requireAuthorizationFence: true,
    });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.code).toBe('POLICY_DENIED');
    expect(denial.diagnostic).toContain('[code: CONSENT_GENERATION_MISMATCH]');
    // The fence was valid for G2 and G1 carried the read permission: only binding stops the read.
    expect(reader.calls).toBe(0);
    const records = recordsOf(auditSink);
    expect(records).toHaveLength(1);
    expect(records[0]?.decision).toBe('DENIED');
    expect(records[0]?.denialCode).toBe('CONSENT_GENERATION_MISMATCH');
  });

  it('denies a stale registry replica that still serves the superseded generation', async () => {
    const authorityRegistry = new FakeConsentRegistry();
    const currentGeneration = grantConsent(authorityRegistry);
    const fence = createConsentAuthorizationFence(currentGeneration, CLOCK);

    const registry = new FakeConsentRegistry();
    const firstGeneration = grantConsent(registry);
    registry.revoke(TEST_TENANT_A, PROFILE_ID, CLOCK);
    grantConsent(registry, {}, CLOCK);
    // Stale read replica: the lineage has been re-granted, but this path still returns G1.
    vi.spyOn(registry, 'get').mockReturnValue(firstGeneration);

    const reader = new RecordingReader(new FakeSourceReader());
    const guardedReader = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]),
      policy: POLICY,
      nowProvider: () => CLOCK,
      authority: pinnedAuthority(authorityRegistry),
      requireAuthorizationFence: true,
    });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: CONSENT_GENERATION_MISMATCH]');
    expect(reader.calls).toBe(0);
  });

  it('denies a mismatched generation even when fences are optional (fail closed, never open)', async () => {
    const authorityRegistry = new FakeConsentRegistry();
    const fence = createConsentAuthorizationFence(grantConsent(authorityRegistry), CLOCK);

    const registry = new FakeConsentRegistry();
    grantConsent(registry);
    const reader = new RecordingReader(new FakeSourceReader());
    const guardedReader = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]),
      policy: POLICY,
      nowProvider: () => CLOCK,
      authority: pinnedAuthority(authorityRegistry),
    });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.diagnostic).toContain('[code: CONSENT_GENERATION_MISMATCH]');
    expect(reader.calls).toBe(0);
  });

  it('denies a registry that serves a foreign-tenant generation under the caller context', async () => {
    const authorityRegistry = new FakeConsentRegistry();
    const fence = createConsentAuthorizationFence(grantConsent(authorityRegistry), CLOCK);

    const registry = new FakeConsentRegistry();
    const foreignGeneration = grantConsent(registry, { tenantId: TEST_TENANT_B });
    // Cross-wired read path: tenant A's context is served tenant B's record.
    vi.spyOn(registry, 'get').mockReturnValue(foreignGeneration);

    const reader = new RecordingReader(new FakeSourceReader());
    const auditSink = new InMemorySourceAuditSink();
    const guardedReader = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]),
      policy: POLICY,
      auditSink,
      nowProvider: () => CLOCK,
      authority: pinnedAuthority(authorityRegistry),
      requireAuthorizationFence: true,
    });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    expect(denial.code).toBe('POLICY_DENIED');
    expect(denial.diagnostic).toContain('[code: TENANT_MISMATCH]');
    expect(reader.calls).toBe(0);
    expect(recordsOf(auditSink)[0]?.denialCode).toBe('TENANT_MISMATCH');
  });

  it('discards the snapshot when the registry diverges from the fence mid-read', async () => {
    const authorityRegistry = new FakeConsentRegistry();
    const currentGeneration = grantConsent(authorityRegistry);
    const fence = createConsentAuthorizationFence(currentGeneration, CLOCK);

    const otherRegistry = new FakeConsentRegistry();
    const otherGeneration = grantConsent(otherRegistry);

    let served: ConsentGrant = currentGeneration;
    const registry = new FakeConsentRegistry();
    vi.spyOn(registry, 'get').mockImplementation(() => served);
    const reader = new RecordingReader(new FakeSourceReader(), () => {
      served = otherGeneration;
    });
    const auditSink = new InMemorySourceAuditSink();
    const guardedReader = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map<string, SourceProfile>([[PROFILE_ID, FIXTURE_PROFILE_RELEASES]]),
      policy: POLICY,
      auditSink,
      nowProvider: () => CLOCK,
      authority: pinnedAuthority(authorityRegistry),
      requireAuthorizationFence: true,
    });

    const denial = await captureDenial(
      guardedReader.readSnapshot(PROFILE_ID, buildContext(fence), readSignal()),
    );

    // Status is still `active` and the fence is still valid: only the binding check catches this.
    expect(denial.diagnostic).toContain('[code: REVOKED_DURING_EXECUTION]');
    expect(reader.calls).toBe(1);
    expect(recordsOf(auditSink).at(-1)?.denialCode).toBe('REVOKED_DURING_EXECUTION');
  });
});

describe('P0-C3C: generation binding validator', () => {
  const registry = new FakeConsentRegistry();
  const grant = registry.grant(
    {
      tenantId: TEST_TENANT_A,
      sourceProfileId: PROFILE_ID,
      scopes: [SOURCE_READ_SCOPE],
      allowedOperations: [SOURCE_READ_OPERATION],
    },
    CLOCK,
  );
  const fence = createConsentAuthorizationFence(grant, CLOCK);

  it('binds only the exact generation named by the fence', () => {
    const bound = validateConsentGenerationBinding({
      grant,
      fence,
      tenantId: TEST_TENANT_A,
      sourceProfileId: PROFILE_ID,
    });
    expect(bound.consistent).toBe(true);
    expect(bound.code).toBe('VALID');
    expect(bound.denialCode).toBeNull();

    const cases: readonly {
      readonly grant: ConsentGrant | null;
      readonly fence: unknown;
      readonly expected: string;
    }[] = [
      // Same lineage, but a re-granted (newer) generation.
      {
        grant: { ...grant, version: grant.version + 1 },
        fence,
        expected: 'CONSENT_GENERATION_MISMATCH',
      },
      {
        grant: { ...grant, grantId: `${grant.grantId}-other` },
        fence,
        expected: 'CONSENT_GENERATION_MISMATCH',
      },
      { grant: { ...grant, tenantId: TEST_TENANT_B }, fence, expected: 'TENANT_MISMATCH' },
      { grant: null, fence, expected: 'CONSENT_NOT_FOUND' },
      { grant, fence: { ...fence, tenantId: TEST_TENANT_B }, expected: 'TENANT_MISMATCH' },
      { grant, fence: { ...fence, digest: 'not-a-digest' }, expected: 'CONSENT_FENCE_INVALID' },
    ];

    for (const testCase of cases) {
      const result = validateConsentGenerationBinding({
        grant: testCase.grant,
        fence: testCase.fence,
        tenantId: TEST_TENANT_A,
        sourceProfileId: PROFILE_ID,
      });
      expect(`${result.denialCode}`).toBe(testCase.expected);
      expect(result.consistent).toBe(false);
    }
  });

  it('leaves fence-less reads unbound (backward compatibility)', () => {
    for (const absent of [undefined, null]) {
      expect(
        validateConsentGenerationBinding({
          grant,
          fence: absent,
          tenantId: TEST_TENANT_A,
          sourceProfileId: PROFILE_ID,
        }).consistent,
      ).toBe(true);
    }
  });

  it('fails closed on a hostile grant object without throwing', () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom');
        },
      },
    ) as unknown as ConsentGrant;

    const result = validateConsentGenerationBinding({
      grant: hostile,
      fence,
      tenantId: TEST_TENANT_A,
      sourceProfileId: PROFILE_ID,
    });

    expect(result.consistent).toBe(false);
    expect(result.denialCode).toBe('CONSENT_GENERATION_MISMATCH');
  });
});
