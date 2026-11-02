/**
 * In-memory Fake Consent Registry for @ember/connectors.
 *
 * CRITICAL ARCHITECTURAL BOUNDARY:
 * - This registry is an ephemeral, process-local test double.
 * - It is strictly for unit/integration testing and deterministic fake execution.
 * - Under NO circumstances does it guarantee cross-process transactional atomicity.
 * - Durable, cross-process consent persistence belongs to a future PostgreSQL migration owned by Agent A.
 */

import { randomUUID } from 'node:crypto';
import { deepFreeze } from './canonical.js';
import { createInvalidArgumentError, createNotFoundError } from './errors.js';
import {
  SOURCE_PROFILE_ID_REGEX,
  type ConsentGrant,
  type ConsentRegistry,
  type GrantConsentParams,
} from './types.js';

export class FakeConsentRegistry implements ConsentRegistry {
  private readonly grants = new Map<string, ConsentGrant>();

  private buildKey(tenantId: string, sourceProfileId: string): string {
    return `${tenantId}::${sourceProfileId}`;
  }

  private validateSourceProfileId(sourceProfileId: string): void {
    if (typeof sourceProfileId !== 'string' || !SOURCE_PROFILE_ID_REGEX.test(sourceProfileId)) {
      throw createInvalidArgumentError(
        'sourceProfileId must be a valid opaque identifier matching ^[a-z0-9][a-z0-9._-]{2,63}$',
      );
    }
  }

  grant(params: GrantConsentParams, now: Date = new Date()): ConsentGrant {
    if (!params.tenantId || typeof params.tenantId !== 'string' || params.tenantId.trim() === '') {
      throw createInvalidArgumentError('tenantId must be a non-empty string');
    }
    this.validateSourceProfileId(params.sourceProfileId);

    const key = this.buildKey(params.tenantId, params.sourceProfileId);
    const existing = this.grants.get(key);
    const version = existing ? existing.version + 1 : 1;

    let expiresAt: string | null = null;
    if (params.expiresAt !== undefined && params.expiresAt !== null) {
      const expDate = new Date(params.expiresAt);
      if (Number.isNaN(expDate.getTime())) {
        throw createInvalidArgumentError('expiresAt must be a valid RFC 3339 date string');
      }
      expiresAt = expDate.toISOString();
    }

    const grantRecord: ConsentGrant = {
      grantId: existing?.grantId ?? randomUUID(),
      tenantId: params.tenantId,
      sourceProfileId: params.sourceProfileId,
      status: 'active',
      allowedOperations: Object.freeze([...(params.allowedOperations ?? ['read_snapshot'])]),
      scopes: Object.freeze([...(params.scopes ?? ['source.readonly'])]),
      grantedAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
      version,
    };

    deepFreeze(grantRecord);
    this.grants.set(key, grantRecord);
    return grantRecord;
  }

  get(tenantId: string, sourceProfileId: string, now: Date = new Date()): ConsentGrant | null {
    if (!tenantId || typeof tenantId !== 'string') {
      return null;
    }
    this.validateSourceProfileId(sourceProfileId);

    const key = this.buildKey(tenantId, sourceProfileId);
    const grant = this.grants.get(key);
    if (!grant) {
      return null;
    }

    // Check expiration dynamically
    if (grant.status === 'active' && grant.expiresAt !== null) {
      const expDate = new Date(grant.expiresAt);
      if (expDate <= now) {
        // Return synthetic expired grant representation
        const expiredGrant: ConsentGrant = {
          ...grant,
          status: 'expired',
        };
        return deepFreeze(expiredGrant);
      }
    }

    return grant;
  }

  revoke(tenantId: string, sourceProfileId: string, now: Date = new Date()): ConsentGrant {
    if (!tenantId || typeof tenantId !== 'string') {
      throw createNotFoundError('Consent grant not found');
    }
    this.validateSourceProfileId(sourceProfileId);

    const key = this.buildKey(tenantId, sourceProfileId);
    const grant = this.grants.get(key);
    if (!grant) {
      // Uniform Agnosticism: return 404 whether non-existent or other tenant
      throw createNotFoundError('Consent grant not found');
    }

    const revokedGrant: ConsentGrant = {
      ...grant,
      status: 'revoked',
      revokedAt: now.toISOString(),
      version: grant.version + 1,
    };

    deepFreeze(revokedGrant);
    this.grants.set(key, revokedGrant);
    return revokedGrant;
  }

  list(tenantId: string, now: Date = new Date()): readonly ConsentGrant[] {
    if (!tenantId || typeof tenantId !== 'string') {
      return [];
    }

    const results: ConsentGrant[] = [];
    for (const grant of this.grants.values()) {
      if (grant.tenantId === tenantId) {
        // Evaluate expiry
        if (
          grant.status === 'active' &&
          grant.expiresAt !== null &&
          new Date(grant.expiresAt) <= now
        ) {
          results.push(deepFreeze({ ...grant, status: 'expired' }));
        } else {
          results.push(grant);
        }
      }
    }

    return Object.freeze(results);
  }

  clear(): void {
    this.grants.clear();
  }
}
