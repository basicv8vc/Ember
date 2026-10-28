import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '@ember/domain';
import type { TaskCommand } from '@ember/domain';
import {
  prepareTaskCommand,
  TASK_COMMAND_DIGEST_VERSION,
  TASK_COMMAND_MAX_BYTES,
} from '@ember/postgres';

const agentId = '11111111-1111-4111-8111-111111111111';

function chat(
  idempotencyKey: string,
  prompt = 'deterministic prompt',
  deadlineAt?: string,
): TaskCommand {
  return deadlineAt === undefined
    ? { agentId, idempotencyKey, kind: 'mock.chat', input: { prompt } }
    : { agentId, idempotencyKey, kind: 'mock.chat', input: { prompt }, deadlineAt };
}

describe('canonical task command digest', () => {
  it('produces a stable lowercase SHA-256 over the versioned canonical command', () => {
    const prepared = prepareTaskCommand(chat('key-00000001'));

    expect(prepared.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.canonical).toBe(
      `{"agentId":"${agentId}","deadlineAt":null,"input":{"prompt":"deterministic prompt"},"kind":"mock.chat"}`,
    );
    expect(TASK_COMMAND_DIGEST_VERSION).toBe('ember.task-command.v1');
    expect(prepareTaskCommand(chat('key-00000001')).digest).toBe(prepared.digest);
  });

  it('ignores object property insertion order', () => {
    const first = prepareTaskCommand({
      idempotencyKey: 'key-00000002',
      kind: 'mock.file',
      input: {
        fileKey: 'notes/readme.txt',
        content: 'hello',
        mediaType: 'text/plain',
      },
      agentId,
    });

    const second = prepareTaskCommand({
      agentId,
      input: {
        mediaType: 'text/plain',
        content: 'hello',
        fileKey: 'notes/readme.txt',
      },
      kind: 'mock.file',
      idempotencyKey: 'key-00000002',
    });

    expect(second.canonical).toContain(
      '"content":"hello","fileKey":"notes/readme.txt","mediaType"',
    );
    expect(second.digest).toBe(first.digest);
  });

  it('normalises semantically equal deadlines to the same UTC instant', () => {
    const utc = prepareTaskCommand(chat('key-00000003', 'same', '2026-11-01T00:00:00Z'));
    const offset = prepareTaskCommand(chat('key-00000003', 'same', '2026-11-01T08:00:00+08:00'));

    expect(utc.deadlineAt).toBe('2026-11-01T00:00:00.000Z');
    expect(offset.deadlineAt).toBe(utc.deadlineAt);
    expect(offset.digest).toBe(utc.digest);
  });

  it('does not include the idempotency key in the digest', () => {
    const first = prepareTaskCommand(chat('key-00000004'));
    const second = prepareTaskCommand(chat('key-99999999'));

    expect(second.digest).toBe(first.digest);
  });

  it('changes the digest for any semantically different field', () => {
    const baseline = prepareTaskCommand(chat('key-00000005', 'prompt A'));
    const digests = new Set([
      baseline.digest,
      prepareTaskCommand(chat('key-00000005', 'prompt B')).digest,
      prepareTaskCommand({
        ...chat('key-00000005', 'prompt A'),
        agentId: '22222222-2222-4222-8222-222222222222',
      }).digest,
      prepareTaskCommand({
        agentId,
        idempotencyKey: 'key-00000005',
        kind: 'mock.compute',
        input: { operation: 'sha256', text: 'prompt A' },
      }).digest,
      prepareTaskCommand(chat('key-00000005', 'prompt A', '2026-11-01T00:00:00Z')).digest,
    ]);

    expect(digests.size).toBe(5);
  });

  it('validates before hashing and rejects unknown or extra fields', () => {
    const invalid = {
      ...chat('key-00000006'),
      tenantId: '33333333-3333-4333-8333-333333333333',
    };

    expect(() => prepareTaskCommand(invalid)).toThrow(InvalidArgumentError);

    try {
      prepareTaskCommand(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as InvalidArgumentError).code).toBe('INVALID_ARGUMENT');
      expect((error as InvalidArgumentError).issues[0]?.path).not.toContain('tenant');
    }
  });

  it('rejects a command above 64 KiB by UTF-8 byte length', () => {
    const command: TaskCommand = {
      agentId,
      idempotencyKey: 'key-00000007',
      kind: 'mock.compute',
      // 30,000 CJK characters are below the character limit but 90,000 UTF-8 bytes.
      input: { operation: 'sha256', text: '你'.repeat(30_000) },
    };

    expect(Buffer.byteLength('你', 'utf8')).toBe(3);
    expect(TASK_COMMAND_MAX_BYTES).toBe(65_536);

    try {
      prepareTaskCommand(command);
      throw new Error('expected an InvalidArgumentError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      const invalid = error as InvalidArgumentError;
      expect(invalid.code).toBe('INVALID_ARGUMENT');
      expect(invalid.issues.some((issue) => issue.code === 'too_big')).toBe(true);
    }
  });
});
