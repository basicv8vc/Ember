/**
 * Error handling and security boundaries for @ember/credentials.
 *
 * Adheres strictly to Ember domain error conventions:
 * - Fixed public error messages.
 * - Out-of-band diagnostics that never contain credentials, userinfo, or secret tokens.
 * - Uniform agnosticism across tenants: NOT_FOUND is used for missing, mismatched, or foreign resources.
 */

import { DomainError, isDomainError, type DomainErrorCode } from '@ember/domain';
import type { EgressDenialCode } from './types.js';

export { DomainError, isDomainError, type DomainErrorCode };

/**
 * Creates a DomainError for missing or cross-tenant resources.
 * Uniform agnosticism: foreign tenant accesses receive NOT_FOUND to prevent probing.
 */
export function createNotFoundError(diagnostic = 'Resource not found'): DomainError {
  return new DomainError('NOT_FOUND', diagnostic);
}

/**
 * Creates a DomainError for policy denials (egress rejection, expired/revoked credentials, write operations).
 */
export function createPolicyDeniedError(
  diagnostic = 'Operation denied by policy',
  denialCode?: EgressDenialCode,
): DomainError {
  const diag = denialCode ? `${diagnostic} [code: ${denialCode}]` : diagnostic;
  return new DomainError('POLICY_DENIED', diag);
}

/**
 * Creates a DomainError for stale lease epochs or lease expiration.
 */
export function createStaleLeaseError(diagnostic = 'Lease is stale or expired'): DomainError {
  return new DomainError('STALE_LEASE', diagnostic);
}

/**
 * Creates a DomainError for missing or unverified caller credentials.
 */
export function createUnauthenticatedError(diagnostic = 'Authentication required'): DomainError {
  return new DomainError('UNAUTHENTICATED', diagnostic);
}

/**
 * Creates a DomainError for malformed request inputs or illegal URL formats.
 */
export function createInvalidArgumentError(diagnostic = 'Invalid argument'): DomainError {
  return new DomainError('INVALID_ARGUMENT', diagnostic);
}
