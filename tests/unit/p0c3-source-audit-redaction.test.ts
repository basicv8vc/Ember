import { describe, expect, it } from 'vitest';
import {
  createFakeGuardedSourceReader,
  createSourceAuditRecord,
  hashTenantId,
  InMemorySourceAuditSink,
  TEST_TENANT_A,
  type SourceAuditRecord,
  type TrustedSourceAccessContext,
} from '@ember/connectors';

describe('P0-C3C: Source Audit Sanitization and Redaction', () => {
  const validContext: TrustedSourceAccessContext = {
    tenantId: TEST_TENANT_A,
    commitmentId: 'comm_11111111-1111-1111-1111-111111111111',
    taskId: 'task_11111111-1111-1111-1111-111111111111',
    runId: 'run_11111111-1111-1111-1111-111111111111',
    leaseEpoch: 1,
    authorizedAt: '2026-11-01T12:00:00.000Z',
  };

  it('hashes tenantId using SHA-256 and never leaks raw tenantId string in audit records', async () => {
    const bundle = createFakeGuardedSourceReader();
    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    await bundle.guardedReader.readSnapshot('sp_ember_releases', validContext);

    const records = bundle.auditSink.getRecords();
    expect(records).toHaveLength(1);

    const record = records[0]!;
    expect(record.tenantIdHash).toBe(hashTenantId(TEST_TENANT_A));
    expect(record.tenantIdHash).toHaveLength(16);
    expect(record.tenantIdHash).toMatch(/^[0-9a-f]{16}$/);

    // Assert raw tenant ID string is not present anywhere in the serialized audit record
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(TEST_TENANT_A);
  });

  it('sanitizes denial reasons to static safe descriptions without raw exception or prompt text', async () => {
    const bundle = createFakeGuardedSourceReader();

    // Denied attempt
    await expect(
      bundle.guardedReader.readSnapshot('sp_ember_releases', validContext),
    ).rejects.toThrow();

    const records = bundle.auditSink.getRecords();
    expect(records).toHaveLength(1);

    const record = records[0]!;
    expect(record.decision).toBe('DENIED');
    expect(record.denialCode).toBe('CONSENT_NOT_FOUND');
    expect(record.denialReason).toBe('No active consent grant for source profile');

    // Verify no stack traces, URLs, or query parameters are logged
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('Error:');
    expect(serialized).not.toContain('at ');
    expect(serialized).not.toContain('https://');
  });

  it('strictly enforces networkCallsMade === 0 invariant', () => {
    const sink = new InMemorySourceAuditSink();
    const validRecord = createSourceAuditRecord({
      tenantId: TEST_TENANT_A,
      commitmentId: 'comm_1',
      taskId: 'task_1',
      sourceProfileId: 'sp_ember_releases',
      decision: 'ALLOWED',
    });

    expect(validRecord.networkCallsMade).toBe(0);
    sink.record(validRecord);
    expect(sink.getRecords()).toHaveLength(1);

    // Attempting to record non-zero network calls throws an integrity violation
    const tamperedRecord = {
      ...validRecord,
      networkCallsMade: 1 as 0,
    } as SourceAuditRecord;

    expect(() => {
      sink.record(tamperedRecord);
    }).toThrowError(/Integrity violation: networkCallsMade must strictly be 0/i);
  });
});
