import { isDomainError } from '@ember/domain';

export const REDACTED_PLACEHOLDER = '[REDACTED]';

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@\s]+):([^@\s]+)@/g;
const SECRET_KEY_VALUE_PATTERN =
  /((?:api[_-]?key|secret|password|token|authorization|auth_token)\s*[:=]\s*["']?)([^\s"',;]+)(["']?)/gi;

const SMOKE_HARNESS_ERROR_BRAND = Symbol('SmokeHarnessErrorBrand');

export const VALID_SMOKE_PHASES = new Set<string>([
  'capabilities',
  'create',
  'waitReady',
  'exec',
  'readOutput',
  'usage',
  'stop',
  'destroy',
]);

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

export type SmokeHarnessErrorCode = (typeof KNOWN_RUNNER_ERROR_CODES)[number];

export interface SmokeHarnessErrorOptions {
  phase?: string;
  timeoutMs?: number;
  exitCode?: number;
}

function resolveSafePhase(phase?: string): string | undefined {
  if (typeof phase === 'string' && VALID_SMOKE_PHASES.has(phase.trim())) {
    return phase.trim();
  }
  return undefined;
}

/**
 * Generates client-safe public error text strictly from a fixed error code mapping.
 * Never accepts, evaluates, or reflects arbitrary incoming error message strings.
 */
export function formatHarnessErrorMessage(
  code: string,
  options: SmokeHarnessErrorOptions = {},
): string {
  const safePhase = resolveSafePhase(options.phase);

  switch (code) {
    case 'ERR_PHASE_TIMEOUT': {
      const phasePrefix = safePhase ? `Phase "${safePhase}"` : 'Phase';
      const timeoutSuffix =
        typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
          ? ` after ${options.timeoutMs}ms`
          : '';
      return `${phasePrefix} timed out${timeoutSuffix} [ERR_PHASE_TIMEOUT]`;
    }
    case 'ERR_OPERATION_ABORTED': {
      const phasePrefix = safePhase ? `Phase "${safePhase}"` : 'Phase';
      return `${phasePrefix} was aborted [ERR_OPERATION_ABORTED]`;
    }
    case 'ERR_EXEC_FAILED': {
      const exitSuffix =
        typeof options.exitCode === 'number' && Number.isSafeInteger(options.exitCode)
          ? `: ${options.exitCode}`
          : '';
      return `Command exited with non-zero exit code${exitSuffix} [ERR_EXEC_FAILED]`;
    }
    case 'DIGEST_MISMATCH':
      return 'SHA-256 digest verification failed: mismatch against expected digest [DIGEST_MISMATCH]';
    case 'ERR_INVALID_USAGE':
      return 'SandboxUsageRecord returned non-finite or negative metrics [ERR_INVALID_USAGE]';
    case 'ERR_PROVIDER_EXECUTION':
      return 'Sandbox provider execution failed [ERR_PROVIDER_EXECUTION]';
    default:
      return 'Runner harness failure [ERR_RUNNER_INTERNAL]';
  }
}

/**
 * Trusted internal error class instantiated exclusively by Ember's smoke harness.
 * Its public message is statically derived from fixed error code templates.
 */
export class SmokeHarnessError extends Error {
  readonly [SMOKE_HARNESS_ERROR_BRAND] = true;
  readonly code: SmokeHarnessErrorCode;
  readonly phase?: string;
  readonly timeoutMs?: number;
  readonly exitCode?: number;

  constructor(
    code: SmokeHarnessErrorCode,
    phaseOrOptions?: string | SmokeHarnessErrorOptions,
    maybeTimeoutMs?: number,
  ) {
    const options: SmokeHarnessErrorOptions =
      typeof phaseOrOptions === 'string'
        ? { phase: phaseOrOptions, timeoutMs: maybeTimeoutMs }
        : (phaseOrOptions ?? {});

    const safeMessage = formatHarnessErrorMessage(code, options);
    super(safeMessage);
    this.name = 'SmokeHarnessError';
    this.code = code;
    this.phase = resolveSafePhase(options.phase);
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? options.timeoutMs
        : undefined;
    this.exitCode =
      typeof options.exitCode === 'number' && Number.isSafeInteger(options.exitCode)
        ? options.exitCode
        : undefined;
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
 * Explicit error wrapper for untrusted exceptions originating from a Provider.
 * Created at the Provider invocation boundary so that Provider errors can never
 * enter or masquerade as trusted internal harness errors.
 */
export class UntrustedProviderError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('Provider operation failed');
    this.name = 'UntrustedProviderError';
    this.cause = cause;
  }
}

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
 * 1. UntrustedProviderError (intercepted at provider boundary) is unconditionally
 *    mapped to fixed safe error code `[ERR_PROVIDER_EXECUTION]`.
 * 2. Only SmokeHarnessError (instantiated internally by Ember's runner harness) is trusted,
 *    and its public text is strictly mapped from fixed error code templates (never error.message).
 * 3. Only DomainError from @ember/domain is trusted (its message is statically derived from
 *    predefined PUBLIC_MESSAGES and never contains arbitrary provider inputs).
 * 4. All other Provider exceptions and unverified external errors MUST NOT be echoed,
 *    regardless of message content, substrings, or arbitrary error.code properties.
 */
export function formatSanitizedError(error: unknown, context?: string): string {
  if (error === null || error === undefined) {
    return 'Unknown error (null or undefined) [ERR_UNKNOWN]';
  }

  // 1. Untrusted Provider errors explicitly intercepted at the provider boundary
  if (error instanceof UntrustedProviderError) {
    if (isDomainError(error.cause)) {
      return `DomainError: ${error.cause.publicMessage} [${error.cause.code}]`;
    }
    const ctxStr = context ? ` during ${context}` : '';
    return `Provider operation failed${ctxStr} [ERR_PROVIDER_EXECUTION]`;
  }

  // 2. Trusted internal SmokeHarnessError generated directly by Ember's runner harness
  if (isSmokeHarnessError(error)) {
    // Generate public message strictly from fixed error code mapping; NEVER trust error.message!
    return formatHarnessErrorMessage(error.code, {
      phase: error.phase ?? context,
      timeoutMs: error.timeoutMs,
      exitCode: error.exitCode,
    });
  }

  // 3. Trusted DomainError from @ember/domain (publicMessage is statically mapped from DOMAIN_ERROR_CODES)
  if (isDomainError(error)) {
    return `DomainError: ${error.publicMessage} [${error.code}]`;
  }

  // 4. Provider exceptions and all untrusted errors:
  // Strictly prevent error.message substring spoofing or arbitrary error.code injection!
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
