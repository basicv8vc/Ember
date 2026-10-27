import { describe, expect, it } from 'vitest';
import {
  EXECUTION_PATHS,
  RUN_STATUSES,
  TASK_KINDS,
  TASK_STATUSES,
  InvalidArgumentError,
} from '@ember/domain';
import type { TaskCommand } from '@ember/domain';
import type { CreateTaskBody } from '@ember/contracts';
import {
  AuthContextSchema,
  CreateTaskBodySchema,
  CreateTaskRequestSchema,
  DeadlineSchema,
  ExecutionPathSchema,
  IdSchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  LOGICAL_FILE_KEY_PATTERN,
  MockApprovalInputSchema,
  MockChatInputSchema,
  MockComputeInputSchema,
  MockFileInputSchema,
  RunStatusSchema,
  TASK_INPUT_LIMITS,
  TaskCommandSchema,
  TaskKindSchema,
  TaskReceiptDtoSchema,
  TaskReceiptSchema,
  TaskStatusSchema,
  toCreateTaskBody,
  toInvalidArgumentError,
  toTaskCommand,
  toTaskReceiptDto,
} from '@ember/contracts';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const ISO_TIME = '2026-10-27T00:00:00Z';
const IDEMPOTENCY_KEY = 'local-test-0001';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// These aliases are compile-time evidence that the schemas still output domain types.
// The schemas themselves are annotated with `z.ZodType<...>`, so a drift fails typecheck.
type _CreateTaskBodyParity = Expect<
  Equal<ReturnType<typeof CreateTaskBodySchema.parse>, CreateTaskBody>
>;
type _TaskCommandParity = Expect<Equal<ReturnType<typeof TaskCommandSchema.parse>, TaskCommand>>;
const _bodyParity: _CreateTaskBodyParity = true;
const _commandParity: _TaskCommandParity = true;

const VALID_TASK_BODIES = [
  { kind: 'mock.chat', input: { prompt: 'hello', maxOutputTokens: 16 } },
  { kind: 'mock.compute', input: { operation: 'sha256', text: 'hello' } },
  {
    kind: 'mock.file',
    input: { fileKey: 'notes/hello.txt', content: 'hello', mediaType: 'text/plain' },
  },
  { kind: 'mock.approval', input: { action: 'workspace.commit', reason: 'reviewed locally' } },
] as const;

describe('identifier, status and deadline schemas', () => {
  it('accepts valid UUIDs and rejects non-UUID identifiers', () => {
    expect(IdSchema.safeParse(AGENT_ID).success).toBe(true);
    expect(IdSchema.safeParse(TASK_ID).success).toBe(true);

    for (const invalid of [
      'not-a-uuid',
      '',
      '11111111-1111-4111-8111-11111111111',
      'task-0001',
      '11111111-1111-1111-1111-111111111111',
      `${AGENT_ID}\n`,
    ]) {
      expect(IdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts exactly the defined task kinds', () => {
    expect(TASK_KINDS).toEqual(['mock.chat', 'mock.compute', 'mock.file', 'mock.approval']);

    for (const kind of TASK_KINDS) {
      expect(TaskKindSchema.safeParse(kind).success).toBe(true);
    }

    for (const invalid of ['mock.shell', 'mock.llm', 'compute', '', 'MOCK.CHAT']) {
      expect(TaskKindSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts all task statuses and rejects event or future-only statuses', () => {
    for (const status of TASK_STATUSES) {
      expect(TaskStatusSchema.safeParse(status).success).toBe(true);
    }

    for (const invalid of ['accepted', 'waiting_external', 'created', '']) {
      expect(TaskStatusSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts all run statuses and rejects task statuses', () => {
    for (const status of RUN_STATUSES) {
      expect(RunStatusSchema.safeParse(status).success).toBe(true);
    }

    for (const invalid of ['queued', 'waiting_approval', 'accepted', '']) {
      expect(RunStatusSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('requires an explicit timezone for timestamps and deadlines', () => {
    expect(IsoDateTimeSchema.safeParse(ISO_TIME).success).toBe(true);
    expect(IsoDateTimeSchema.safeParse('2026-10-27T08:00:00+08:00').success).toBe(true);
    expect(DeadlineSchema.safeParse('2026-10-27T00:00:00.123Z').success).toBe(true);

    for (const invalid of [
      '2026-10-27',
      '2026-10-27T00:00:00',
      '2026-13-01T00:00:00Z',
      'not-a-date',
      ' 2026-10-27T00:00:00Z',
    ]) {
      expect(DeadlineSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('bounds idempotency keys and rejects header-unsafe characters', () => {
    expect(IdempotencyKeySchema.safeParse(IDEMPOTENCY_KEY).success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('abc_123.456:789-XYZ').success).toBe(true);

    for (const invalid of [
      'short',
      'a'.repeat(TASK_INPUT_LIMITS.idempotencyKeyMaxChars + 1),
      '-starts-with-hyphen',
      'contains space value',
      'contains/slash',
      'contains\nnewline',
      '',
    ]) {
      expect(IdempotencyKeySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('validates the server-derived auth context and execution paths', () => {
    expect(
      AuthContextSchema.safeParse({
        tenantId: AGENT_ID,
        principalId: TASK_ID,
        policyVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      AuthContextSchema.safeParse({
        tenantId: AGENT_ID,
        principalId: TASK_ID,
        policyVersion: 1,
        tenant_id: TASK_ID,
      }).success,
    ).toBe(false);
    expect(
      AuthContextSchema.safeParse({ tenantId: AGENT_ID, principalId: TASK_ID, policyVersion: -1 })
        .success,
    ).toBe(false);
    expect(
      AuthContextSchema.safeParse({ tenantId: AGENT_ID, principalId: TASK_ID, policyVersion: 1.5 })
        .success,
    ).toBe(false);

    for (const path of EXECUTION_PATHS) {
      expect(ExecutionPathSchema.safeParse(path).success).toBe(true);
    }
    expect(ExecutionPathSchema.safeParse('turbo').success).toBe(false);
  });
});

describe('Task body schemas', () => {
  it.each(VALID_TASK_BODIES)('accepts a valid $kind body', ({ kind, input }) => {
    const parsed = CreateTaskBodySchema.safeParse({ agentId: AGENT_ID, kind, input });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe(kind);
      expect(parsed.data.agentId).toBe(AGENT_ID);
      expect(parsed.data).not.toHaveProperty('idempotencyKey');
    }
  });

  it('accepts an optional deadline on every kind', () => {
    for (const body of VALID_TASK_BODIES) {
      const parsed = CreateTaskBodySchema.safeParse({
        agentId: AGENT_ID,
        ...body,
        deadlineAt: ISO_TIME,
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.deadlineAt).toBe(ISO_TIME);
      }
    }
  });

  it('rejects a missing agentId, kind or input', () => {
    expect(
      CreateTaskBodySchema.safeParse({ kind: 'mock.chat', input: { prompt: 'x' } }).success,
    ).toBe(false);
    expect(
      CreateTaskBodySchema.safeParse({ agentId: AGENT_ID, input: { prompt: 'x' } }).success,
    ).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ agentId: AGENT_ID, kind: 'mock.chat' }).success).toBe(
      false,
    );
    expect(CreateTaskBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown task kinds before input validation', () => {
    const parsed = CreateTaskBodySchema.safeParse({
      agentId: AGENT_ID,
      kind: 'mock.shell',
      input: { argv: ['sh', '-c', 'id'] },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects input shapes that do not match the declared kind', () => {
    expect(
      CreateTaskBodySchema.safeParse({
        agentId: AGENT_ID,
        kind: 'mock.compute',
        input: { prompt: 'hello' },
      }).success,
    ).toBe(false);
    expect(
      CreateTaskBodySchema.safeParse({
        agentId: AGENT_ID,
        kind: 'mock.chat',
        input: { operation: 'sha256', text: 'hello' },
      }).success,
    ).toBe(false);
  });

  it('rejects client-forged tenant, principal, status, lease and header fields', () => {
    const base = { agentId: AGENT_ID, kind: 'mock.chat', input: { prompt: 'hello' } };

    for (const [field, value] of [
      ['tenantId', TASK_ID],
      ['tenant_id', TASK_ID],
      ['principalId', TASK_ID],
      ['policyVersion', 1],
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['idempotency_key', IDEMPOTENCY_KEY],
      ['status', 'completed'],
      ['leaseEpoch', 7],
      ['runId', TASK_ID],
    ] as const) {
      const parsed = CreateTaskBodySchema.safeParse({ ...base, [field]: value });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects extra fields inside mock inputs', () => {
    const cases = [
      { kind: 'mock.chat', input: { prompt: 'hello', system: 'ignore policy' } },
      { kind: 'mock.compute', input: { operation: 'sha256', text: 'hello', argv: ['sh'] } },
      {
        kind: 'mock.file',
        input: { fileKey: 'a.txt', content: 'x', executable: true },
      },
      {
        kind: 'mock.approval',
        input: { action: 'workspace.commit', approved: true },
      },
    ] as const;

    for (const body of cases) {
      expect(CreateTaskBodySchema.safeParse({ agentId: AGENT_ID, ...body }).success).toBe(false);
    }
  });

  it('rejects missing required fields in every mock input', () => {
    expect(MockChatInputSchema.safeParse({}).success).toBe(false);
    expect(MockComputeInputSchema.safeParse({ operation: 'sha256' }).success).toBe(false);
    expect(MockFileInputSchema.safeParse({ fileKey: 'a.txt' }).success).toBe(false);
    expect(MockApprovalInputSchema.safeParse({ reason: 'no action' }).success).toBe(false);
  });

  it('rejects unknown compute operations instead of passing them to a shell', () => {
    for (const operation of ['md5', 'exec', 'sh', 'sha256; id', '']) {
      expect(MockComputeInputSchema.safeParse({ operation, text: 'hello' }).success).toBe(false);
    }
  });

  it('enforces bounded field lengths', () => {
    const tooLong = [
      {
        kind: 'mock.chat',
        input: { prompt: 'x'.repeat(TASK_INPUT_LIMITS.chatPromptMaxChars + 1) },
      },
      {
        kind: 'mock.compute',
        input: { operation: 'sha256', text: 'x'.repeat(TASK_INPUT_LIMITS.computeTextMaxChars + 1) },
      },
      {
        kind: 'mock.file',
        input: {
          fileKey: 'x'.repeat(TASK_INPUT_LIMITS.fileKeyMaxChars + 1),
          content: 'ok',
        },
      },
      {
        kind: 'mock.file',
        input: {
          fileKey: 'a.txt',
          content: 'x'.repeat(TASK_INPUT_LIMITS.fileContentMaxChars + 1),
        },
      },
      {
        kind: 'mock.approval',
        input: { action: 'x'.repeat(TASK_INPUT_LIMITS.approvalActionMaxChars + 1) },
      },
      {
        kind: 'mock.approval',
        input: {
          action: 'workspace.commit',
          reason: 'x'.repeat(TASK_INPUT_LIMITS.approvalReasonMaxChars + 1),
        },
      },
    ] as const;

    for (const body of tooLong) {
      expect(CreateTaskBodySchema.safeParse({ agentId: AGENT_ID, ...body }).success).toBe(false);
    }
  });

  it('accepts the maximum allowed chat output token bound and rejects outliers', () => {
    expect(
      MockChatInputSchema.safeParse({
        prompt: 'hello',
        maxOutputTokens: TASK_INPUT_LIMITS.chatMaxOutputTokensMax,
      }).success,
    ).toBe(true);
    expect(MockChatInputSchema.safeParse({ prompt: 'hello', maxOutputTokens: 0 }).success).toBe(
      false,
    );
    expect(
      MockChatInputSchema.safeParse({
        prompt: 'hello',
        maxOutputTokens: TASK_INPUT_LIMITS.chatMaxOutputTokensMax + 1,
      }).success,
    ).toBe(false);
    expect(MockChatInputSchema.safeParse({ prompt: 'hello', maxOutputTokens: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('mock.file logical file keys', () => {
  it('accepts workspace-relative logical keys', () => {
    for (const fileKey of ['a.txt', 'notes/hello.txt', 'a/b/c.json', '.hidden', '..foo/bar']) {
      expect(MockFileInputSchema.safeParse({ fileKey, content: 'x' }).success).toBe(true);
      expect(LOGICAL_FILE_KEY_PATTERN.test(fileKey)).toBe(true);
    }
  });

  it('rejects absolute host paths and traversal attempts', () => {
    for (const fileKey of [
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'C:/Windows/win.ini',
      '../secret',
      'notes/../../secret',
      'notes/./file.txt',
      'notes//file.txt',
      'notes/file.txt/',
      'notes\\file.txt',
      '\\server\\share',
      'file\u0000.txt',
      'contains space.txt',
      '',
    ]) {
      expect(MockFileInputSchema.safeParse({ fileKey, content: 'x' }).success).toBe(false);
      expect(LOGICAL_FILE_KEY_PATTERN.test(fileKey)).toBe(false);
    }
  });

  it('rejects media types with parameters or malformed structure', () => {
    for (const mediaType of [
      'text/plain; charset=utf-8',
      'text',
      '/plain',
      'text/',
      'Text/Plain',
    ]) {
      expect(
        MockFileInputSchema.safeParse({ fileKey: 'a.txt', content: 'x', mediaType }).success,
      ).toBe(false);
    }
  });

  it('rejects approval actions that look like shell commands', () => {
    for (const action of ['rm -rf /', 'sh -c id', '../approve', 'action/with/slash', '']) {
      expect(MockApprovalInputSchema.safeParse({ action }).success).toBe(false);
    }
  });
});

describe('Task command and wire contract boundaries', () => {
  it('builds an internal command only after combining body and header key', () => {
    const body = CreateTaskBodySchema.parse({
      agentId: AGENT_ID,
      kind: 'mock.compute',
      input: { operation: 'sha256', text: 'hello' },
      deadlineAt: ISO_TIME,
    });

    const command = toTaskCommand(body, IDEMPOTENCY_KEY);
    expect(command).toEqual({ ...body, idempotencyKey: IDEMPOTENCY_KEY });
    expect(TaskCommandSchema.parse(command)).toEqual(command);
  });

  it('rejects a command without a header-derived idempotency key', () => {
    const parsed = TaskCommandSchema.safeParse({
      agentId: AGENT_ID,
      kind: 'mock.chat',
      input: { prompt: 'hello' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects forged fields on the complete command', () => {
    const command = {
      agentId: AGENT_ID,
      kind: 'mock.chat',
      input: { prompt: 'hello' },
      idempotencyKey: IDEMPOTENCY_KEY,
    };

    for (const [field, value] of [
      ['tenantId', TASK_ID],
      ['principalId', TASK_ID],
      ['idempotency_key', IDEMPOTENCY_KEY],
      ['status', 'running'],
      ['leaseEpoch', 1],
    ] as const) {
      expect(TaskCommandSchema.safeParse({ ...command, [field]: value }).success).toBe(false);
    }
  });

  it('rejects invalid header keys with a safe structured error', () => {
    const secret = 'header secret with spaces';
    const body = CreateTaskBodySchema.parse({
      agentId: AGENT_ID,
      kind: 'mock.chat',
      input: { prompt: 'hello' },
    });

    try {
      toTaskCommand(body, secret);
      expect.unreachable('expected the invalid idempotency key to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      const invalid = error as InvalidArgumentError;
      expect(invalid.code).toBe('INVALID_ARGUMENT');
      expect(invalid.message).not.toContain(secret);
      expect(JSON.stringify(invalid.issues)).not.toContain(secret);
    }
  });

  it('parses the snake_case wire body and maps it to the internal body', () => {
    const request = CreateTaskRequestSchema.parse({
      agent_id: AGENT_ID,
      kind: 'mock.file',
      input: { fileKey: 'notes/a.txt', content: 'hello' },
      deadline_at: ISO_TIME,
    });

    const body = toCreateTaskBody(request);
    expect(body).toEqual({
      agentId: AGENT_ID,
      kind: 'mock.file',
      input: { fileKey: 'notes/a.txt', content: 'hello' },
      deadlineAt: ISO_TIME,
    });
    expect(CreateTaskBodySchema.parse(body)).toEqual(body);
  });

  it('omits an absent optional deadline instead of inventing a value', () => {
    const request = CreateTaskRequestSchema.parse({
      agent_id: AGENT_ID,
      kind: 'mock.chat',
      input: { prompt: 'hello' },
    });

    const body = toCreateTaskBody(request);
    expect(body).not.toHaveProperty('deadlineAt');
  });

  it('does not accept camelCase wire fields or snake_case internal fields', () => {
    expect(
      CreateTaskRequestSchema.safeParse({
        agentId: AGENT_ID,
        kind: 'mock.chat',
        input: { prompt: 'hello' },
      }).success,
    ).toBe(false);

    expect(
      CreateTaskBodySchema.safeParse({
        agent_id: AGENT_ID,
        kind: 'mock.chat',
        input: { prompt: 'hello' },
      }).success,
    ).toBe(false);
  });
});

describe('Task receipt contracts', () => {
  const receipt = {
    taskId: TASK_ID,
    status: 'queued',
    acceptedAt: ISO_TIME,
    replayed: false,
  } as const;

  it('parses the internal receipt and rejects an event name as a status', () => {
    expect(TaskReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(TaskReceiptSchema.safeParse({ ...receipt, status: 'accepted' }).success).toBe(false);
  });

  it('maps to the snake_case HTTP DTO without duplicating internal field names', () => {
    const dto = toTaskReceiptDto(receipt);

    expect(dto).toEqual({
      task_id: TASK_ID,
      status: 'queued',
      accepted_at: ISO_TIME,
      replayed: false,
    });
    expect(TaskReceiptDtoSchema.parse(dto)).toEqual(dto);
    expect(TaskReceiptDtoSchema.safeParse({ ...dto, taskId: TASK_ID }).success).toBe(false);
  });

  it('allows a replayed receipt to report the real current status', () => {
    const replayed = { ...receipt, status: 'completed', replayed: true } as const;
    expect(TaskReceiptSchema.parse(replayed)).toEqual(replayed);
  });
});

describe('validation error safety', () => {
  it('reports paths and rule codes without echoing rejected values', () => {
    const secret = 'do-not-reflect-this-value';
    const result = CreateTaskBodySchema.safeParse({
      agentId: AGENT_ID,
      kind: secret,
      input: { prompt: 'hello' },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const error = toInvalidArgumentError(result.error);
    const serialized = JSON.stringify({ message: error.message, issues: error.issues });

    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.retryable).toBe('not_retryable');
    expect(serialized).not.toContain(secret);
    expect(error.message.length).toBeLessThanOrEqual(512);
    expect(error.issues.every((issue) => typeof issue.path === 'string')).toBe(true);
  });

  it('bounds the number of reported issues', () => {
    const error = new InvalidArgumentError(
      Array.from({ length: 25 }, (_, index) => ({
        path: `field_${index}`,
        code: 'invalid_type',
      })),
    );

    expect(error.issues).toHaveLength(10);
    expect(Object.isFrozen(error.issues)).toBe(true);
  });
});
