export const REDACTED_PLACEHOLDER = '[REDACTED]';

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s]+):([^@\s]+)@/g;
const SECRET_KEY_VALUE_PATTERN =
  /((?:api[_-]?key|secret|password|token|authorization|auth_token)\s*[:=]\s*["']?)([^\s"',;]+)(["']?)/gi;

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
 * Safely extracts and sanitizes an error message from any caught error.
 */
export function formatSanitizedError(error: unknown): string {
  if (error === null || error === undefined) {
    return 'Unknown error (null or undefined)';
  }

  if (error instanceof Error) {
    const prefix = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
    const code =
      'code' in error && typeof (error as { code: unknown }).code === 'string'
        ? ` [${(error as { code: string }).code}]`
        : '';
    return sanitizeString(`${prefix}${error.message}${code}`);
  }

  if (typeof error === 'string') {
    return sanitizeString(error);
  }

  if (typeof error === 'object') {
    try {
      return sanitizeString(JSON.stringify(error));
    } catch {
      return 'Unserializable error object';
    }
  }

  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return sanitizeString(error.toString());
  }

  return 'Unknown error payload';
}

/**
 * Safely serializes data to a formatted JSON string with extra scrubbing.
 */
export function serializeSafeJson(value: unknown, indent = 2): string {
  const jsonString = JSON.stringify(value, null, indent);
  return sanitizeString(jsonString);
}
