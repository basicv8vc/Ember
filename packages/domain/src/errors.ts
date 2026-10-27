/**
 * Stable domain error vocabulary.
 *
 * Callers must branch on `code` / `instanceof`, never on human-readable message text.
 * Messages are safe to log or return: they must never contain raw request bodies,
 * credentials, SQL, filesystem paths or stack traces.
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

/** Upper bound shared with the HTTP error contract (`ErrorResponseSchema`). */
export const MAX_SAFE_ERROR_MESSAGE_LENGTH = 512;

const DEFAULT_MESSAGES: Readonly<Record<DomainErrorCode, string>> = Object.freeze({
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

/** Structured, transport-neutral domain failure. */
export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  readonly code: DomainErrorCode;
  readonly retryable: Retryability;

  constructor(code: DomainErrorCode, message?: string) {
    const candidate =
      message !== undefined && message.trim() !== '' ? message : DEFAULT_MESSAGES[code];
    super(
      candidate.length <= MAX_SAFE_ERROR_MESSAGE_LENGTH
        ? candidate
        : `${candidate.slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH - 3)}...`,
    );
    this.code = code;
    this.retryable = RETRYABILITY[code];
  }

  /** Stable serialisable form. Deliberately excludes `cause`, stacks and arbitrary details. */
  toJSON(): {
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly retryable: Retryability;
  } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** Type guard that does not depend on message text or string matching. */
export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

export type StateMachineEntity = 'task' | 'run';

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
 * error can never echo the rejected values back to a client.
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
