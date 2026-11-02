/**
 * Error handling and security boundaries for @ember/connectors.
 *
 * Adheres strictly to Ember domain error conventions:
 * - Fixed public error messages.
 * - Out-of-band diagnostics that never contain credentials, userinfo, or secret tokens.
 * - Uniform agnosticism across tenants: NOT_FOUND is used for missing, mismatched, or foreign resources.
 */

import { DomainError, isDomainError, type DomainErrorCode } from '@ember/domain';
import type { SourceDenialCode } from './types.js';

export { DomainError, isDomainError, type DomainErrorCode };

/**
 * Creates a DomainError for missing or cross-tenant resources.
 * Uniform agnosticism: foreign tenant accesses receive NOT_FOUND to prevent probing.
 */
export function createNotFoundError(diagnostic = 'Resource not found'): DomainError {
  return new DomainError('NOT_FOUND', diagnostic);
}

/**
 * Creates a DomainError for policy denials (revoked consent, expired consent, operation not allowed).
 */
export function createPolicyDeniedError(
  diagnostic = 'Operation denied by policy',
  denialCode?: SourceDenialCode,
): DomainError {
  const diag = denialCode ? `${diagnostic} [code: ${denialCode}]` : diagnostic;
  return new DomainError('POLICY_DENIED', diag);
}

/**
 * Creates a DomainError for malformed request inputs or illegal sourceProfileId formats.
 */
export function createInvalidArgumentError(diagnostic = 'Invalid argument'): DomainError {
  return new DomainError('INVALID_ARGUMENT', diagnostic);
}

/**
 * Creates a DomainError when an operation is cancelled or aborted by signal.
 */
export function createCancelledError(diagnostic = 'Operation was cancelled'): DomainError {
  return new DomainError('CANCELLED', diagnostic);
}
