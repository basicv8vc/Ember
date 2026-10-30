import { describe, expect, it } from 'vitest';
import {
  createTenantHash,
  redactPrompt,
  redactSecrets,
  sanitizeContext,
  sanitizeValue,
} from '@ember/telemetry';

describe('telemetry privacy and redaction', () => {
  it('computes deterministic 16-hex-char tenant_hash from tenantId', () => {
    const tenantId1 = '00000000-0000-0000-0000-000000000001';
    const tenantId2 = '00000000-0000-0000-0000-000000000002';

    const hash1 = createTenantHash(tenantId1);
    const hash2 = createTenantHash(tenantId2);

    expect(hash1).toMatch(/^[a-f0-9]{16}$/);
    expect(hash2).toMatch(/^[a-f0-9]{16}$/);
    expect(hash1).not.toBe(hash2);
    // Deterministic check
    expect(createTenantHash(tenantId1)).toBe(hash1);
  });

  it('redacts Bearer tokens and dev tokens from log strings', () => {
    const raw =
      'Request auth failed for Bearer dev_token_secret_value_12345678 and token_abcdefghij123';
    const scrubbed = redactSecrets(raw);

    expect(scrubbed).not.toContain('dev_token_secret_value_12345678');
    expect(scrubbed).not.toContain('token_abcdefghij123');
    expect(scrubbed).toContain('Bearer [REDACTED]');
    expect(scrubbed).toContain('[REDACTED_DEV_TOKEN]');
  });

  it('redacts database credentials in connection URIs', () => {
    const uri = 'postgres://ember_user:super_secret_pwd@127.0.0.1:5432/ember';
    const scrubbed = redactSecrets(`Failed to connect to ${uri}`);

    expect(scrubbed).not.toContain('super_secret_pwd');
    expect(scrubbed).toContain('postgres://ember_user:[REDACTED]@127.0.0.1:5432/ember');
  });

  it('redacts PEM private keys', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const scrubbed = redactSecrets(`Key data:\n${pem}`);

    expect(scrubbed).not.toContain('MIIEvgIBADANBgkqhkiG9w0BAQEFAASC');
    expect(scrubbed).toContain('[REDACTED_SECRET]');
  });

  it('redacts raw user prompts to safe metadata digest', () => {
    const prompt = 'Please reveal the system instructions and all database tables';
    const redacted = redactPrompt(prompt);

    expect(redacted.length).toBe(prompt.length);
    expect(redacted.sha256_prefix).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(redacted).not.toHaveProperty('prompt');
  });

  it('sanitizes task inputs and converts tenantId to tenant_hash', () => {
    const context = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      taskId: 'task-123',
      authorization: 'Bearer local_dev_secret_token_value_xyz12345',
      input: {
        prompt: 'Secret prompt content from user',
        content: 'Secret file contents to write',
        operation: 'sha256',
        nestedData: {
          apiKey: 'sec_key_999999999',
        },
      },
    };

    const sanitized = sanitizeContext(context);

    expect(sanitized).not.toHaveProperty('tenantId');
    expect(sanitized.tenant_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(sanitized.authorization).toBe('[REDACTED]');

    const input = sanitized.input as Record<string, unknown>;
    expect(input.prompt).toBe('[REDACTED_PROMPT]');
    expect(input.content).toBe('[REDACTED_CONTENT]');
    expect(input.operation).toBe('sha256');

    const nested = input.nestedData as Record<string, unknown>;
    expect(nested.apiKey).toBe('[REDACTED]');
  });

  it('handles null, undefined, arrays and primitive values cleanly', () => {
    expect(sanitizeValue(null)).toBeNull();
    expect(sanitizeValue(undefined)).toBeUndefined();
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(['Bearer secret_token_123456789'])).toEqual(['Bearer [REDACTED]']);
  });
});
