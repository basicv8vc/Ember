import { isDomainError } from '@ember/domain';

export const REDACTED_PLACEHOLDER = '[REDACTED]';

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s]+):([^@\s]+)@/g;
const SECRET_KEY_VALUE_PATTERN =
  /((?:api[_-]?key|secret|password|token|authorization|auth_token)\s*[:=]\s*["']?)([^\s"',;]+)(["']?)/gi;

const SMOKE_HARNESS_ERROR_BRAND = Symbol('SmokeHarnessErrorBrand');

/**
 * Trusted internal error class instantiated exclusively by Ember's smoke harness.
 * Errors carrying this private brand are trusted internal lifecycle signals.
 */
export class SmokeHarnessError extends Error {
  readonly [SMOKE_HARNESS_ERROR_BRAND] = true;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SmokeHarnessError';
    this.code = code;
  }
}

/**
 * Type guard for trusted internal SmokeHarnessError instances.
 */
export function isSmokeHarnessError(error: unknown): error is SmokeHarnessError {
  return (
    error instanceof SmokeHarnessError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as Record<symbol, unknown>)[SMOKE_HARNESS_ERROR_BRAND] === true)
  );
}

/**
 * Standard fixed error codes permitted in exported smoke reports.
 */
export const KNOWN_RUNNER_ERROR_CODES = [
  'ERR_PHASE_TIMEOUT',
  'ERR_OPERATION_ABORTED',
  'ERR_EXEC_FAILED',
  'DIGEST_MISMATCH',
  'ERR_INVALID_USAGE',
  'ERR_PROVIDER_EXECUTION',
] as const;

/**
 * Redacts secret patterns (Bearer tokens, credentials in URIs, API keys) from text.
 */
export function sanitizeString(text: string): string {
  if (typeof text !== 'string') {
    return String(text);
  }

  return text
    .replace(URL_CREDENTIAL_PATTERN, '$1$2:[REDACTED]@')
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_PLACEHOLDER}`)
    .replace(SECRET_KEY_VALUE_PATTERN, `$1${REDACTED_PLACEHOLDER}$3`);
}

/**
 * Safely extracts and sanitizes error information for exportable smoke reports.
 *
 * Strict Security Invariants:
 * 1. Only SmokeHarnessError (instantiated internally by Ember's runner harness) is trusted
 *    to format its predefined error message template.
 * 2. Only DomainError from @ember/domain is trusted (its message is statically derived from
 *    predefined PUBLIC_MESSAGES and never contains arbitrary provider inputs).
 * 3. All Provider exceptions and any unverified external errors MUST NOT be echoed,
 *    regardless of message content, substrings, or arbitrary error.code properties.
 *    They are strictly mapped to fixed safe message: `Provider operation failed during <context> [ERR_PROVIDER_EXECUTION]`.
 */
export function formatSanitizedError(error: unknown, context?: string): string {
  if (error === null || error === undefined) {
    return 'Unknown error (null or undefined) [ERR_UNKNOWN]';
  }

  // 1. Trusted internal SmokeHarnessError generated directly by Ember's runner harness
  if (isSmokeHarnessError(error)) {
    return sanitizeString(error.message);
  }

  // 2. Trusted DomainError from @ember/domain (publicMessage is statically mapped from DOMAIN_ERROR_CODES)
  if (isDomainError(error)) {
    return `DomainError: ${error.publicMessage} [${error.code}]`;
  }

  // 3. Provider exceptions and all untrusted errors:
  // Strictly prevent error.message substring spoofing or arbitrary error.code injection!
  // Provider exceptions ALWAYS use fixed safe message.
  const ctxStr = context ? ` during ${context}` : '';
  return `Provider operation failed${ctxStr} [ERR_PROVIDER_EXECUTION]`;
}

/**
 * Safely serializes data to a formatted JSON string with extra scrubbing.
 */
export function serializeSafeJson(value: unknown, indent = 2): string {
  const jsonString = JSON.stringify(value, null, indent);
  return sanitizeString(jsonString);
}
