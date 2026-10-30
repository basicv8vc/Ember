import { randomUUID } from 'node:crypto';
import { DomainError, type Id } from '@ember/domain';
import { createTenantHash } from './privacy.js';
import { SimulatedUsageRecordSchema } from './schemas.js';
import type { SimulatedUsageRecord } from './types.js';

export interface CreateSimulatedUsageInput {
  readonly usageId?: Id;
  readonly traceId: string;
  readonly tenantId?: string;
  readonly tenantHash?: string;
  readonly taskId: Id;
  readonly runId: Id;
  readonly simulatedCpuMs: number;
  readonly simulatedUsageUnits: number;
  readonly recordedAt?: Date;
}

/**
 * Creates and validates a strictly annotated simulated usage record.
 * Guarantees that cost_source is 'simulated' and actual_vendor_cost_usd is null.
 */
export function createSimulatedUsageRecord(input: CreateSimulatedUsageInput): SimulatedUsageRecord {
  const tenantHash =
    input.tenantHash ?? (input.tenantId ? createTenantHash(input.tenantId) : undefined);

  if (!tenantHash) {
    throw new DomainError('INVALID_ARGUMENT', 'tenantId or tenantHash is required for usage');
  }

  const candidate: SimulatedUsageRecord = {
    usage_id: input.usageId ?? randomUUID(),
    trace_id: input.traceId,
    tenant_hash: tenantHash,
    task_id: input.taskId,
    run_id: input.runId,
    simulated_cpu_ms: Math.max(0, Math.floor(input.simulatedCpuMs)),
    simulated_usage_units: Math.max(0, Math.floor(input.simulatedUsageUnits)),
    cost_source: 'simulated',
    actual_vendor_cost_usd: null,
    recorded_at: (input.recordedAt ?? new Date()).toISOString(),
  };

  const parsed = SimulatedUsageRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `invalid simulated usage record contract: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

/**
 * Asserts that cost annotations conform strictly to Section 10 rules:
 * - cost_source must be 'simulated'
 * - actual_vendor_cost_usd must be null
 */
export function assertSimulatedCost(record: {
  cost_source: unknown;
  actual_vendor_cost_usd: unknown;
}): void {
  if (record.cost_source !== 'simulated' || record.actual_vendor_cost_usd !== null) {
    throw new DomainError(
      'POLICY_DENIED',
      'Telemetry must strictly specify cost_source="simulated" and actual_vendor_cost_usd=null',
    );
  }
}
