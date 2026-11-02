import { describe, expect, it } from 'vitest';
import {
  createFakeGuardedSourceReader,
  TEST_TENANT_A,
  type TrustedSourceAccessContext,
} from '@ember/connectors';

describe('P0-C3C: Consent Revocation & In-Flight Lifecycle Matrix', () => {
  const validContext: TrustedSourceAccessContext = {
    tenantId: TEST_TENANT_A,
    commitmentId: 'comm_11111111-1111-1111-1111-111111111111',
    taskId: 'task_11111111-1111-1111-1111-111111111111',
    runId: 'run_11111111-1111-1111-1111-111111111111',
    leaseEpoch: 1,
    authorizedAt: '2026-11-01T12:00:00.000Z',
  };

  it('allows read when consent is valid before and after execution', async () => {
    const bundle = createFakeGuardedSourceReader({
      simulatedLatencyMs: 10,
    });

    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    const signal = new AbortController().signal;
    const snapshot = await bundle.guardedReader.readSnapshot(
      'sp_ember_releases',
      validContext,
      signal,
    );
    expect(snapshot).toBeDefined();
    expect(snapshot.sourceProfileId).toBe('sp_ember_releases');

    const auditRecords = bundle.auditSink.getRecords();
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.decision).toBe('ALLOWED');
    expect(auditRecords[0]?.networkCallsMade).toBe(0);
  });

  it('implements Check 2: discards snapshot when consent is revoked mid-execution', async () => {
    // Reader has 50ms latency
    const bundle = createFakeGuardedSourceReader({
      simulatedLatencyMs: 50,
    });

    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    const signal = new AbortController().signal;

    // Start snapshot read in background
    const readPromise = bundle.guardedReader.readSnapshot(
      'sp_ember_releases',
      validContext,
      signal,
    );

    // Revoke consent while reader is in-flight (at 15ms)
    setTimeout(() => {
      bundle.registry.revoke(TEST_TENANT_A, 'sp_ember_releases');
    }, 15);

    // Expect the read to be rejected at Pre-Publish Check 2 and snapshot discarded
    await expect(readPromise).rejects.toThrowError(/Operation denied by policy/i);

    const auditRecords = bundle.auditSink.getRecords();
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.decision).toBe('DENIED');
    expect(auditRecords[0]?.denialCode).toBe('REVOKED_DURING_EXECUTION');
    expect(auditRecords[0]?.networkCallsMade).toBe(0);

    // Immediate subsequent read fails at Check 1 (pre-read)
    await expect(
      bundle.guardedReader.readSnapshot('sp_ember_releases', validContext, signal),
    ).rejects.toThrowError(/Operation denied by policy/i);
  });

  it('implements Check 2: discards snapshot when consent grant expires mid-execution', async () => {
    let mockCurrentTime = new Date('2026-11-01T12:00:00.000Z');

    const bundle = createFakeGuardedSourceReader({
      simulatedLatencyMs: 40,
      nowProvider: () => mockCurrentTime,
    });

    // Grant expires at 12:00:10
    bundle.registry.grant(
      {
        tenantId: TEST_TENANT_A,
        sourceProfileId: 'sp_ember_releases',
        expiresAt: '2026-11-01T12:00:10.000Z',
      },
      mockCurrentTime,
    );

    const signal = new AbortController().signal;

    // Start read at 12:00:00 (Check 1 passes)
    const readPromise = bundle.guardedReader.readSnapshot(
      'sp_ember_releases',
      validContext,
      signal,
    );

    // Advance clock past expiration at 15ms
    setTimeout(() => {
      mockCurrentTime = new Date('2026-11-01T12:00:20.000Z');
    }, 15);

    await expect(readPromise).rejects.toThrowError(/Operation denied by policy/i);

    const auditRecords = bundle.auditSink.getRecords();
    const lastRecord = auditRecords[auditRecords.length - 1];
    expect(lastRecord?.decision).toBe('DENIED');
    expect(lastRecord?.denialCode).toBe('REVOKED_DURING_EXECUTION');
  });

  it('cooperatively cancels read when AbortSignal triggers prior to invocation', async () => {
    const bundle = createFakeGuardedSourceReader();
    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    const abortController = new AbortController();
    abortController.abort(); // already aborted

    await expect(
      bundle.guardedReader.readSnapshot('sp_ember_releases', validContext, abortController.signal),
    ).rejects.toThrowError(/Operation was cancelled|Snapshot read was aborted/i);

    const auditRecords = bundle.auditSink.getRecords();
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.decision).toBe('DENIED');
    expect(auditRecords[0]?.denialCode).toBe('READ_ABORTED');
  });

  it('cooperatively cancels read when AbortSignal triggers during execution', async () => {
    const bundle = createFakeGuardedSourceReader({
      simulatedLatencyMs: 60,
    });

    bundle.registry.grant({
      tenantId: TEST_TENANT_A,
      sourceProfileId: 'sp_ember_releases',
    });

    const abortController = new AbortController();

    // Trigger abort at 20ms while in-flight
    setTimeout(() => {
      abortController.abort();
    }, 20);

    await expect(
      bundle.guardedReader.readSnapshot('sp_ember_releases', validContext, abortController.signal),
    ).rejects.toThrowError(/Operation was cancelled|Snapshot read was aborted/i);

    const auditRecords = bundle.auditSink.getRecords();
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.decision).toBe('DENIED');
    expect(auditRecords[0]?.denialCode).toBe('READ_ABORTED');
  });
});
