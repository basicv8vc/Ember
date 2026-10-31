import { isDomainError } from '@ember/domain';

export const REDACTED_PLACEHOLDER = '[REDACTED]';

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s]+):([^@\s]+)@/g;
const SECRET_KEY_VALUE_PATTERN =
  /((?:api[_-]?key|secret|password|token|authorization|auth_token)\s*[:=]\s*["']?)([^\s"',;]+)(["']?)/gi;

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
 * 1. DomainError from @ember/domain is safe because its message is statically mapped
 *    from predefined PUBLIC_MESSAGES and never contains arbitrary provider inputs.
 * 2. Runner-internal errors with known safe error codes are permitted.
 * 3. Arbitrary provider exceptions (and arbitrary caught errors) MUST NOT echo raw
 *    error messages, stack traces, or object payloads into reports. They are mapped
 *    to fixed safe error codes (e.g. `[ERR_PROVIDER_EXECUTION]`).
 */
export function formatSanitizedError(error: unknown, context?: string): string {
  if (error === null || error === undefined) {
    return 'Unknown error (null or undefined) [ERR_UNKNOWN]';
  }

  // DomainError from @ember/domain has a fixed, client-safe publicMessage and code
  if (isDomainError(error)) {
    return `DomainError: ${error.publicMessage} [${error.code}]`;
  }

  if (error instanceof Error) {
    // Permit internally-generated runner error messages that carry designated safe codes
    if (
      error.message.includes('[ERR_PHASE_TIMEOUT]') ||
      error.message.includes('[ERR_OPERATION_ABORTED]') ||
      error.message.includes('[ERR_EXEC_FAILED]') ||
      error.message.includes('[DIGEST_MISMATCH]') ||
      error.message.includes('[ERR_INVALID_USAGE]')
    ) {
      return sanitizeString(error.message);
    }

    // If an error object carries an explicit safe code, preserve the code identifier
    if ('code' in error && typeof (error as { code: unknown }).code === 'string') {
      const code = (error as { code: string }).code.trim();
      if (/^[A-Z0-9_]{3,40}$/.test(code)) {
        if (code === 'POLICY_DENIED') {
          return 'Operation denied by policy [POLICY_DENIED]';
        }
        const ctxStr = context ? ` during ${context}` : '';
        return `Provider operation failed${ctxStr} [${code}]`;
      }
    }
  }

  // Default fail-safe for arbitrary provider exceptions: never echo unverified messages!
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
