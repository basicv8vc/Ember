import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODES,
  DomainError,
  InvalidArgumentError,
  InvalidStateTransitionError,
  isDomainError,
} from '@ember/domain';
import type {
  AuthContext,
  DomainErrorCode,
  Id,
  LeasedRun,
  Retryability,
  RunTerminalStatus,
  TaskCommand,
  TaskEvent,
  TaskReceipt,
  TaskView,
} from '@ember/domain';
import {
  DomainErrorCodeSchema,
  ErrorResponseSchema,
  MockChatInputSchema,
  TaskEventDtoSchema,
  TaskEventPayloadSchema,
  TaskEventSchema,
  toErrorResponse,
  toInvalidArgumentError,
  toTaskEventDto,
} from '@ember/contracts';
import type {
  ArtifactStore,
  ExecutionRouter,
  LeaseQueue,
  RouteDecision,
  SandboxProvider,
  TaskRepository,
  WorkspaceStore,
} from '@ember/contracts';

const UUID = '33333333-3333-4333-8333-333333333333';
const OTHER_UUID = '44444444-4444-4444-8444-444444444444';
const ISO_TIME = '2026-10-27T00:00:00Z';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Compile-time evidence that the published interface signatures still use domain types.
type _TaskRepositoryCreate = Expect<
  Equal<Parameters<TaskRepository['create']>, [AuthContext, TaskCommand]>
>;
type _TaskRepositoryCreateResult = Expect<
  Equal<Awaited<ReturnType<TaskRepository['create']>>, TaskReceipt>
>;
type _TaskRepositoryGet = Expect<
  Equal<Awaited<ReturnType<TaskRepository['get']>>, TaskView | null>
>;
type _LeaseClaim = Expect<Equal<Parameters<LeaseQueue['claimNext']>, [string, Date]>>;
type _LeaseFinish = Expect<Equal<Parameters<LeaseQueue['finish']>, [LeasedRun, RunTerminalStatus]>>;
type _RouterDecide = Expect<Equal<Awaited<ReturnType<ExecutionRouter['decide']>>, RouteDecision>>;
type _ArtifactPut = Expect<
  Equal<Parameters<ArtifactStore['put']>, [AuthContext, Uint8Array, string]>
>;
type _ArtifactVerify = Expect<
  Equal<Parameters<ArtifactStore['verify']>, [AuthContext, Id, string, number]>
>;
type _WorkspaceCommit = Expect<
  Equal<Awaited<ReturnType<WorkspaceStore['commit']>>, { version: number }>
>;
type _SandboxExec = Expect<
  Equal<Parameters<SandboxProvider['exec']>, [Id, readonly string[], number]>
>;
type _SandboxSnapshotIsOptional = Expect<
  Equal<undefined extends SandboxProvider['snapshot'] ? true : false, true>
>;

const _repositoryCreate: _TaskRepositoryCreate = true;
const _repositoryCreateResult: _TaskRepositoryCreateResult = true;
const _repositoryGet: _TaskRepositoryGet = true;
const _leaseClaim: _LeaseClaim = true;
const _leaseFinish: _LeaseFinish = true;
const _routerDecide: _RouterDecide = true;
const _artifactPut: _ArtifactPut = true;
const _artifactVerify: _ArtifactVerify = true;
const _workspaceCommit: _WorkspaceCommit = true;
const _sandboxExec: _SandboxExec = true;
const _sandboxSnapshot: _SandboxSnapshotIsOptional = true;

const REQUIRED_ERROR_CODES = [
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
  'INVALID_STATE_TRANSITION',
] as const satisfies readonly DomainErrorCode[];

const EXPECTED_RETRYABILITY: Readonly<Record<DomainErrorCode, Retryability>> = {
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
};

describe('domain error codes', () => {
  it('contains every required P0-B code plus the state-machine extension', () => {
    expect([...DOMAIN_ERROR_CODES].sort()).toEqual([...REQUIRED_ERROR_CODES].sort());
    expect(new Set(DOMAIN_ERROR_CODES).size).toBe(DOMAIN_ERROR_CODES.length);
    expect(DOMAIN_ERROR_CODES).toContain('INVALID_STATE_TRANSITION');
  });

  it('validates codes through the published schema', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      expect(DomainErrorCodeSchema.safeParse(code).success).toBe(true);
    }

    for (const invalid of ['INTERNAL_ERROR', 'invalid_argument', '', 'UNKNOWN']) {
      expect(DomainErrorCodeSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('DomainError', () => {
  it('carries a stable code, a safe default message and a retry classification', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      const error = new DomainError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error.name).toBe('DomainError');
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(EXPECTED_RETRYABILITY[code]);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('serialises only stable safe fields', () => {
    const error = new DomainError('INVALID_ARGUMENT', 'agentId: invalid format');
    const json = error.toJSON();

    expect(json).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'agentId: invalid format',
      retryable: 'not_retryable',
    });
    expect(JSON.stringify(json)).not.toContain('stack');
    expect(JSON.stringify(json)).not.toContain('cause');
  });

  it('bounds custom messages so the wire error contract stays valid', () => {
    const error = new DomainError('NOT_FOUND', 'x'.repeat(1_000));

    expect(error.message.length).toBe(512);
    expect(error.message.endsWith('...')).toBe(true);
    const body = toErrorResponse(error);
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
  });

  it('falls back to a safe default when a custom message is empty', () => {
    expect(new DomainError('NOT_FOUND', '').message).toBe('Resource not found');
    expect(new DomainError('NOT_FOUND', '   ').message).toBe('Resource not found');
  });

  it('is detected by type guard, never by message text', () => {
    const domainError = new DomainError('POLICY_DENIED');
    const ordinaryError = new Error(domainError.message);

    expect(isDomainError(domainError)).toBe(true);
    expect(isDomainError(ordinaryError)).toBe(false);
    expect(isDomainError({ code: 'POLICY_DENIED', message: domainError.message })).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });

  it('keeps invalid transition details structured and deterministic', () => {
    const first = new InvalidStateTransitionError('task', 'completed', 'running');
    const second = new InvalidStateTransitionError('task', 'completed', 'running');

    expect(first).toBeInstanceOf(DomainError);
    expect(first.code).toBe('INVALID_STATE_TRANSITION');
    expect(first.entity).toBe('task');
    expect(first.from).toBe('completed');
    expect(first.to).toBe('running');
    expect(first.message).toBe(second.message);
    expect(first.retryable).toBe('not_retryable');
  });

  it('bounds and freezes invalid argument details', () => {
    const error = new InvalidArgumentError(
      Array.from({ length: 25 }, (_, index) => ({
        path: `field_${index}`,
        code: 'invalid_type',
      })),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.issues).toHaveLength(10);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
  });

  it('maps Zod failures without retaining raw input values', () => {
    const secret = 'secret-payload-value';
    const result = MockChatInputSchema.safeParse({
      prompt: 'hello',
      maxOutputTokens: secret,
      tenantId: UUID,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const error = toInvalidArgumentError(result.error);
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['maxOutputTokens', '<root>']),
    );
    expect(JSON.stringify({ message: error.message, issues: error.issues })).not.toContain(secret);
  });
});

describe('error response contract', () => {
  it('maps a domain error to a strict wire body', () => {
    const error = new DomainError('NOT_FOUND');
    const body = toErrorResponse(error);

    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
  });

  it('adds a server-supplied request id when available', () => {
    const body = toErrorResponse(new DomainError('STALE_LEASE'), 'request-123');
    expect(body).toEqual({
      error: {
        code: 'STALE_LEASE',
        message: 'Lease is stale or no longer owned by this worker',
        request_id: 'request-123',
      },
    });
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects unknown codes, extra fields and stack/cause leakage', () => {
    expect(
      ErrorResponseSchema.safeParse({ error: { code: 'UNKNOWN', message: 'x' } }).success,
    ).toBe(false);
    expect(
      ErrorResponseSchema.safeParse({
        error: { code: 'NOT_FOUND', message: 'x', stack: 'secret stack' },
      }).success,
    ).toBe(false);
    expect(
      ErrorResponseSchema.safeParse({ error: { code: 'NOT_FOUND', message: '' } }).success,
    ).toBe(false);
  });
});

describe('task event contract', () => {
  const event: TaskEvent = {
    taskId: UUID,
    sequence: 1,
    phase: 'accepted',
    occurredAt: ISO_TIME,
    traceId: OTHER_UUID,
    payload: { taskKind: 'mock.compute', attempt: 1, replayed: false, note: null },
  };

  it('parses a valid internal event', () => {
    expect(TaskEventSchema.parse(event)).toEqual(event);
  });

  it('rejects unknown phases, negative sequences and non-integer sequences', () => {
    expect(TaskEventSchema.safeParse({ ...event, phase: 'accepted_externally' }).success).toBe(
      false,
    );
    expect(TaskEventSchema.safeParse({ ...event, sequence: -1 }).success).toBe(false);
    expect(TaskEventSchema.safeParse({ ...event, sequence: 1.5 }).success).toBe(false);
  });

  it('rejects nested or unbounded payload values', () => {
    expect(TaskEventPayloadSchema.safeParse({ nested: { prompt: 'secret' } }).success).toBe(false);
    expect(TaskEventPayloadSchema.safeParse({ list: ['a', 'b'] }).success).toBe(false);
    expect(TaskEventPayloadSchema.safeParse({ prompt: 'x'.repeat(2_049) }).success).toBe(false);
    expect(TaskEventPayloadSchema.safeParse({ 'bad key': 'value' }).success).toBe(false);
    expect(
      TaskEventPayloadSchema.safeParse(
        Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key_${index}`, index])),
      ).success,
    ).toBe(false);
  });

  it('maps to the snake_case event DTO', () => {
    const dto = toTaskEventDto(event);

    expect(dto).toEqual({
      task_id: UUID,
      sequence: 1,
      phase: 'accepted',
      occurred_at: ISO_TIME,
      trace_id: OTHER_UUID,
      payload: event.payload,
    });
    expect(TaskEventDtoSchema.parse(dto)).toEqual(dto);
    expect(TaskEventDtoSchema.safeParse({ ...dto, taskId: UUID }).success).toBe(false);
  });
});
