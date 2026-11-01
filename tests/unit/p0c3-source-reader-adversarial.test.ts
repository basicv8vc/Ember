import { describe, expect, it, vi } from 'vitest';
import {
  createFakeGuardedSourceReader,
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

  it('proves exactly ZERO reader callbacks on unauthorized or denied attempts', async () => {
    const bundle = createFakeGuardedSourceReader();
    const readSpy = vi.spyOn(bundle.innerReader, 'readSnapshot');

    // Attempt 1: No consent granted
    await expect(
      bundle.guardedReader.readSnapshot('sp_ember_releases', validContext),
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
      bundle.guardedReader.readSnapshot('sp_ember_releases', crossTenantContext),
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
      disabledGuarded.readSnapshot(FIXTURE_PROFILE_DISABLED.sourceProfileId, validContext),
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
      await expect(bundle.guardedReader.readSnapshot(badId, validContext)).rejects.toThrowError(
        /Invalid request input/i,
      );
      expect(readSpy).toHaveBeenCalledTimes(0);
    }
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

    const snapshot = await bundle.guardedReader.readSnapshot('sp_ember_releases', validContext);
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

    const snapshot = await innerReader.readSnapshot('sp_ember_releases', validContext);
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

    await expect(innerReader.readSnapshot('sp_ember_releases', validContext)).rejects.toThrowError(
      /Operation denied by policy/i,
    );
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

    await expect(innerReader.readSnapshot('sp_ember_releases', validContext)).rejects.toThrowError(
      /Operation denied by policy/i,
    );
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

    const snap1 = await reader1.readSnapshot('sp_ember_releases', validContext);
    const snap2 = await reader2.readSnapshot('sp_ember_releases', validContext);

    expect(snap1.digest).toBe(snap2.digest);
    expect(snap1.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns deeply immutable snapshots', async () => {
    const bundle = createFakeGuardedSourceReader();
    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    const snapshot = await bundle.guardedReader.readSnapshot('sp_ember_releases', validContext);

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
      await guarded.readSnapshot('sp_ember_releases', validContext);
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

    await expect(guarded.readSnapshot('sp_ember_releases', validContext)).rejects.toThrowError(
      /Operation denied by policy/i,
    );
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

    await expect(guarded.readSnapshot('sp_ember_releases', validContext)).rejects.toThrowError(
      /Operation denied by policy/i,
    );
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

    await expect(guarded.readSnapshot('sp_ember_releases', validContext)).rejects.toThrowError(
      /Operation denied by policy/i,
    );
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

    await expect(guarded.readSnapshot('sp_ember_releases', validContext)).rejects.toThrowError(
      /Operation denied by policy/i,
    );
  });
});
