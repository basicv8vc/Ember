/**
 * Redaction for anything that reaches a report, a log line or a PR attachment.
 *
 * The smoke harness is designed to be run by an operator with a live API key in the
 * environment. A single `JSON.stringify(error)` would otherwise publish that key into
 * `docs/evidence/`, so every string that leaves the process goes through here first.
 */

const PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // Daytona keys are `dtn_` prefixed; keep the prefix so a reader can tell *what* leaked.
  { pattern: /\bdtn_[A-Za-z0-9_-]{8,}/g, replacement: 'dtn_[REDACTED]' },
  { pattern: /\bdaytona_[A-Za-z0-9_-]{8,}/g, replacement: 'daytona_[REDACTED]' },
  { pattern: /\bE2B[A-Za-z0-9]{8,}/g, replacement: 'E2B[REDACTED]' },
  // `Authorization: Bearer <token>` in any casing, including a bare "Bearer <token>".
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer [REDACTED]' },
  // JWT-shaped strings (Daytona supports JWT auth as an alternative to an API key).
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: '[REDACTED_JWT]',
  },
];

/** Removes credentials and caps length so a vendor stack trace cannot flood the report. */
export function sanitizeText(value: string, maxChars = 4_000): string {
  let output = value;

  for (const { pattern, replacement } of PATTERNS) {
    output = output.replace(pattern, replacement);
  }

  return output.length > maxChars ? `${output.slice(0, maxChars)}…[truncated]` : output;
}

/** Redacts an explicit secret wherever it appears, even if it matches no known pattern. */
export function redactSecret(value: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < 8) {
    return sanitizeText(value);
  }

  return sanitizeText(value.split(secret).join('[REDACTED]'));
}

/** Extracts only the host of an API URL so a report never records a tokenised URL. */
export function apiHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}
