/**
 * Sanitisation for E2B smoke reports.
 *
 * Same discipline as the local harness: report text is generated from a fixed code table, so
 * a vendor error body — which can echo request headers, including the API key — can never
 * reach a committed evidence file.
 */

export const REDACTED = '[REDACTED]';

const E2B_KEY_PATTERN = /\be2b_[A-Za-z0-9]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s]+):([^@\s]+)@/g;
const SECRET_KEY_VALUE_PATTERN =
  /((?:api[_-]?key|secret|password|token|authorization|auth_token)\s*[:=]\s*["']?)([^\s"',;]+)(["']?)/gi;

export const E2B_SMOKE_ERROR_CODES = [
  'ERR_PREFLIGHT_BLOCKED',
  'ERR_SDK_VERSION_MISMATCH',
  'ERR_PHASE_TIMEOUT',
  'ERR_OPERATION_ABORTED',
  'ERR_PROVIDER_EXECUTION',
  'ERR_ASSERTION_FAILED',
  'ERR_EXEC_TIMEOUT_UNEXPECTED',
  'ERR_USAGE_INVALID',
] as const;

export type E2bSmokeErrorCode = (typeof E2B_SMOKE_ERROR_CODES)[number];

export interface E2bSmokeErrorOptions {
  readonly phase?: string;
  readonly timeoutMs?: number;
  readonly detail?: string;
}

export class E2bSmokeError extends Error {
  readonly code: E2bSmokeErrorCode;

  constructor(code: E2bSmokeErrorCode, options: E2bSmokeErrorOptions = {}) {
    super(formatE2bSmokeError(code, options));
    this.name = 'E2bSmokeError';
    this.code = code;
  }
}

export function formatE2bSmokeError(
  code: E2bSmokeErrorCode,
  options: E2bSmokeErrorOptions = {},
): string {
  const phase = options.phase;
  const prefix = phase === undefined ? '' : `[${phase}] `;

  switch (code) {
    case 'ERR_PREFLIGHT_BLOCKED':
      return `${prefix}Preflight blocked the run: the required precondition was not met [ERR_PREFLIGHT_BLOCKED]`;
    case 'ERR_SDK_VERSION_MISMATCH':
      return `${prefix}Installed e2b SDK version is not the pinned version [ERR_SDK_VERSION_MISMATCH]`;
    case 'ERR_PHASE_TIMEOUT': {
      const suffix = typeof options.timeoutMs === 'number' ? ` after ${options.timeoutMs}ms` : '';
      return `${prefix}Phase exceeded its wall-clock timeout${suffix} [ERR_PHASE_TIMEOUT]`;
    }
    case 'ERR_OPERATION_ABORTED':
      return `${prefix}Operation was aborted [ERR_OPERATION_ABORTED]`;
    case 'ERR_PROVIDER_EXECUTION':
      return `${prefix}Sandbox provider operation failed [ERR_PROVIDER_EXECUTION]`;
    case 'ERR_ASSERTION_FAILED':
      return `${prefix}Smoke assertion failed [ERR_ASSERTION_FAILED]`;
    case 'ERR_EXEC_TIMEOUT_UNEXPECTED':
      return `${prefix}Command timed out outside the dedicated timeout probe [ERR_EXEC_TIMEOUT_UNEXPECTED]`;
    case 'ERR_USAGE_INVALID':
      return `${prefix}Usage telemetry was non-finite or negative [ERR_USAGE_INVALID]`;
    default:
      return `${prefix}Unknown harness failure [ERR_UNKNOWN]`;
  }
}

export function sanitizeText(text: string): string {
  return text
    .replace(URL_CREDENTIAL_PATTERN, '$1$2:[REDACTED]@')
    .replace(E2B_KEY_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(SECRET_KEY_VALUE_PATTERN, `$1${REDACTED}$3`);
}

export function serializeSafeJson(value: unknown, indent = 2): string {
  return sanitizeText(JSON.stringify(value, null, indent));
}

/**
 * Extracts a short, non-secret reason from a preflight failure.
 *
 * Only an allowlisted vocabulary leaves this function; the raw cause stays in memory. This is
 * what lets the report say *why* it was blocked without risking a keyed URL in the output.
 */
export function describeBlockedReason(
  kind: 'missing-key' | 'sdk-version' | 'network' | 'quota',
): string {
  switch (kind) {
    case 'missing-key':
      return 'E2B_API_KEY is not set in the environment; real vendor measurement is blocked';
    case 'sdk-version':
      return 'installed e2b SDK does not match the pinned adapter version';
    case 'network':
      return 'the E2B control plane was unreachable from this environment';
    case 'quota':
      return 'the E2B account refused the call (quota, rate limit or credential rejection)';
    default:
      return 'preflight blocked';
  }
}
