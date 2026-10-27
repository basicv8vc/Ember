import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODES,
  DomainError,
  InvalidArgumentError,
  InvalidStateTransitionError,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_PUBLIC_ERROR_MESSAGE_LENGTH,
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
  TASK_EVENT_PAYLOAD_KEYS,
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
  it('carries a stable code, a safe public message and a retry classification', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      const error = new DomainError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error.name).toBe('DomainError');
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(EXPECTED_RETRYABILITY[code]);
      expect(error.publicMessage).toBe(error.message);
      expect(error.publicMessage.length).toBeGreaterThan(0);
      expect(error.publicMessage.length).toBeLessThanOrEqual(MAX_PUBLIC_ERROR_MESSAGE_LENGTH);
    }
  });

  it('serialises only the fixed public message, never caller diagnostics', () => {
    const error = new DomainError('INVALID_ARGUMENT', 'agentId: invalid format');
    const json = error.toJSON();

    expect(json).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'Invalid request input',
      retryable: 'not_retryable',
    });
    expect(JSON.stringify(json)).not.toContain('agentId');
    expect(JSON.stringify(json)).not.toContain('stack');
    expect(JSON.stringify(json)).not.toContain('cause');
  });

  it('never exposes DB, token, SQL or host-path diagnostics in public serialisations', () => {
    const diagnostic = [
      'postgres://ember:db-password-value@db.internal:5432/ember',
      'Authorization: Bearer sk_live_api_token_value',
      "SELECT * FROM users WHERE email = 'alice@example.com'",
      '/Users/alice/.ssh/id_ed25519',
    ].join(' | ');
    const secrets = [
      'db-password-value',
      'sk_live_api_token_value',
      'SELECT * FROM users',
      'alice@example.com',
      '/Users/alice/.ssh/id_ed25519',
    ];
    const error = new DomainError('DB_UNAVAILABLE', diagnostic);

    expect(error.message).toBe('Database is unavailable');
    expect(error.publicMessage).toBe('Database is unavailable');
    expect(error.diagnostic).toBe(diagnostic);

    const publicStrings = [
      error.message,
      error.publicMessage,
      JSON.stringify(error),
      JSON.stringify(error.toJSON()),
      JSON.stringify(toErrorResponse(error)),
      JSON.stringify(toErrorResponse(error, 'request-123')),
    ];

    for (const text of publicStrings) {
      for (const secret of secrets) {
        expect(text).not.toContain(secret);
      }
    }

    expect(Object.keys(error)).not.toContain('diagnostic');
    expect(Object.keys(error)).not.toContain('message');
  });

  it('bounds diagnostics internally and never uses them as the public message', () => {
    const error = new DomainError('NOT_FOUND', 'x'.repeat(5_000));

    expect(error.diagnostic.length).toBe(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
    expect(error.diagnostic.endsWith('...')).toBe(true);
    expect(error.message).toBe('Resource not found');
    expect(error.message.length).toBeLessThanOrEqual(MAX_PUBLIC_ERROR_MESSAGE_LENGTH);
    const body = toErrorResponse(error);
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
  });

  it('uses the safe default public message when diagnostic is empty', () => {
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

  it('keeps invalid transition details diagnostic-only', () => {
    const first = new InvalidStateTransitionError('task', 'completed', 'running');
    const second = new InvalidStateTransitionError('task', 'completed', 'running');

    expect(first).toBeInstanceOf(DomainError);
    expect(first.code).toBe('INVALID_STATE_TRANSITION');
    expect(first.entity).toBe('task');
    expect(first.from).toBe('completed');
    expect(first.to).toBe('running');
    expect(first.message).toBe(second.message);
    expect(first.message).toBe('The requested state transition is not allowed');
    expect(first.diagnostic).toContain('Illegal task state transition');
    expect(JSON.stringify(first)).not.toContain('completed -> running');
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
    expect(error.message).toBe('Invalid request input');
    expect(error.diagnostic).toContain('field_0');
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
    const serialized = JSON.stringify({
      message: error.message,
      publicMessage: error.publicMessage,
      issues: error.issues,
    });
    expect(serialized).not.toContain(secret);
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
    phase: 'started',
    occurredAt: ISO_TIME,
    traceId: OTHER_UUID,
    payload: {
      taskKind: 'mock.compute',
      runId: OTHER_UUID,
      attempt: 1,
      route: 'fast',
      fromStatus: 'queued',
      toStatus: 'running',
      runStatus: 'running',
      errorCode: 'MOCK_TOOL_FAILED',
      artifactId: UUID,
      workspaceVersion: 1,
      sandboxId: OTHER_UUID,
      durationMs: 10,
      replayed: false,
      cancelRequested: false,
      policyVersion: 1,
      simulated: true,
    },
  };

  it('publishes only the closed safe payload allowlist', () => {
    expect(TASK_EVENT_PAYLOAD_KEYS).toEqual([
      'taskKind',
      'runId',
      'attempt',
      'route',
      'fromStatus',
      'toStatus',
      'runStatus',
      'errorCode',
      'artifactId',
      'workspaceVersion',
      'sandboxId',
      'durationMs',
      'replayed',
      'cancelRequested',
      'policyVersion',
      'simulated',
    ]);

    for (const forbidden of [
      'prompt',
      'token',
      'apiKey',
      'authorization',
      'toolOutput',
      'stdout',
      'stderr',
      'content',
      'text',
      'sql',
      'password',
      'path',
      'input',
      'output',
    ]) {
      expect(TASK_EVENT_PAYLOAD_KEYS).not.toContain(forbidden);
    }

    expect(Object.isFrozen(TASK_EVENT_PAYLOAD_KEYS)).toBe(true);
  });

  it('parses an allowlisted internal event', () => {
    expect(TaskEventSchema.parse(event)).toEqual(event);
  });

  it('rejects unknown phases, negative sequences and non-integer sequences', () => {
    expect(TaskEventSchema.safeParse({ ...event, phase: 'accepted_externally' }).success).toBe(
      false,
    );
    expect(TaskEventSchema.safeParse({ ...event, sequence: -1 }).success).toBe(false);
    expect(TaskEventSchema.safeParse({ ...event, sequence: 1.5 }).success).toBe(false);
  });

  it('rejects prompt, token, API key, SQL, host-path and tool-output keys', () => {
    const sensitiveKeys = [
      'prompt',
      'messages',
      'system',
      'token',
      'apiKey',
      'api_key',
      'apiToken',
      'authorization',
      'cookie',
      'credentials',
      'toolOutput',
      'stdout',
      'stderr',
      'content',
      'text',
      'sql',
      'password',
      'databaseUrl',
      'dbUrl',
      'stack',
      'path',
      'filePath',
      'headers',
      'input',
      'output',
      'raw',
      'secret',
    ];

    for (const key of sensitiveKeys) {
      expect(TaskEventPayloadSchema.safeParse({ [key]: 'sk_live_secret_value' }).success).toBe(
        false,
      );
    }
  });

  it('rejects secrets disguised inside allowlisted fields', () => {
    const secret = 'sk_live_51H8xDoNotPersist';

    for (const payload of [
      { taskKind: secret },
      { runId: secret },
      { attempt: secret },
      { route: secret },
      { fromStatus: secret },
      { toStatus: secret },
      { runStatus: secret },
      { errorCode: secret },
      { artifactId: secret },
      { workspaceVersion: secret },
      { sandboxId: secret },
      { durationMs: secret },
      { replayed: secret },
      { cancelRequested: secret },
      { policyVersion: secret },
      { simulated: secret },
    ]) {
      expect(TaskEventPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  it('rejects nested, array and null values and does not rely on length limits', () => {
    expect(TaskEventPayloadSchema.safeParse({ nested: { prompt: 'secret' } }).success).toBe(false);
    expect(TaskEventPayloadSchema.safeParse({ list: ['a', 'b'] }).success).toBe(false);
    expect(TaskEventPayloadSchema.safeParse({ note: null }).success).toBe(false);
    expect(TaskEventPayloadSchema.safeParse({ 'bad key': 'value' }).success).toBe(false);
    expect(TaskEventPayloadSchema.safeParse({ prompt: 'x'.repeat(100_000) }).success).toBe(false);
    expect(
      TaskEventPayloadSchema.safeParse(
        Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key_${index}`, index])),
      ).success,
    ).toBe(false);
  });

  it('maps valid events to the DTO and fails closed on tampered runtime payloads', () => {
    const dto = toTaskEventDto(event);

    expect(dto).toEqual({
      task_id: UUID,
      sequence: 1,
      phase: 'started',
      occurred_at: ISO_TIME,
      trace_id: OTHER_UUID,
      payload: event.payload,
    });
    expect(TaskEventDtoSchema.parse(dto)).toEqual(dto);
    expect(TaskEventDtoSchema.safeParse({ ...dto, taskId: UUID }).success).toBe(false);
    expect(TaskEventSchema.safeParse({ ...event, secret: 'top-level' }).success).toBe(false);

    const tampered = {
      ...event,
      payload: {
        ...event.payload,
        prompt: 'raw prompt that must never be persisted',
        apiToken: 'sk_live_tampered_token',
      },
    } as unknown as TaskEvent;

    try {
      toTaskEventDto(tampered);
      expect.unreachable('expected the tampered event to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      const invalid = error as InvalidArgumentError;
      expect(invalid.code).toBe('INVALID_ARGUMENT');
      expect(invalid.issues.length).toBeGreaterThan(0);

      const serialized = JSON.stringify({
        message: invalid.message,
        publicMessage: invalid.publicMessage,
        issues: invalid.issues,
        response: toErrorResponse(invalid),
      });
      expect(serialized).not.toContain('raw prompt');
      expect(serialized).not.toContain('sk_live_tampered_token');
    }
  });
});
