import { describe, expect, it } from 'vitest';
import { FakeConsentRegistry, TEST_TENANT_A, TEST_TENANT_B } from '@ember/connectors';

describe('P0-C3C: FakeConsentRegistry', () => {
  it('grants, retrieves, and enforces tenant isolation', () => {
    const registry = new FakeConsentRegistry();
    const grant = registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
      allowedOperations: ['read_snapshot'],
      scopes: ['source.readonly'],
    });

    expect(grant.tenantId).toBe(TEST_TENANT_A);
    expect(grant.sourceProfileId).toBe('sp_ember_releases');
    expect(grant.status).toBe('active');
    expect(grant.version).toBe(1);

    // Tenant A can retrieve own grant
    const retrieved = registry.get(TEST_TENANT_A, 'sp_ember_releases');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.grantId).toBe(grant.grantId);

    // Tenant B cannot retrieve Tenant A's grant (Uniform Agnosticism)
    const crossTenant = registry.get(TEST_TENANT_B, 'sp_ember_releases');
    expect(crossTenant).toBeNull();
  });

  it('enforces uniform agnosticism on cross-tenant revocation', () => {
    const registry = new FakeConsentRegistry();
    registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    // Tenant B attempting to revoke Tenant A's grant receives NOT_FOUND
    expect(() => {
      registry.revoke(TEST_TENANT_B, 'sp_ember_releases');
    }).toThrowError(/not found/i);

    // Tenant A's grant remains active
    const grantA = registry.get(TEST_TENANT_A, 'sp_ember_releases');
    expect(grantA?.status).toBe('active');
  });

  it('revokes consent and increments version', () => {
    const registry = new FakeConsentRegistry();
    const now = new Date('2026-11-01T12:00:00.000Z');
    registry.grant(
      {
        tenantId: TEST_TENANT_A,
        sourceProfileId: 'sp_ember_releases',
      },
      now,
    );

    const revokeNow = new Date('2026-11-01T13:00:00.000Z');
    const revoked = registry.revoke(TEST_TENANT_A, 'sp_ember_releases', revokeNow);

    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).toBe(revokeNow.toISOString());
    expect(revoked.version).toBe(2);

    const current = registry.get(TEST_TENANT_A, 'sp_ember_releases', revokeNow);
    expect(current?.status).toBe('revoked');
  });

  it('dynamically marks expired grants based on evaluation clock', () => {
    const registry = new FakeConsentRegistry();
    const grantTime = new Date('2026-11-01T10:00:00.000Z');
    const expiryTime = new Date('2026-11-01T11:00:00.000Z');

    registry.grant(
      {
        tenantId: TEST_TENANT_A,
        sourceProfileId: 'sp_ember_releases',
        expiresAt: expiryTime.toISOString(),
      },
      grantTime,
    );

    // Before expiry: active
    const beforeExpiry = registry.get(
      TEST_TENANT_A,
      'sp_ember_releases',
      new Date('2026-11-01T10:30:00.000Z'),
    );
    expect(beforeExpiry?.status).toBe('active');

    // After expiry: expired
    const afterExpiry = registry.get(
      TEST_TENANT_A,
      'sp_ember_releases',
      new Date('2026-11-01T11:00:01.000Z'),
    );
    expect(afterExpiry?.status).toBe('expired');
  });

  it('returns deeply frozen grants to prevent caller mutation', () => {
    const registry = new FakeConsentRegistry();
    const grant = registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.allowedOperations)).toBe(true);

    expect(() => {
      // @ts-expect-error mutating frozen property
      grant.status = 'revoked';
    }).toThrow();
  });

  it('rejects malformed sourceProfileId or tenantId', () => {
    const registry = new FakeConsentRegistry();

    expect(() => {
      registry.grant({
        tenantId: '',
        sourceProfileId: 'sp_ember_releases',
      });
    }).toThrowError(/Invalid request input/i);

    expect(() => {
      registry.grant({
        tenantId: TEST_TENANT_A,
        sourceProfileId: 'https://evil.com/webhook',
      });
    }).toThrowError(/Invalid request input/i);

    expect(() => {
      registry.grant({
        tenantId: TEST_TENANT_A,
        sourceProfileId: 'sp_ember_releases',
        expiresAt: 'not-a-date',
      });
    }).toThrowError(/Invalid request input/i);
  });

  it('lists only grants belonging to the specified tenant', () => {
    const registry = new FakeConsentRegistry();
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_ember_releases' });
    registry.grant({ tenantId: TEST_TENANT_A, sourceProfileId: 'sp_system_alerts' });
    registry.grant({ tenantId: TEST_TENANT_B, sourceProfileId: 'sp_ember_releases' });

    const listA = registry.list(TEST_TENANT_A);
    expect(listA).toHaveLength(2);
    expect(listA.every((g) => g.tenantId === TEST_TENANT_A)).toBe(true);

    const listB = registry.list(TEST_TENANT_B);
    expect(listB).toHaveLength(1);
    expect(listB[0]?.tenantId).toBe(TEST_TENANT_B);
  });
});
