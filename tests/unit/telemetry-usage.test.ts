import { randomUUID } from 'node:crypto';
import { isDomainError } from '@ember/domain';
import { describe, expect, it } from 'vitest';
import {
  assertSimulatedCost,
  createSimulatedUsageRecord,
  SimulatedUsageRecordSchema,
} from '@ember/telemetry';

describe('telemetry usage and simulated cost accounting', () => {
  it('creates valid simulated usage record with cost_source="simulated" and actual_vendor_cost_usd=null', () => {
    const record = createSimulatedUsageRecord({
      traceId: '0123456789abcdef0123456789abcdef',
      tenantId: randomUUID(),
      taskId: randomUUID(),
      runId: randomUUID(),
      simulatedCpuMs: 45,
      simulatedUsageUnits: 2,
    });

    expect(record.cost_source).toBe('simulated');
    expect(record.actual_vendor_cost_usd).toBeNull();
    expect(record.simulated_cpu_ms).toBe(45);
    expect(record.simulated_usage_units).toBe(2);
    expect(record.tenant_hash).toMatch(/^[a-f0-9]{16}$/);

    expect(() => SimulatedUsageRecordSchema.parse(record)).not.toThrow();
  });

  it('assertSimulatedCost enforces simulation invariants', () => {
    // Valid case
    expect(() =>
      assertSimulatedCost({
        cost_source: 'simulated',
        actual_vendor_cost_usd: null,
      }),
    ).not.toThrow();

    // Invalid cost_source
    try {
      assertSimulatedCost({
        cost_source: 'real_vendor',
        actual_vendor_cost_usd: null,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('POLICY_DENIED');
      }
    }

    // Non-null actual_vendor_cost_usd
    try {
      assertSimulatedCost({
        cost_source: 'simulated',
        actual_vendor_cost_usd: 0.05,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      if (isDomainError(err)) {
        expect(err.code).toBe('POLICY_DENIED');
      }
    }
  });
});
