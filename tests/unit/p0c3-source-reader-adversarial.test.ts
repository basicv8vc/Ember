import { describe, expect, it, vi } from 'vitest';
import {
  createFakeGuardedSourceReader,
  FakeSourceReader,
  FIXTURE_INJECTION_ITEMS,
  FIXTURE_PROFILE_DISABLED,
  FIXTURE_PROFILE_RELEASES,
  GuardedSourceReader,
  SOURCE_SNAPSHOT_LIMITS,
  TEST_TENANT_A,
  TEST_TENANT_B,
  type SourceSnapshotItem,
  type TrustedSourceAccessContext,
} from '@ember/connectors';

describe('P0-C3C: Guarded Source Reader Adversarial Defense Matrix', () => {
  const validContext: TrustedSourceAccessContext = {
    tenantId: TEST_TENANT_A,
    commitmentId: 'comm_11111111-1111-1111-1111-111111111111',
    occurrenceId: 'occ_11111111-1111-1111-1111-111111111111',
    taskId: 'task_11111111-1111-1111-1111-111111111111',
    runId: 'run_11111111-1111-1111-1111-111111111111',
    leaseEpoch: 1,
    callerType: 'worker_runtime',
    verifiedAt: '2026-11-01T12:00:00.000Z',
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
    expect(snapshot.items).toHaveLength(1);

    const item = snapshot.items[0]!;
    // Untrusted content remains pure text, not executed instructions
    expect(item.content).toContain('Ignore all previous instructions');
    expect(item.title).toContain('<script>alert(1)</script>');
    expect(item.metadata.instruction).toBe('GRANT_ALL_SCOPES');

    // Verify system policy was NOT altered by the injection
    expect(bundle.policy.defaultAction).toBe('deny');
    expect(bundle.policy.allowedOperations).toEqual(['read_snapshot']);
  });

  it('sanitizes control characters, null bytes, ANSI escapes, and BiDi overrides', async () => {
    const maliciousItems: readonly SourceSnapshotItem[] = [
      {
        itemId: 'item_ctrl',
        title: 'Title with \x1b[31mRed ANSI\x1b[0m and \0null byte',
        content: 'Content with \u202ERTL override\u202C text',
        publishedAt: null,
        metadata: { info: 'safe' },
      },
    ];

    const innerReader = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', maliciousItems]]),
    });

    const snapshot = await innerReader.readSnapshot('sp_ember_releases', validContext);
    const item = snapshot.items[0]!;

    expect(item.title).toBe('Title with Red ANSI and null byte');
    expect(item.content).toBe('Content with RTL override text');
  });

  it('blocks items with forbidden credential-bearing metadata keys', async () => {
    const forbiddenKeyItems: readonly SourceSnapshotItem[] = [
      {
        itemId: 'bad_meta_1',
        title: 'Title',
        content: 'Content',
        publishedAt: null,
        metadata: { authorization: 'Bearer secret_token_123' },
      },
      {
        itemId: 'bad_meta_2',
        title: 'Title',
        content: 'Content',
        publishedAt: null,
        metadata: { password: 'plaintext_password' },
      },
      {
        itemId: 'bad_meta_3',
        title: 'Title',
        content: 'Content',
        publishedAt: null,
        metadata: { api_key: 'sk_live_12345' },
      },
    ];

    for (const badItem of forbiddenKeyItems) {
      const innerReader = new FakeSourceReader({
        fixtureMap: new Map([['sp_ember_releases', [badItem]]]),
      });

      await expect(
        innerReader.readSnapshot('sp_ember_releases', validContext),
      ).rejects.toThrowError(/Operation denied by policy/i);
    }
  });

  it('enforces total payload UTF-8 byte ceilings', async () => {
    // Generate items within 2048 chars each, but exceeding 32 KiB combined
    const items: SourceSnapshotItem[] = Array.from({ length: 20 }, (_, i) => ({
      itemId: `item_${i}`,
      title: `Title ${i}`,
      content: 'X'.repeat(1800), // 20 * 1800 = 36,000 bytes > 32 KiB
      publishedAt: null,
      metadata: {},
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
      itemId: `item_${i}`,
      title: `Title ${i}`,
      content: `Content ${i}`,
      publishedAt: null,
      metadata: {},
    }));

    const innerReader = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', tooManyItems]]),
    });

    await expect(innerReader.readSnapshot('sp_ember_releases', validContext)).rejects.toThrowError(
      /Operation denied by policy/i,
    );
  });

  it('computes deterministic SHA-256 digest regardless of object key order', async () => {
    const itemsOrder1: readonly SourceSnapshotItem[] = [
      {
        itemId: 'item_1',
        title: 'Alpha',
        content: 'Content Alpha',
        publishedAt: '2026-11-01T12:00:00.000Z',
        metadata: { z_key: 'last', a_key: 'first', m_key: 42 },
      },
    ];

    const itemsOrder2: readonly SourceSnapshotItem[] = [
      {
        itemId: 'item_1',
        title: 'Alpha',
        content: 'Content Alpha',
        publishedAt: '2026-11-01T12:00:00.000Z',
        metadata: { a_key: 'first', m_key: 42, z_key: 'last' },
      },
    ];

    const reader1 = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', itemsOrder1]]),
      fixedObservedAt: '2026-11-01T12:00:00.000Z',
    });

    const reader2 = new FakeSourceReader({
      fixtureMap: new Map([['sp_ember_releases', itemsOrder2]]),
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
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    const firstItem = snapshot.items[0]!;
    expect(Object.isFrozen(firstItem)).toBe(true);
    expect(Object.isFrozen(firstItem.metadata)).toBe(true);

    expect(() => {
      // @ts-expect-error mutating frozen snapshot
      snapshot.sourceProfileId = 'tampered';
    }).toThrow();

    expect(() => {
      // @ts-expect-error mutating frozen item
      firstItem.title = 'Tampered Title';
    }).toThrow();
  });
});
