import { createHash } from 'node:crypto';

export const REDACTED_PLACEHOLDER = '[REDACTED]';
export const REDACTED_PROMPT_PLACEHOLDER = '[REDACTED_PROMPT]';
export const REDACTED_CONTENT_PLACEHOLDER = '[REDACTED_CONTENT]';
export const REDACTED_SECRET_PLACEHOLDER = '[REDACTED_SECRET]';
export const REDACTED_DEV_TOKEN_PLACEHOLDER = '[REDACTED_DEV_TOKEN]';

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|credential|authorization|auth_token|prompt|private_key|api_?key/i;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const DEV_TOKEN_PATTERN = /\b(?:dev_token|test_token|token)_[a-zA-Z0-9_-]{8,}\b/gi;
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s]+):([^@\s]+)@/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN[A-Z0-9_ -]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9_ -]*PRIVATE KEY-----/gi;
const KEY_VALUE_SECRET_PATTERN =
  /((?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?)([^\s"',;]+)(["']?)/gi;

/**
 * Computes a deterministic 16-hex-char SHA-256 hash of a tenant ID.
 * This guarantees privacy and tenant separation without leaking the raw UUID.
 */
export function createTenantHash(tenantId: string): string {
  return createHash('sha256').update(tenantId, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Redacts secret patterns (Bearer tokens, credentials in URIs, private keys) from text.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string') {
    return text;
  }

  return text
    .replace(PRIVATE_KEY_PATTERN, REDACTED_SECRET_PLACEHOLDER)
    .replace(URL_CREDENTIAL_PATTERN, '$1$2:[REDACTED]@')
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_PLACEHOLDER}`)
    .replace(DEV_TOKEN_PATTERN, REDACTED_DEV_TOKEN_PLACEHOLDER)
    .replace(KEY_VALUE_SECRET_PATTERN, `$1${REDACTED_PLACEHOLDER}$3`);
}

/**
 * Redacts raw prompt content from logging and spans while recording length and content digest.
 */
export function redactPrompt(prompt: string): { length: number; sha256_prefix: string } {
  const hash = createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 12);
  return {
    length: prompt.length,
    sha256_prefix: `sha256:${hash}`,
  };
}

/**
 * Recursively scrubs arbitrary values (objects, arrays, strings) to remove sensitive task input,
 * prompt text, or authentication secrets.
 */
export function sanitizeValue(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
      return REDACTED_PLACEHOLDER;
    }
    return redactSecrets(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, keyHint));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(record)) {
      // Scrub specific known task input fields
      if (key === 'prompt' && typeof val === 'string') {
        sanitized[key] = REDACTED_PROMPT_PLACEHOLDER;
        continue;
      }
      if (key === 'content' && typeof val === 'string') {
        sanitized[key] = REDACTED_CONTENT_PLACEHOLDER;
        continue;
      }

      // Convert raw tenant_id / tenantId into safe tenant_hash
      if (key === 'tenantId' || key === 'tenant_id') {
        if (typeof val === 'string') {
          sanitized['tenant_hash'] = createTenantHash(val);
          continue;
        }
      }

      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = REDACTED_PLACEHOLDER;
        continue;
      }

      sanitized[key] = sanitizeValue(val, key);
    }

    return sanitized;
  }

  return REDACTED_PLACEHOLDER;
}

/**
 * Sanitizes structured log and span contexts.
 */
export function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(context) as Record<string, unknown>;
}
