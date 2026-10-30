/**
 * Stable domain error vocabulary.
 *
 * Callers must branch on `code` / `instanceof`, never on human-readable message text.
 *
 * There are two deliberately separate text channels:
 * - `message` / `publicMessage`: a fixed, safe message selected by `code`. This is the only
 *   text allowed in `toJSON()` or an HTTP error DTO.
 * - `diagnostic`: internal-only context for logs and debugging (for example a database
 *   driver message). It is never serialised and must not be returned to clients.
 */

export const DOMAIN_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'POLICY_DENIED',
  'BUDGET_EXCEEDED',
  'IDEMPOTENCY_CONFLICT',
  'WORKSPACE_VERSION_CONFLICT',
  'STALE_LEASE',
  'DB_UNAVAILABLE',
  'SANDBOX_NOT_READY',
  'EXECUTION_TIMEOUT',
  'MOCK_TOOL_FAILED',
  'DEADLINE_EXCEEDED',
  'CANCELLED',
  /**
   * Extension required by P0B-02. It is not in the original P0-B error table because that
   * table only listed API-facing errors; illegal state transitions are a domain rule and
   * must be rejected deterministically before persistence.
   */
  'INVALID_STATE_TRANSITION',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/**
 * Advisory retry classification.
 *
 * - `not_retryable`: retrying the same operation cannot succeed.
 * - `bounded_retry`: infrastructure may retry with a finite budget/backoff.
 * - `conditional`: whether a retry helps depends on tool, deadline, lease or policy state
 *   owned by a later application layer. P0B-02 does not decide that policy here.
 */
export type Retryability = 'not_retryable' | 'bounded_retry' | 'conditional';

/** Upper bound for the public message shared with `ErrorResponseSchema`. */
export const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 512;

/** Internal diagnostics are bounded for log hygiene, but are never serialised to clients. */
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 2_048;

/**
 * Fixed client-safe messages. These are stable by error code and never contain request
 * input, SQL, credentials, host paths, file paths, driver messages or stack traces.
 */
const PUBLIC_MESSAGES: Readonly<Record<DomainErrorCode, string>> = Object.freeze({
  INVALID_ARGUMENT: 'Invalid request input',
  UNAUTHENTICATED: 'Authentication required',
  NOT_FOUND: 'Resource not found',
  POLICY_DENIED: 'Operation denied by policy',
  BUDGET_EXCEEDED: 'Budget exceeded',
  IDEMPOTENCY_CONFLICT: 'Idempotency key conflicts with an existing command',
  WORKSPACE_VERSION_CONFLICT: 'Workspace version is stale',
  STALE_LEASE: 'Lease is stale or no longer owned by this worker',
  DB_UNAVAILABLE: 'Database is unavailable',
  SANDBOX_NOT_READY: 'Sandbox is not ready',
  EXECUTION_TIMEOUT: 'Execution timed out',
  MOCK_TOOL_FAILED: 'Mock tool failed',
  DEADLINE_EXCEEDED: 'Task deadline exceeded',
  CANCELLED: 'Operation was cancelled',
  INVALID_STATE_TRANSITION: 'The requested state transition is not allowed',
});

/** Internal defaults used only when a caller does not provide a diagnostic. */
const DEFAULT_DIAGNOSTICS: Readonly<Record<DomainErrorCode, string>> = Object.freeze({
  INVALID_ARGUMENT: 'Invalid argument',
  UNAUTHENTICATED: 'Authentication required',
  NOT_FOUND: 'Resource not found',
  POLICY_DENIED: 'Operation denied by policy',
  BUDGET_EXCEEDED: 'Budget exceeded',
  IDEMPOTENCY_CONFLICT: 'Idempotency key conflicts with an existing command',
  WORKSPACE_VERSION_CONFLICT: 'Workspace version is stale',
  STALE_LEASE: 'Lease is stale or no longer owned by this worker',
  DB_UNAVAILABLE: 'Database is unavailable',
  SANDBOX_NOT_READY: 'Sandbox is not ready',
  EXECUTION_TIMEOUT: 'Execution timed out',
  MOCK_TOOL_FAILED: 'Mock tool failed',
  DEADLINE_EXCEEDED: 'Task deadline exceeded',
  CANCELLED: 'Operation was cancelled',
  INVALID_STATE_TRANSITION: 'Illegal state transition',
});

const RETRYABILITY: Readonly<Record<DomainErrorCode, Retryability>> = Object.freeze({
  INVALID_ARGUMENT: 'not_retryable',
  UNAUTHENTICATED: 'not_retryable',
  NOT_FOUND: 'not_retryable',
  POLICY_DENIED: 'not_retryable',
  BUDGET_EXCEEDED: 'not_retryable',
  IDEMPOTENCY_CONFLICT: 'not_retryable',
  WORKSPACE_VERSION_CONFLICT: 'conditional',
  STALE_LEASE: 'conditional',
  DB_UNAVAILABLE: 'bounded_retry',
  SANDBOX_NOT_READY: 'bounded_retry',
  EXECUTION_TIMEOUT: 'bounded_retry',
  MOCK_TOOL_FAILED: 'conditional',
  DEADLINE_EXCEEDED: 'conditional',
  CANCELLED: 'not_retryable',
  INVALID_STATE_TRANSITION: 'not_retryable',
});

/**
 * Internal diagnostics are stored out-of-band so they cannot be reached by enumerating or
 * serialising the error object. Only the explicit `diagnostic` getter exposes them.
 */
const diagnostics = new WeakMap<DomainError, string>();

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

/** Structured, transport-neutral domain failure. */
export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  readonly code: DomainErrorCode;
  readonly retryable: Retryability;
  /** Fixed client-safe text. Never derived from arbitrary caller input. */
  readonly publicMessage: string;

  constructor(code: DomainErrorCode, diagnostic?: string) {
    const publicMessage = PUBLIC_MESSAGES[code];
    super(publicMessage);
    this.code = code;
    this.retryable = RETRYABILITY[code];
    this.publicMessage = publicMessage;

    const internal =
      diagnostic !== undefined && diagnostic.trim() !== '' ? diagnostic : DEFAULT_DIAGNOSTICS[code];
    diagnostics.set(this, truncate(internal, MAX_DIAGNOSTIC_MESSAGE_LENGTH));
  }

  /**
   * Internal-only diagnostic context. Never include this value in an HTTP response or any
   * other public serialisation; it may contain driver text or other sensitive details.
   */
  get diagnostic(): string {
    return diagnostics.get(this) ?? this.publicMessage;
  }

  /**
   * Stable serialisable form. Uses `publicMessage`, never `diagnostic`, and deliberately
   * excludes `cause`, stacks and arbitrary details.
   */
  toJSON(): {
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly retryable: Retryability;
  } {
    return { code: this.code, message: this.publicMessage, retryable: this.retryable };
  }
}

/** Type guard that does not depend on message text or string matching. */
export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

export type StateMachineEntity = 'task' | 'run' | 'approval';

/** Raised by the pure state machines for every transition not present in the approved graph. */
export class InvalidStateTransitionError extends DomainError {
  override readonly name = 'InvalidStateTransitionError';
  readonly entity: StateMachineEntity;
  readonly from: string;
  readonly to: string;

  constructor(entity: StateMachineEntity, from: string, to: string) {
    super('INVALID_STATE_TRANSITION', `Illegal ${entity} state transition: ${from} -> ${to}`);
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

/** Safe description of one boundary validation problem: field path and stable rule code. */
export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
}

const MAX_REPORTED_VALIDATION_ISSUES = 10;

/**
 * Invalid command/body input. Only field paths and rule codes are retained so a validation
 * error can never echo the rejected values back to a client. The human-readable diagnostic
 * is internal; public output uses the fixed `INVALID_ARGUMENT` message.
 */
export class InvalidArgumentError extends DomainError {
  override readonly name = 'InvalidArgumentError';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const bounded = issues.slice(0, MAX_REPORTED_VALIDATION_ISSUES);
    const summary =
      bounded.length === 0
        ? 'invalid input'
        : bounded.map((issue) => `${issue.path} (${issue.code})`).join('; ');

    super('INVALID_ARGUMENT', `Invalid input: ${summary}`);
    this.issues = Object.freeze(bounded.map((issue) => Object.freeze({ ...issue })));
  }
}
