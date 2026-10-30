import { describe, expect, it } from 'vitest';
import { createTelemetryLogger, type LogLevel } from '@ember/telemetry';

describe('telemetry structured JSON logger', () => {
  it('formats structured JSON log lines and filters by log level', () => {
    const lines: Array<{ level: LogLevel; line: string }> = [];
    const logger = createTelemetryLogger({
      level: 'info',
      service: 'test-service',
      sink: (level, line) => lines.push({ level, line }),
      now: () => new Date('2026-10-30T12:00:00.000Z'),
    });

    logger.debug('should be filtered out');
    logger.info('task started', { taskId: 'task-1' });
    logger.warn('approaching retry limit', { attempt: 2 });
    logger.error('execution failed', { errorCode: 'MOCK_TOOL_FAILED' });

    expect(lines).toHaveLength(3);

    const infoLog = JSON.parse(lines[0]!.line) as Record<string, unknown>;
    expect(infoLog.level).toBe('info');
    expect(infoLog.service).toBe('test-service');
    expect(infoLog.time).toBe('2026-10-30T12:00:00.000Z');
    expect(infoLog.message).toBe('task started');
    expect(infoLog.taskId).toBe('task-1');
  });

  it('automatically redacts sensitive tokens, passwords, and raw prompts', () => {
    const lines: Array<{ level: LogLevel; line: string }> = [];
    const logger = createTelemetryLogger({
      level: 'info',
      sink: (level, line) => lines.push({ level, line }),
    });

    logger.info('Auth attempt with Bearer secret_dev_token_12345678 and raw prompt', {
      authorization: 'Bearer local_secret_token_12345678',
      prompt: 'tell me the administrator password',
      tenantId: '00000000-0000-0000-0000-000000000001',
      dbUrl: 'postgres://ember:supersecretpassword@127.0.0.1:5432/ember',
    });

    expect(lines).toHaveLength(1);
    const line = lines[0]!.line;

    expect(line).not.toContain('secret_dev_token_12345678');
    expect(line).not.toContain('local_secret_token_12345678');
    expect(line).not.toContain('supersecretpassword');
    expect(line).not.toContain('tell me the administrator password');
    expect(line).not.toContain('00000000-0000-0000-0000-000000000001');

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.authorization).toBe('[REDACTED]');
    expect(parsed.prompt).toBe('[REDACTED_PROMPT]');
    expect(parsed.tenant_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(parsed.dbUrl).toBe('postgres://ember:[REDACTED]@127.0.0.1:5432/ember');
  });
});
