/**
 * In-memory synthetic credential metadata registry.
 *
 * Implements Section 2 of P0-C1C:
 * - Stores ONLY synthetic, non-sensitive credential references.
 * - Enforces absolute tenant isolation and uniform agnosticism (NOT_FOUND).
 * - Manages lifecycle: register, view, rotate, revoke.
 * - Under NO circumstances stores, echoes, encrypts, or fakes real API keys or tokens.
 */

import { randomUUID } from 'node:crypto';
import type { AuthContext, Id } from '@ember/domain';
import {
  createInvalidArgumentError,
  createNotFoundError,
  createPolicyDeniedError,
} from './errors.js';
import type {
  CredentialMetadata,
  RegisterCredentialOptions,
  RotateCredentialOptions,
} from './types.js';

function freezeMetadata(metadata: CredentialMetadata): CredentialMetadata {
  return Object.freeze({
    ...metadata,
    scopes: Object.freeze([...metadata.scopes]),
  });
}

export class InMemoryCredentialRegistry {
  /** Map<tenantId, Map<credentialRef, CredentialMetadata>> */
  private readonly storage = new Map<string, Map<string, CredentialMetadata>>();

  /**
   * Register synthetic credential metadata for a tenant.
   */
  register(
    ctx: AuthContext,
    options: RegisterCredentialOptions,
    now: Date = new Date(),
  ): CredentialMetadata {
    if (!ctx || !ctx.tenantId || typeof ctx.tenantId !== 'string') {
      throw createInvalidArgumentError('Valid AuthContext with tenantId is required');
    }

    if (
      !options.provider ||
      typeof options.provider !== 'string' ||
      options.provider.trim() === ''
    ) {
      throw createInvalidArgumentError('Provider must be a non-empty string');
    }

    if (!Array.isArray(options.scopes) || options.scopes.length === 0) {
      throw createInvalidArgumentError('Scopes must be a non-empty array of strings');
    }

    for (const scope of options.scopes) {
      if (typeof scope !== 'string' || scope.trim() === '') {
        throw createInvalidArgumentError('Each scope must be a non-empty string');
      }
    }

    const credentialRef =
      options.credentialRef && options.credentialRef.trim() !== ''
        ? options.credentialRef.trim()
        : `cred_${randomUUID()}`;

    let tenantMap = this.storage.get(ctx.tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      this.storage.set(ctx.tenantId, tenantMap);
    }

    if (tenantMap.has(credentialRef)) {
      throw createInvalidArgumentError(`Credential reference ${credentialRef} already exists`);
    }

    const nowIso = now.toISOString();
    let status: 'active' | 'expired' = 'active';

    if (options.expiresAt) {
      const expDate = new Date(options.expiresAt);
      if (Number.isNaN(expDate.getTime())) {
        throw createInvalidArgumentError('Invalid expiresAt timestamp format');
      }
      if (expDate.getTime() <= now.getTime()) {
        status = 'expired';
      }
    }

    const uniqueScopes: string[] = Array.from(
      new Set<string>(options.scopes.map((s: string): string => s.trim())),
    );

    const record: CredentialMetadata = {
      credentialRef,
      tenantId: ctx.tenantId,
      provider: options.provider.trim(),
      scopes: uniqueScopes,
      status,
      version: 1,
      expiresAt: options.expiresAt ? new Date(options.expiresAt).toISOString() : null,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(options.description ? { description: options.description.trim() } : {}),
    };

    tenantMap.set(credentialRef, record);
    return freezeMetadata(record);
  }

  /**
   * Get minimal credential metadata for a tenant.
   * Cross-tenant access triggers NOT_FOUND to guarantee uniform agnosticism.
   */
  get(ctx: AuthContext, credentialRef: string, now: Date = new Date()): CredentialMetadata {
    if (!ctx || !ctx.tenantId || typeof ctx.tenantId !== 'string') {
      throw createInvalidArgumentError('Valid AuthContext with tenantId is required');
    }

    const record = this.getInternal(ctx.tenantId, credentialRef, now);
    if (!record) {
      throw createNotFoundError('Credential not found in this tenant');
    }

    return freezeMetadata(record);
  }

  /**
   * Internal retrieval by tenantId and credentialRef, updating expiry if elapsed.
   * Returns undefined if missing or belonging to another tenant.
   */
  getInternal(
    tenantId: Id,
    credentialRef: string,
    now: Date = new Date(),
  ): CredentialMetadata | undefined {
    if (!tenantId || !credentialRef) {
      return undefined;
    }

    const tenantMap = this.storage.get(tenantId);
    if (!tenantMap) {
      return undefined;
    }

    const record = tenantMap.get(credentialRef);
    if (!record) {
      return undefined;
    }

    // Lazy expiration check
    if (record.status === 'active' && record.expiresAt !== null) {
      const expiry = new Date(record.expiresAt).getTime();
      if (now.getTime() >= expiry) {
        const expiredRecord: CredentialMetadata = {
          ...record,
          status: 'expired',
          updatedAt: now.toISOString(),
        };
        tenantMap.set(credentialRef, expiredRecord);
        return expiredRecord;
      }
    }

    return record;
  }

  /**
   * Rotate a credential, advancing its version monotonically.
   */
  rotate(
    ctx: AuthContext,
    credentialRef: string,
    options: RotateCredentialOptions = {},
    now: Date = new Date(),
  ): CredentialMetadata {
    if (!ctx || !ctx.tenantId || typeof ctx.tenantId !== 'string') {
      throw createInvalidArgumentError('Valid AuthContext with tenantId is required');
    }

    const tenantMap = this.storage.get(ctx.tenantId);
    if (!tenantMap || !tenantMap.has(credentialRef)) {
      throw createNotFoundError('Credential not found in this tenant');
    }

    const existing = tenantMap.get(credentialRef)!;
    if (existing.status === 'revoked') {
      throw createPolicyDeniedError('Cannot rotate a revoked credential');
    }

    let status = existing.status;
    let expiresAt = existing.expiresAt;

    if (options.newExpiresAt !== undefined) {
      if (options.newExpiresAt === null) {
        expiresAt = null;
        status = 'active';
      } else {
        const expDate = new Date(options.newExpiresAt);
        if (Number.isNaN(expDate.getTime())) {
          throw createInvalidArgumentError('Invalid newExpiresAt timestamp format');
        }
        expiresAt = expDate.toISOString();
        status = expDate.getTime() <= now.getTime() ? 'expired' : 'active';
      }
    }

    const scopes: readonly string[] =
      options.newScopes !== undefined
        ? Array.from(new Set<string>(options.newScopes.map((s: string): string => s.trim())))
        : existing.scopes;

    const newCredentialRef =
      options.newCredentialRef && options.newCredentialRef.trim() !== ''
        ? options.newCredentialRef.trim()
        : `cred_${randomUUID()}`;

    if (newCredentialRef === credentialRef) {
      throw createInvalidArgumentError(
        'New credential reference must be distinct from rotated reference',
      );
    }

    if (tenantMap.has(newCredentialRef)) {
      throw createInvalidArgumentError(`Credential reference ${newCredentialRef} already exists`);
    }

    // Invalidate the old credential reference so it can never be used again
    const invalidatedOld: CredentialMetadata = {
      ...existing,
      status: 'revoked',
      updatedAt: now.toISOString(),
    };
    tenantMap.set(credentialRef, invalidatedOld);

    // Register the rotated credential with the new reference and incremented version
    const rotated: CredentialMetadata = {
      ...existing,
      credentialRef: newCredentialRef,
      scopes,
      status,
      version: existing.version + 1,
      expiresAt,
      createdAt: existing.createdAt,
      updatedAt: now.toISOString(),
      ...(options.description !== undefined ? { description: options.description.trim() } : {}),
    };

    tenantMap.set(newCredentialRef, rotated);
    return freezeMetadata(rotated);
  }

  /**
   * Revoke a credential reference. Revoked credentials can never be used.
   */
  revoke(ctx: AuthContext, credentialRef: string, now: Date = new Date()): CredentialMetadata {
    if (!ctx || !ctx.tenantId || typeof ctx.tenantId !== 'string') {
      throw createInvalidArgumentError('Valid AuthContext with tenantId is required');
    }

    const tenantMap = this.storage.get(ctx.tenantId);
    if (!tenantMap || !tenantMap.has(credentialRef)) {
      throw createNotFoundError('Credential not found in this tenant');
    }

    const existing = tenantMap.get(credentialRef)!;
    if (existing.status === 'revoked') {
      return freezeMetadata(existing);
    }

    const revoked: CredentialMetadata = {
      ...existing,
      status: 'revoked',
      updatedAt: now.toISOString(),
    };

    tenantMap.set(credentialRef, revoked);
    return freezeMetadata(revoked);
  }

  /**
   * List all credentials visible to the calling tenant.
   */
  list(ctx: AuthContext, now: Date = new Date()): readonly CredentialMetadata[] {
    if (!ctx || !ctx.tenantId || typeof ctx.tenantId !== 'string') {
      throw createInvalidArgumentError('Valid AuthContext with tenantId is required');
    }

    const tenantMap = this.storage.get(ctx.tenantId);
    if (!tenantMap) {
      return Object.freeze([]);
    }

    const results: CredentialMetadata[] = [];
    for (const ref of tenantMap.keys()) {
      const item = this.getInternal(ctx.tenantId, ref, now);
      if (item) {
        results.push(freezeMetadata(item));
      }
    }

    return Object.freeze(results);
  }

  /**
   * Check whether a credential exists in ANY tenant (test diagnostic / verification utility).
   */
  hasCredentialGlobal(credentialRef: string): boolean {
    for (const tenantMap of this.storage.values()) {
      if (tenantMap.has(credentialRef)) {
        return true;
      }
    }
    return false;
  }
}
