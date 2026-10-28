import { describe, expect, it } from 'vitest';
import {
  DomainError,
  InvalidArgumentError,
  type LeasedRun,
  type RunTerminalStatus,
} from '@ember/domain';
import {
  LEASE_QUEUE_DEFAULTS,
  MAX_SAFE_LEASE_EPOCH,
  LeasedRunSchema,
  nextLeaseEpoch,
  parseLeaseEpoch,
  parseLeasedRun,
  parseRunTerminalStatus,
  parseWorkerId,
  planRetry,
  resolveLeaseQueueConfig,
  retryDelayMs,
} from '@ember/postgres';

const POLICY = { baseDelayMs: 100, capDelayMs: 400 } as const;

describe('bounded retry policy', () => {
  it('uses min(cap, base × 2^(n-1)) without jitter', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(POLICY, attempt))).toEqual([
      100, 200, 400, 400, 400,
    ]);
  });

  it('rejects non-positive or imprecise attempt numbers', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => retryDelayMs(POLICY, attempt)).toThrow(InvalidArgumentError);
    }
  });

  it('schedules only while attempts and the strict deadline allow it', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');

    const first = planRetry({
      policy: POLICY,
      now,
      attempt: 1,
      maxAttempts: 3,
      deadlineAt: new Date(now.getTime() + 1_000),
    });
    expect(first).toEqual({
      retry: true,
      delayMs: 100,
      nextRunAt: new Date(now.getTime() + 100),
    });

    expect(
      planRetry({ policy: POLICY, now, attempt: 3, maxAttempts: 3, deadlineAt: null }),
    ).toEqual({ retry: false, reason: 'attempts_exhausted' });

    expect(
      planRetry({
        policy: POLICY,
        now,
        attempt: 1,
        maxAttempts: 3,
        deadlineAt: new Date(now.getTime() + 100),
      }),
    ).toEqual({ retry: false, reason: 'deadline_reached' });

    expect(
      planRetry({
        policy: POLICY,
        now,
        attempt: 2,
        maxAttempts: 3,
        deadlineAt: new Date(now.getTime() + 50),
      }),
    ).toEqual({ retry: false, reason: 'deadline_reached' });
  });

  it('never lets a retry extend beyond the deadline', () => {
    const now = new Date('2026-10-28T00:00:00.000Z');
    const plan = planRetry({
      policy: POLICY,
      now,
      attempt: 1,
      maxAttempts: 3,
      deadlineAt: new Date(now.getTime() + 101),
    });

    expect(plan.retry).toBe(true);
    if (plan.retry) {
      expect(plan.nextRunAt.getTime()).toBeLessThan(now.getTime() + 101);
    }
  });
});

describe('lease queue configuration', () => {
  it('applies the documented defaults', () => {
    expect(resolveLeaseQueueConfig()).toEqual(LEASE_QUEUE_DEFAULTS);
    expect(LEASE_QUEUE_DEFAULTS.baseDelayMs).toBe(1_000);
    expect(LEASE_QUEUE_DEFAULTS.capDelayMs).toBe(30_000);
    expect(LEASE_QUEUE_DEFAULTS.leaseDurationMs).toBe(30_000);
    expect(LEASE_QUEUE_DEFAULTS.heartbeatIntervalMs).toBe(10_000);
  });

  it('accepts bounded overrides', () => {
    const config = resolveLeaseQueueConfig({
      baseDelayMs: 100,
      capDelayMs: 400,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      reaperBatchSize: 5,
    });
    expect(config.leaseDurationMs).toBe(1_000);
    expect(config.reaperBatchSize).toBe(5);
  });

  it('rejects unsafe values, unknown keys and heartbeat/lease inversion', () => {
    expect(() => resolveLeaseQueueConfig({ heartbeatIntervalMs: 30_000 })).toThrow(
      InvalidArgumentError,
    );
    expect(() => resolveLeaseQueueConfig({ baseDelayMs: 500, capDelayMs: 100 })).toThrow(
      InvalidArgumentError,
    );
    expect(() => resolveLeaseQueueConfig({ leaseDurationMs: 0 })).toThrow(InvalidArgumentError);
    expect(() => resolveLeaseQueueConfig({ reaperBatchSize: 0 })).toThrow(InvalidArgumentError);
    expect(() => resolveLeaseQueueConfig({ unknown: true })).toThrow(InvalidArgumentError);
  });
});

describe('lease fencing values', () => {
  it('validates opaque worker ids', () => {
    expect(parseWorkerId('worker-1.local:region_a')).toBe('worker-1.local:region_a');
    for (const invalid of ['', ' worker', 'worker id', 'x'.repeat(129), 'worker\n']) {
      expect(() => parseWorkerId(invalid)).toThrow(InvalidArgumentError);
    }
  });

  it('parses only safe bigint epochs', () => {
    expect(parseLeaseEpoch('0')).toBe(0);
    expect(parseLeaseEpoch('9007199254740991')).toBe(MAX_SAFE_LEASE_EPOCH);

    const overflow = (): number => parseLeaseEpoch('9007199254740992');
    expect(overflow).toThrow(DomainError);
    try {
      overflow();
    } catch (error) {
      expect((error as DomainError).code).toBe('DB_UNAVAILABLE');
      expect((error as DomainError).diagnostic).toMatch(/safe integer/);
      expect((error as DomainError).publicMessage).toBe('Database is unavailable');
    }

    expect(() => parseLeaseEpoch('-1')).toThrow(/Database is unavailable/);
    expect(() => parseLeaseEpoch('not-a-number')).toThrow(/Database is unavailable/);
  });

  it('fails closed when allocating the epoch after the safe maximum', () => {
    expect(nextLeaseEpoch(0)).toBe(1);
    expect(nextLeaseEpoch(MAX_SAFE_LEASE_EPOCH - 1)).toBe(MAX_SAFE_LEASE_EPOCH);
    try {
      nextLeaseEpoch(MAX_SAFE_LEASE_EPOCH);
      throw new Error('expected nextLeaseEpoch to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).diagnostic).toMatch(/safe lease epoch/);
    }
  });

  it('validates LeasedRun and terminal outcome shapes', () => {
    const leased = {
      tenantId: '00000000-0000-4000-8000-000000000001',
      taskId: '00000000-0000-4000-8000-000000000002',
      runId: '00000000-0000-4000-8000-000000000003',
      attempt: 1,
      leaseEpoch: 7,
      leaseExpiresAt: '2026-10-28T00:00:00.000Z',
    };

    expect(LeasedRunSchema.safeParse(leased).success).toBe(true);
    expect(parseLeasedRun(leased)).toEqual(leased);
    expect(() => parseLeasedRun({ ...leased, leaseEpoch: -1 })).toThrow(InvalidArgumentError);
    expect(() => parseLeasedRun({ ...leased, extra: 'x' } as unknown as LeasedRun)).toThrow(
      InvalidArgumentError,
    );
    expect(parseRunTerminalStatus('failed_retryable')).toBe('failed_retryable');
    expect(() => parseRunTerminalStatus('running' as unknown as RunTerminalStatus)).toThrow(
      InvalidArgumentError,
    );
  });
});
