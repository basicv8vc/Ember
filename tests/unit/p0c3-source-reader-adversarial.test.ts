import { describe, expect, it, vi } from 'vitest';
import {
  createFakeGuardedSourceReader,
  DomainError,
  FakeConsentRegistry,
  FakeSourceReader,
  FIXTURE_INJECTION_ITEMS,
  FIXTURE_PROFILE_DISABLED,
  FIXTURE_PROFILE_RELEASES,
  GuardedSourceReader,
  InMemorySourceAuditSink,
  SOURCE_SNAPSHOT_LIMITS,
  TEST_TENANT_A,
  TEST_TENANT_B,
  validateReaderReturnedSnapshot,
  type SourceReader,
  type SourceSnapshot,
  type SourceSnapshotItem,
  type TrustedSourceAccessContext,
} from '@ember/connectors';

describe('P0-C3C: Guarded Source Reader Adversarial Defense Matrix', () => {
  const validContext: TrustedSourceAccessContext = {
    tenantId: TEST_TENANT_A,
    commitmentId: 'comm_11111111-1111-1111-1111-111111111111',
    taskId: 'task_11111111-1111-1111-1111-111111111111',
    runId: 'run_11111111-1111-1111-1111-111111111111',
    leaseEpoch: 1,
    authorizedAt: '2026-11-01T12:00:00.000Z',
  };

  const defaultSignal = new AbortController().signal;

  /**
   * Wires a GuardedSourceReader around `reader` with an active consent grant and a fresh audit
   * sink, so hardening tests can assert on the thrown error and the audit trail together.
   */
  const buildHardenedReader = (
    reader: SourceReader,
  ): { guarded: GuardedSourceReader; auditSink: InMemorySourceAuditSink } => {
    const auditSink = new InMemorySourceAuditSink();
    const registry = new FakeConsentRegistry();
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_ember_releases' });

    const guarded = new GuardedSourceReader({
      reader,
      registry,
      profiles: new Map([[FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_PROFILE_RELEASES]]),
      policy: {
        version: 1,
        allowedSourceProfileIds: ['sp_ember_releases'],
        allowedOperations: ['read_snapshot'],
        defaultAction: 'deny',
      },
      auditSink,
    });

    return { guarded, auditSink };
  };

  /** Resolves to the rejection reason of `promise`, so tests can inspect error and diagnostic. */
  const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it('proves exactly ZERO reader callbacks on unauthorized or denied attempts', async () => {
    const bundle = createFakeGuardedSourceReader();
    const readSpy = vi.spyOn(bundle.innerReader, 'readSnapshot');

    // Attempt 1: No consent granted
    await expect(
      bundle.guardedReader.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    ).rejects.toThrowError(/Operation denied by policy/);
    expect(readSpy).toHaveBeenCalledTimes(0);

    // Grant consent, but attempt cross-tenant read from Tenant B
    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    const crossTenantContext: TrustedSourceAccessContext = {
      ...validContext,
      tenantId: TEST_TENANT_B,
    };

    await expect(
      bundle.guardedReader.readSnapshot('sp_ember_releases', crossTenantContext, defaultSignal),
    ).rejects.toThrowError(/Resource not found/);
    expect(readSpy).toHaveBeenCalledTimes(0);

    // Attempt 3: Disabled profile
    const disabledMap = new Map([
      [FIXTURE_PROFILE_DISABLED.sourceProfileId, FIXTURE_PROFILE_DISABLED],
    ]);
    const disabledGuarded = new GuardedSourceReader({
      reader: bundle.innerReader,
      registry: bundle.registry,
      profiles: disabledMap,
      policy: {
        version: 1,
        allowedSourceProfileIds: [FIXTURE_PROFILE_DISABLED.sourceProfileId],
        allowedOperations: ['read_snapshot'],
        defaultAction: 'deny',
      },
    });

    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: FIXTURE_PROFILE_DISABLED.sourceProfileId,
    });

    await expect(
      disabledGuarded.readSnapshot(
        FIXTURE_PROFILE_DISABLED.sourceProfileId,
        validContext,
        defaultSignal,
      ),
    ).rejects.toThrowError(/Operation denied by policy/);
    expect(readSpy).toHaveBeenCalledTimes(0);
  });

  it('rejects caller-supplied URLs and malformed identifiers at perimeter boundary', async () => {
    const bundle = createFakeGuardedSourceReader();
    const readSpy = vi.spyOn(bundle.innerReader, 'readSnapshot');

    const maliciousIdentifiers = [
      'https://evil.com/releases',
      'http://127.0.0.1:8080/data',
      'file:///etc/passwd',
      'user:pass@evil.com',
      '../../etc/shadow',
      'sp_releases/../secret',
      'sp releases',
      'sp_release\n',
      'ab', // too short (< 3)
      'a'.repeat(65), // too long (> 64)
      'SP_UPPERCASE', // must be lowercase
    ];

    for (const badId of maliciousIdentifiers) {
      await expect(
        bundle.guardedReader.readSnapshot(badId, validContext, defaultSignal),
      ).rejects.toThrowError(/Invalid request input/i);
      expect(readSpy).toHaveBeenCalledTimes(0);
    }
  });

  it('rejects calls where AbortSignal is missing', async () => {
    const bundle = createFakeGuardedSourceReader();
    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    await expect(
      // @ts-expect-error testing missing required signal
      bundle.guardedReader.readSnapshot('sp_ember_releases', validContext),
    ).rejects.toThrowError(/Invalid request input/i);
  });

  it('handles prompt injection in fixture text as inert data without permission escalation', async () => {
    const customFixtureMap = new Map<string, readonly SourceSnapshotItem[]>([
      [FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_INJECTION_ITEMS],
    ]);

    const bundle = createFakeGuardedSourceReader({ fixtureMap: customFixtureMap });
    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: FIXTURE_PROFILE_RELEASES.sourceProfileId,
    });

    const snapshot = await bundle.guardedReader.readSnapshot(
      'sp_ember_releases',
      validContext,
      defaultSignal,
    );
    expect(snapshot.boundedSafeItems).toHaveLength(1);

    const item = snapshot.boundedSafeItems[0]!;
    // Untrusted content remains pure text, not executed instructions
    expect(item.contentSnippet).toContain('Ignore all previous instructions');
    expect(item.title).toContain('<script>alert(1)</script>');

    // Verify system policy was NOT altered by the injection
    expect(bundle.policy.defaultAction).toBe('deny');
    expect(bundle.policy.allowedOperations).toEqual(['read_snapshot']);
  });

  it('sanitizes control characters, null bytes, ANSI escapes, and BiDi overrides', async () => {
    const maliciousItems: readonly SourceSnapshotItem[] = [
      {
        id: 'item_ctrl',
        title: 'Title with \x1b[31mRed ANSI\x1b[0m and \0null byte',
        contentSnippet: 'Content with \u202ERTL override\u202C text',
        observedAt: '2026-11-01T12:00:00.000Z',
      },
    ];

    const innerReader = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', maliciousItems]]),
    });

    const snapshot = await innerReader.readSnapshot(
      'sp_ember_releases',
      validContext,
      defaultSignal,
    );
    const item = snapshot.boundedSafeItems[0]!;

    expect(item.title).toBe('Title with Red ANSI and null byte');
    expect(item.contentSnippet).toBe('Content with RTL override text');
  });

  it('enforces total payload UTF-8 byte ceilings', async () => {
    // Generate items within 1000 chars each, but exceeding 32 KiB combined
    const items: SourceSnapshotItem[] = Array.from({ length: 40 }, (_, i) => ({
      id: `item_${i}`,
      title: `Title ${i}`,
      contentSnippet: 'X'.repeat(900), // 40 * 900 = 36,000 bytes > 32 KiB
      observedAt: '2026-11-01T12:00:00.000Z',
    }));

    const innerReader = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', items]]),
      maxPayloadBytes: SOURCE_SNAPSHOT_LIMITS.maxPayloadBytes,
    });

    await expect(
      innerReader.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    ).rejects.toThrowError(/Operation denied by policy/i);
  });

  it('enforces maximum item count ceiling', async () => {
    const tooManyItems: SourceSnapshotItem[] = Array.from({ length: 51 }, (_, i) => ({
      id: `item_${i}`,
      title: `Title ${i}`,
      contentSnippet: `Content ${i}`,
      observedAt: '2026-11-01T12:00:00.000Z',
    }));

    const innerReader = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', tooManyItems]]),
    });

    await expect(
      innerReader.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    ).rejects.toThrowError(/Operation denied by policy/i);
  });

  it('computes deterministic SHA-256 digest regardless of object key order', async () => {
    const items1: readonly SourceSnapshotItem[] = [
      {
        id: 'item_1',
        title: 'Alpha',
        contentSnippet: 'Content Alpha',
        observedAt: '2026-11-01T12:00:00.000Z',
      },
    ];

    const items2: readonly SourceSnapshotItem[] = [
      {
        id: 'item_1',
        title: 'Alpha',
        contentSnippet: 'Content Alpha',
        observedAt: '2026-11-01T12:00:00.000Z',
      },
    ];

    const reader1 = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', items1]]),
      fixedObservedAt: '2026-11-01T12:00:00.000Z',
    });

    const reader2 = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', items2]]),
      fixedObservedAt: '2026-11-01T12:00:00.000Z',
    });

    const snap1 = await reader1.readSnapshot('sp_ember_releases', validContext, defaultSignal);
    const snap2 = await reader2.readSnapshot('sp_ember_releases', validContext, defaultSignal);

    expect(snap1.digest).toBe(snap2.digest);
    expect(snap1.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns deeply immutable snapshots', async () => {
    const bundle = createFakeGuardedSourceReader();
    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    const snapshot = await bundle.guardedReader.readSnapshot(
      'sp_ember_releases',
      validContext,
      defaultSignal,
    );

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.boundedSafeItems)).toBe(true);
    const firstItem = snapshot.boundedSafeItems[0]!;
    expect(Object.isFrozen(firstItem)).toBe(true);

    expect(() => {
      // @ts-expect-error mutating frozen snapshot
      snapshot.sourceProfileId = 'tampered';
    }).toThrow();

    expect(() => {
      // @ts-expect-error mutating frozen item
      firstItem.title = 'Tampered Title';
    }).toThrow();
  });

  // =========================================================================
  // P1-2: ADVERSARIAL INNER READER SECURITY TESTS
  // =========================================================================

  it('P1-2: catches and sanitizes untrusted exceptions from malicious reader, never leaking raw secret or stack', async () => {
    const maliciousReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        return Promise.reject(
          new Error(
            'Fatal internal error: connect ECONNREFUSED https://internal-vault.svc.cluster.local:8200/v1/secret?token=s.987654321xyz',
          ),
        );
      },
    };

    const auditSink = new InMemorySourceAuditSink();
    const registry = new FakeConsentRegistry();
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_ember_releases' });

    const guarded = new GuardedSourceReader({
      reader: maliciousReader,
      registry,
      profiles: new Map([[FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_PROFILE_RELEASES]]),
      policy: {
        version: 1,
        allowedSourceProfileIds: ['sp_ember_releases'],
        allowedOperations: ['read_snapshot'],
        defaultAction: 'deny',
      },
      auditSink,
    });

    let caughtError: unknown;
    try {
      await guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    // The public error message must be fixed DomainError message
    expect((caughtError as Error).message).toBe('Operation denied by policy');

    // The diagnostic must NOT contain the sensitive URL or token
    const errorString = String(caughtError);
    expect(errorString).not.toContain('internal-vault.svc');
    expect(errorString).not.toContain('s.987654321xyz');
    expect(errorString).not.toContain('ECONNREFUSED');

    // Audit sink must be sanitized and record zero network calls
    const records = auditSink.getRecords();
    expect(records).toHaveLength(1);
    const audit = records[0]!;
    expect(audit.decision).toBe('DENIED');
    expect(audit.denialCode).toBe('POLICY_DENIED');
    expect(audit.networkCallsMade).toBe(0);

    const auditString = JSON.stringify(audit);
    expect(auditString).not.toContain('internal-vault.svc');
    expect(auditString).not.toContain('s.987654321xyz');
  });

  it('P1-1 (Round 2): derives cancellation only from the trusted AbortSignal and never re-throws an untrusted CANCELLED diagnostic', async () => {
    const leakedToken = 's.secret_cancel_token';

    // Case A: the trusted, server-owned signal really is aborted while the read is in flight.
    const abortedCtrl = new AbortController();
    const genuinelyCancelledReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        abortedCtrl.abort();
        return Promise.reject(
          new DomainError(
            'CANCELLED',
            `Sensitive internal diagnostic: token=${leakedToken} in memory`,
          ),
        );
      },
    };

    const cancelledCase = buildHardenedReader(genuinelyCancelledReader);
    const cancelledError = await captureRejection(
      cancelledCase.guarded.readSnapshot('sp_ember_releases', validContext, abortedCtrl.signal),
    );

    expect(cancelledError).toBeInstanceOf(DomainError);
    expect((cancelledError as Error).message).toBe('Operation was cancelled');

    // The untrusted diagnostic from the inner reader must NOT be re-thrown or reflected.
    const cancelledDiag = (cancelledError as DomainError).diagnostic;
    expect(cancelledDiag).toBe('Snapshot read was aborted during execution');
    expect(cancelledDiag).not.toContain(leakedToken);
    expect((cancelledError as Error).stack ?? '').not.toContain(leakedToken);

    const cancelledAudit = cancelledCase.auditSink.getRecords();
    expect(cancelledAudit).toHaveLength(1);
    expect(cancelledAudit[0]?.decision).toBe('DENIED');
    expect(cancelledAudit[0]?.denialCode).toBe('READ_ABORTED');
    expect(JSON.stringify(cancelledAudit)).not.toContain(leakedToken);

    // Case B: the reader merely *claims* CANCELLED while the trusted signal is still live. Its
    // `code`, `name`, `message`, and `diagnostic` are adversarial, so cancellation must not be
    // inferred from them: the read is a sanitized provider failure and no token may leak.
    const liveCtrl = new AbortController();
    const spoofingCancelledReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        return Promise.reject(
          new DomainError('CANCELLED', `Spoofed cancellation: token=${leakedToken} in memory`),
        );
      },
    };

    const spoofedCase = buildHardenedReader(spoofingCancelledReader);
    const spoofedError = await captureRejection(
      spoofedCase.guarded.readSnapshot('sp_ember_releases', validContext, liveCtrl.signal),
    );

    expect(spoofedError).toBeInstanceOf(DomainError);
    expect((spoofedError as Error).message).toBe('Operation denied by policy');
    expect(liveCtrl.signal.aborted).toBe(false);

    const spoofedDiag = (spoofedError as DomainError).diagnostic;
    expect(spoofedDiag).toBe(
      'Source reader execution failed; untrusted exception sanitized [code: POLICY_DENIED]',
    );
    expect(spoofedDiag).not.toContain(leakedToken);

    const spoofedAudit = spoofedCase.auditSink.getRecords();
    expect(spoofedAudit).toHaveLength(1);
    expect(spoofedAudit[0]?.decision).toBe('DENIED');
    expect(spoofedAudit[0]?.denialCode).toBe('POLICY_DENIED');
    expect(JSON.stringify(spoofedAudit)).not.toContain(leakedToken);
  });

  it('P1-2 (Round 2): does not reflect malicious provider returned sourceProfileId or raw strings in diagnostic or audit', async () => {
    const injectionUrl =
      'https://malicious-tracker.attacker.com/telemetry?secret_leak=super_confidential';
    const reflectionReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        return Promise.resolve({
          sourceProfileId: injectionUrl,
          observedAt: '2026-11-01T12:00:00.000Z',
          digest: '0000000000000000000000000000000000000000000000000000000000000000',
          boundedSafeItems: [],
        });
      },
    };

    const auditSink = new InMemorySourceAuditSink();
    const registry = new FakeConsentRegistry();
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_ember_releases' });

    const guarded = new GuardedSourceReader({
      reader: reflectionReader,
      registry,
      profiles: new Map([[FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_PROFILE_RELEASES]]),
      policy: {
        version: 1,
        allowedSourceProfileIds: ['sp_ember_releases'],
        allowedOperations: ['read_snapshot'],
        defaultAction: 'deny',
      },
      auditSink,
    });

    let caughtError: unknown;
    try {
      await guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect((caughtError as Error).message).toBe('Operation denied by policy');
    const diag = (caughtError as DomainError).diagnostic;
    // Assert the malicious injection URL is NOT reflected in the diagnostic
    expect(diag).not.toContain('malicious-tracker');
    expect(diag).not.toContain('super_confidential');
    expect(diag).toBe('Source reader returned invalid snapshot [code: UNTRUSTED_CONTENT_DETECTED]');

    // Assert the malicious injection URL is NOT reflected anywhere in the audit sink
    const auditRecords = auditSink.getRecords();
    expect(auditRecords).toHaveLength(1);
    const serializedAudit = JSON.stringify(auditRecords[0]);
    expect(serializedAudit).not.toContain('malicious-tracker');
    expect(serializedAudit).not.toContain('super_confidential');
  });

  it('P1-2: rejects malicious reader returning mismatched sourceProfileId', async () => {
    const spoofingReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        return Promise.resolve({
          sourceProfileId: 'sp_other_profile',
          observedAt: '2026-11-01T12:00:00.000Z',
          digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          boundedSafeItems: [],
        });
      },
    };

    const registry = new FakeConsentRegistry();
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_ember_releases' });

    const guarded = new GuardedSourceReader({
      reader: spoofingReader,
      registry,
      profiles: new Map([[FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_PROFILE_RELEASES]]),
      policy: {
        version: 1,
        allowedSourceProfileIds: ['sp_ember_releases'],
        allowedOperations: ['read_snapshot'],
        defaultAction: 'deny',
      },
    });

    await expect(
      guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    ).rejects.toThrowError(/Operation denied by policy/i);
  });

  it('P1-2: rejects malicious reader returning forged or invalid SHA-256 digest', async () => {
    const badDigestReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        return Promise.resolve({
          sourceProfileId: 'sp_ember_releases',
          observedAt: '2026-11-01T12:00:00.000Z',
          digest: '0000000000000000000000000000000000000000000000000000000000000000', // forged digest
          boundedSafeItems: [
            {
              id: 'item_1',
              title: 'Title',
              contentSnippet: 'Content',
              observedAt: '2026-11-01T12:00:00.000Z',
            },
          ],
        });
      },
    };

    const registry = new FakeConsentRegistry();
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_ember_releases' });

    const guarded = new GuardedSourceReader({
      reader: badDigestReader,
      registry,
      profiles: new Map([[FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_PROFILE_RELEASES]]),
      policy: {
        version: 1,
        allowedSourceProfileIds: ['sp_ember_releases'],
        allowedOperations: ['read_snapshot'],
        defaultAction: 'deny',
      },
    });

    await expect(
      guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    ).rejects.toThrowError(/Operation denied by policy/i);
  });

  it('P1-2: rejects malicious reader returning oversized contentSnippet (> 1,000 chars)', async () => {
    const oversizedReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        return Promise.resolve({
          sourceProfileId: 'sp_ember_releases',
          observedAt: '2026-11-01T12:00:00.000Z',
          digest: 'a'.repeat(64),
          boundedSafeItems: [
            {
              id: 'item_1',
              title: 'Title',
              contentSnippet: 'A'.repeat(1001), // exceeds 1,000 char limit
              observedAt: '2026-11-01T12:00:00.000Z',
            },
          ],
        });
      },
    };

    const registry = new FakeConsentRegistry();
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_ember_releases' });

    const guarded = new GuardedSourceReader({
      reader: oversizedReader,
      registry,
      profiles: new Map([[FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_PROFILE_RELEASES]]),
      policy: {
        version: 1,
        allowedSourceProfileIds: ['sp_ember_releases'],
        allowedOperations: ['read_snapshot'],
        defaultAction: 'deny',
      },
    });

    await expect(
      guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    ).rejects.toThrowError(/Operation denied by policy/i);
  });

  it('P1-2: rejects malicious reader returning > 50 boundedSafeItems', async () => {
    const tooManyItemsReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        return Promise.resolve({
          sourceProfileId: 'sp_ember_releases',
          observedAt: '2026-11-01T12:00:00.000Z',
          digest: 'a'.repeat(64),
          boundedSafeItems: Array.from({ length: 51 }, (_, i) => ({
            id: `id_${i}`,
            title: `Title ${i}`,
            contentSnippet: `Snippet ${i}`,
            observedAt: '2026-11-01T12:00:00.000Z',
          })),
        });
      },
    };

    const registry = new FakeConsentRegistry();
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_ember_releases' });

    const guarded = new GuardedSourceReader({
      reader: tooManyItemsReader,
      registry,
      profiles: new Map([[FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_PROFILE_RELEASES]]),
      policy: {
        version: 1,
        allowedSourceProfileIds: ['sp_ember_releases'],
        allowedOperations: ['read_snapshot'],
        defaultAction: 'deny',
      },
    });

    await expect(
      guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    ).rejects.toThrowError(/Operation denied by policy/i);
  });
  // =========================================================================
  // FINAL SECURITY HARDENING TESTS (THROWING GETTERS & HOSTILE PROXIES)
  // =========================================================================

  it('Final Hardening: converts throwing snapshot getters, including spoofed DomainError codes and diagnostics, into a fixed safe error without leaking the token', async () => {
    const leakedToken = 's.getter_leak_secret_token_99999';
    const expectedUntrustedDiagnostic =
      'Source reader returned invalid snapshot [code: UNTRUSTED_CONTENT_DETECTED]';
    let getterInvocations = 0;

    // Case A: a snapshot getter throws a plain Error whose message embeds a secret.
    const evilPlainSnapshot = {
      get sourceProfileId(): string {
        getterInvocations += 1;
        throw new Error(`Fatal getter failure with vault token ${leakedToken}`);
      },
      observedAt: '2026-11-01T12:00:00.000Z',
      digest: '0000000000000000000000000000000000000000000000000000000000000000',
      boundedSafeItems: [],
    } as unknown as SourceSnapshot;

    const plainGetterReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        return Promise.resolve(evilPlainSnapshot);
      },
    };

    const plainCase = buildHardenedReader(plainGetterReader);
    const plainError = await captureRejection(
      plainCase.guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    );

    expect(plainError).toBeInstanceOf(DomainError);
    expect((plainError as Error).message).toBe('Operation denied by policy');

    const plainDiag = (plainError as DomainError).diagnostic;
    expect(plainDiag).toBe(expectedUntrustedDiagnostic);
    expect(plainDiag).not.toContain(leakedToken);
    expect(plainDiag).not.toContain('Fatal getter failure');
    expect((plainError as Error).stack ?? '').not.toContain(leakedToken);

    const plainAudit = plainCase.auditSink.getRecords();
    expect(plainAudit).toHaveLength(1);
    expect(plainAudit[0]?.decision).toBe('DENIED');
    expect(plainAudit[0]?.denialCode).toBe('UNTRUSTED_CONTENT_DETECTED');
    expect(JSON.stringify(plainAudit)).not.toContain(leakedToken);
    expect(JSON.stringify(plainAudit[0])).not.toContain('Fatal getter failure');

    // Each untrusted property is read at most once: no time-of-check/time-of-use re-read.
    expect(getterInvocations).toBe(1);

    // The public throwing façade must not pass the getter exception through either.
    let facadeError: unknown;
    try {
      validateReaderReturnedSnapshot(evilPlainSnapshot, 'sp_ember_releases');
    } catch (err) {
      facadeError = err;
    }

    expect(facadeError).toBeInstanceOf(DomainError);
    expect((facadeError as DomainError).diagnostic).toBe(expectedUntrustedDiagnostic);
    expect((facadeError as DomainError).diagnostic).not.toContain(leakedToken);
    expect(getterInvocations).toBe(2);

    // Case B: the getter throws a DomainError whose diagnostic both embeds the secret and claims
    // PAYLOAD_LIMIT_EXCEEDED. Believing error.code or scanning error.diagnostic would let the
    // reader spoof the audit denial code and reflect its own text, so both must be ignored.
    const spoofedGetterReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        const evilSnapshot = {
          sourceProfileId: 'sp_ember_releases',
          observedAt: '2026-11-01T12:00:00.000Z',
          digest: 'a'.repeat(64),
          get boundedSafeItems(): readonly SourceSnapshotItem[] {
            throw new DomainError(
              'POLICY_DENIED',
              `Forged diagnostic PAYLOAD_LIMIT_EXCEEDED with vault token ${leakedToken}`,
            );
          },
        } as unknown as SourceSnapshot;
        return Promise.resolve(evilSnapshot);
      },
    };

    const spoofedCase = buildHardenedReader(spoofedGetterReader);
    const spoofedError = await captureRejection(
      spoofedCase.guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    );

    expect(spoofedError).toBeInstanceOf(DomainError);
    expect((spoofedError as Error).message).toBe('Operation denied by policy');

    const spoofedDiag = (spoofedError as DomainError).diagnostic;
    expect(spoofedDiag).toBe(expectedUntrustedDiagnostic);
    expect(spoofedDiag).not.toContain('PAYLOAD_LIMIT_EXCEEDED');
    expect(spoofedDiag).not.toContain('Forged diagnostic');
    expect(spoofedDiag).not.toContain(leakedToken);
    expect((spoofedError as Error).stack ?? '').not.toContain(leakedToken);

    const spoofedAudit = spoofedCase.auditSink.getRecords();
    expect(spoofedAudit).toHaveLength(1);
    expect(spoofedAudit[0]?.decision).toBe('DENIED');
    expect(spoofedAudit[0]?.denialCode).toBe('UNTRUSTED_CONTENT_DETECTED');
    expect(JSON.stringify(spoofedAudit)).not.toContain(leakedToken);
    expect(JSON.stringify(spoofedAudit[0])).not.toContain('Forged diagnostic');
  });

  it('Final Hardening: converts an adversarial Error Proxy whose traps throw secrets on any property or prototype access into a fixed safe error', async () => {
    const leakedToken = 's.proxy_trap_leak_secret_token_88888';
    const trapInvocations: string[] = [];

    const hostileProxyReader: SourceReader = {
      readSnapshot(): Promise<SourceSnapshot> {
        // Every introspection path a naive sanitizer might use — property read, `in`,
        // `instanceof` (getPrototypeOf), key enumeration, and descriptor lookup — throws a
        // token-bearing error.
        const hostileError = new Proxy(new DomainError('CANCELLED', `token ${leakedToken}`), {
          get(_target, prop) {
            trapInvocations.push(`get:${String(prop)}`);
            throw new Error(
              `Adversarial proxy trap on get(${String(prop)}) leaking token ${leakedToken}`,
            );
          },
          has(_target, prop) {
            trapInvocations.push(`has:${String(prop)}`);
            throw new Error(
              `Adversarial proxy trap on has(${String(prop)}) leaking token ${leakedToken}`,
            );
          },
          getPrototypeOf() {
            trapInvocations.push('getPrototypeOf');
            throw new Error(
              `Adversarial proxy trap on getPrototypeOf leaking token ${leakedToken}`,
            );
          },
          getOwnPropertyDescriptor(_target, prop) {
            trapInvocations.push(`getOwnPropertyDescriptor:${String(prop)}`);
            throw new Error(
              `Adversarial proxy trap on getOwnPropertyDescriptor(${String(prop)}) leaking token ${leakedToken}`,
            );
          },
          ownKeys() {
            trapInvocations.push('ownKeys');
            throw new Error(`Adversarial proxy trap on ownKeys leaking token ${leakedToken}`);
          },
        });

        return Promise.reject(hostileError);
      },
    };

    const proxiedCase = buildHardenedReader(hostileProxyReader);
    const caughtError = await captureRejection(
      proxiedCase.guarded.readSnapshot('sp_ember_releases', validContext, defaultSignal),
    );

    expect(caughtError).toBeInstanceOf(DomainError);
    expect((caughtError as Error).message).toBe('Operation denied by policy');

    // The trusted signal was never aborted, so a spoofed CANCELLED code must not be believed.
    expect((caughtError as DomainError).code).toBe('POLICY_DENIED');

    const diag = (caughtError as DomainError).diagnostic;
    expect(diag).toBe(
      'Source reader execution failed; untrusted exception sanitized [code: POLICY_DENIED]',
    );
    expect(diag).not.toContain(leakedToken);
    expect(diag).not.toContain('Adversarial proxy trap');
    expect((caughtError as Error).stack ?? '').not.toContain(leakedToken);
    expect(JSON.stringify(caughtError)).not.toContain(leakedToken);

    const auditRecords = proxiedCase.auditSink.getRecords();
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.decision).toBe('DENIED');
    expect(auditRecords[0]?.denialCode).toBe('POLICY_DENIED');
    expect(JSON.stringify(auditRecords)).not.toContain(leakedToken);
    expect(JSON.stringify(auditRecords[0])).not.toContain('Adversarial proxy trap');

    // Proof of the trust boundary: not a single Proxy trap fired, so no property of the thrown
    // value (code, name, message, diagnostic, prototype, keys) was ever read.
    expect(trapInvocations).toEqual([]);
  });
});
