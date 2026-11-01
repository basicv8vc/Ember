import { describe, expect, it } from 'vitest';
import { isDomainError, type AuthContext } from '@ember/domain';
import { InMemoryCredentialRegistry, makeSyntheticAuthContext } from '@ember/credentials';

const TENANT_A: AuthContext = makeSyntheticAuthContext(
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  1,
);

const TENANT_B: AuthContext = makeSyntheticAuthContext(
  '22222222-2222-4222-8222-222222222222',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  1,
);

const BASE_TIME = new Date('2026-10-31T12:00:00.000Z');

describe('InMemoryCredentialRegistry', () => {
  describe('tenant isolation and uniform agnosticism', () => {
    it('isolates credentials between Tenant A and Tenant B', () => {
      const registry = new InMemoryCredentialRegistry();

      const credA = registry.register(
        TENANT_A,
        {
          provider: 'synthetic-connector',
          scopes: ['read:profile'],
          description: 'Tenant A test credential',
        },
        BASE_TIME,
      );

      expect(credA.tenantId).toBe(TENANT_A.tenantId);
      expect(credA.status).toBe('active');
      expect(credA.version).toBe(1);

      // Tenant A can retrieve its credential
      const retrieved = registry.get(TENANT_A, credA.credentialRef, BASE_TIME);
      expect(retrieved.credentialRef).toBe(credA.credentialRef);

      // Tenant B accessing Tenant A's credential MUST receive NOT_FOUND (uniform agnosticism)
      try {
        registry.get(TENANT_B, credA.credentialRef, BASE_TIME);
        expect.unreachable('Should have thrown NOT_FOUND');
      } catch (err) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('NOT_FOUND');
          expect(err.publicMessage).toBe('Resource not found');
        }
      }

      // Tenant B rotating Tenant A's credential MUST receive NOT_FOUND
      try {
        registry.rotate(TENANT_B, credA.credentialRef, {}, BASE_TIME);
        expect.unreachable('Should have thrown NOT_FOUND');
      } catch (err) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('NOT_FOUND');
        }
      }

      // Tenant B revoking Tenant A's credential MUST receive NOT_FOUND
      try {
        registry.revoke(TENANT_B, credA.credentialRef, BASE_TIME);
        expect.unreachable('Should have thrown NOT_FOUND');
      } catch (err) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('NOT_FOUND');
        }
      }
    });

    it('returns empty list for a tenant with no registered credentials', () => {
      const registry = new InMemoryCredentialRegistry();
      const listB = registry.list(TENANT_B, BASE_TIME);
      expect(listB).toEqual([]);
    });

    it('returns only the credentials belonging to the calling tenant in list()', () => {
      const registry = new InMemoryCredentialRegistry();

      registry.register(TENANT_A, { provider: 'github', scopes: ['repo:read'] }, BASE_TIME);
      registry.register(TENANT_A, { provider: 'slack', scopes: ['chat:read'] }, BASE_TIME);
      registry.register(TENANT_B, { provider: 'google', scopes: ['drive.readonly'] }, BASE_TIME);

      const listA = registry.list(TENANT_A, BASE_TIME);
      expect(listA.length).toBe(2);
      expect(listA.every((c) => c.tenantId === TENANT_A.tenantId)).toBe(true);

      const listB = registry.list(TENANT_B, BASE_TIME);
      expect(listB.length).toBe(1);
      expect(listB[0]?.tenantId).toBe(TENANT_B.tenantId);
    });
  });

  describe('metadata hygiene and zero real secrets', () => {
    it('never contains secret, token, or apiKey in returned metadata', () => {
      const registry = new InMemoryCredentialRegistry();

      const cred = registry.register(
        TENANT_A,
        {
          provider: 'synthetic-connector',
          scopes: ['read:profile'],
          description: 'safe synthetic metadata',
        },
        BASE_TIME,
      );

      const keys = Object.keys(cred);
      expect(keys).not.toContain('token');
      expect(keys).not.toContain('secret');
      expect(keys).not.toContain('apiKey');
      expect(keys).not.toContain('password');
      expect(keys).not.toContain('bearer');
      expect(JSON.stringify(cred)).not.toMatch(/secret|token|password|bearer/i);
    });
  });

  describe('lifecycle: rotate, revoke, and expiry', () => {
    it('invalidates old credentialRef, issues a new credentialRef, and advances version monotonically on rotation', () => {
      const registry = new InMemoryCredentialRegistry();

      const cred = registry.register(
        TENANT_A,
        {
          provider: 'synthetic-connector',
          scopes: ['read:profile'],
        },
        BASE_TIME,
      );

      expect(cred.version).toBe(1);
      expect(cred.status).toBe('active');

      const rotateTime = new Date('2026-10-31T12:05:00.000Z');
      const rotated = registry.rotate(
        TENANT_A,
        cred.credentialRef,
        { newScopes: ['read:profile', 'read:email'] },
        rotateTime,
      );

      // New credential reference is distinct and active with incremented version
      expect(rotated.credentialRef).not.toBe(cred.credentialRef);
      expect(rotated.version).toBe(2);
      expect(rotated.status).toBe('active');
      expect(rotated.scopes).toEqual(['read:profile', 'read:email']);
      expect(rotated.updatedAt).toBe(rotateTime.toISOString());

      // Old credential reference is immediately invalidated (revoked)
      const oldRecord = registry.get(TENANT_A, cred.credentialRef, rotateTime);
      expect(oldRecord.status).toBe('revoked');

      // Attempting to rotate the invalidated old reference is rejected
      expect(() => registry.rotate(TENANT_A, cred.credentialRef, {}, rotateTime)).toThrow();

      // Attempting to rotate with an identical newCredentialRef is rejected
      expect(() =>
        registry.rotate(
          TENANT_A,
          rotated.credentialRef,
          { newCredentialRef: rotated.credentialRef },
          rotateTime,
        ),
      ).toThrow();
    });

    it('revokes a credential and marks it unusable', () => {
      const registry = new InMemoryCredentialRegistry();

      const cred = registry.register(
        TENANT_A,
        {
          provider: 'synthetic-connector',
          scopes: ['read:profile'],
        },
        BASE_TIME,
      );

      const revokeTime = new Date('2026-10-31T12:10:00.000Z');
      const revoked = registry.revoke(TENANT_A, cred.credentialRef, revokeTime);
      expect(revoked.status).toBe('revoked');

      // Rotating a revoked credential is prohibited
      try {
        registry.rotate(TENANT_A, cred.credentialRef, {}, revokeTime);
        expect.unreachable('Should have rejected rotating revoked credential');
      } catch (err) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('POLICY_DENIED');
        }
      }
    });

    it('automatically transitions status to expired after expiresAt instant', () => {
      const registry = new InMemoryCredentialRegistry();

      const expiry = new Date('2026-10-31T12:30:00.000Z');
      const cred = registry.register(
        TENANT_A,
        {
          provider: 'synthetic-connector',
          scopes: ['read:profile'],
          expiresAt: expiry.toISOString(),
        },
        BASE_TIME,
      );

      expect(cred.status).toBe('active');

      // Before expiry
      const before = registry.get(
        TENANT_A,
        cred.credentialRef,
        new Date('2026-10-31T12:20:00.000Z'),
      );
      expect(before.status).toBe('active');

      // After expiry
      const after = registry.get(
        TENANT_A,
        cred.credentialRef,
        new Date('2026-10-31T12:35:00.000Z'),
      );
      expect(after.status).toBe('expired');
    });
  });

  describe('validation errors', () => {
    it('rejects empty provider or scopes', () => {
      const registry = new InMemoryCredentialRegistry();

      expect(() =>
        registry.register(TENANT_A, { provider: '', scopes: ['read:profile'] }, BASE_TIME),
      ).toThrow();

      expect(() =>
        registry.register(TENANT_A, { provider: 'github', scopes: [] }, BASE_TIME),
      ).toThrow();
    });

    it('rejects invalid expiresAt format', () => {
      const registry = new InMemoryCredentialRegistry();

      expect(() =>
        registry.register(
          TENANT_A,
          { provider: 'github', scopes: ['read:profile'], expiresAt: 'invalid-date' },
          BASE_TIME,
        ),
      ).toThrow();
    });
  });
});
