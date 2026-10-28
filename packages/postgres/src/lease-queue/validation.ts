import { IdSchema, IsoDateTimeSchema, toInvalidArgumentError } from '@ember/contracts';
import {
  DomainError,
  RUN_TERMINAL_STATUSES,
  type LeasedRun,
  type RunTerminalStatus,
} from '@ember/domain';
import { z } from 'zod';

/** PostgreSQL `bigint` values are safe only up to JavaScript's integer precision. */
export const MAX_SAFE_LEASE_EPOCH = Number.MAX_SAFE_INTEGER;

/**
 * Internal worker identifier. It is an operational label, not an authentication
 * credential, and it is bounded/character-restricted so it cannot smuggle free text into
 * `runs.worker_id` or logs.
 */
export const WorkerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be an opaque worker identifier');

export const LeasedRunSchema = z.strictObject({
  taskId: IdSchema,
  runId: IdSchema,
  tenantId: IdSchema,
  attempt: z.number().int().positive(),
  leaseEpoch: z.number().int().nonnegative().max(MAX_SAFE_LEASE_EPOCH),
  leaseExpiresAt: IsoDateTimeSchema,
});

export const RunTerminalStatusSchema = z.enum(RUN_TERMINAL_STATUSES);

export function parseWorkerId(workerId: string): string {
  const parsed = WorkerIdSchema.safeParse(workerId);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

export function parseLeasedRun(run: LeasedRun): LeasedRun {
  const parsed = LeasedRunSchema.safeParse(run);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return Object.freeze({ ...parsed.data });
}

export function parseRunTerminalStatus(outcome: RunTerminalStatus): RunTerminalStatus {
  const parsed = RunTerminalStatusSchema.safeParse(outcome);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

/**
 * Convert a persisted `bigint` epoch to the domain's JavaScript number.
 *
 * Overflow is a hard, fixed public failure rather than a lossy conversion: silently
 * rounding an epoch could let an old lease pass fencing.
 */
export function parseLeaseEpoch(value: string | number): number {
  let asBigInt: bigint;

  try {
    asBigInt = typeof value === 'number' ? BigInt(value) : BigInt(value);
  } catch {
    throw new DomainError('DB_UNAVAILABLE', 'persisted lease epoch is not a valid integer');
  }

  if (asBigInt < 0n || asBigInt > BigInt(MAX_SAFE_LEASE_EPOCH)) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted lease epoch exceeds the safe integer range');
  }

  return Number(asBigInt);
}

/** Add one to a safe epoch, failing closed instead of producing an imprecise value. */
export function nextLeaseEpoch(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= MAX_SAFE_LEASE_EPOCH) {
    throw new DomainError('DB_UNAVAILABLE', 'cannot allocate another safe lease epoch');
  }

  return current + 1;
}

export function parsePersistedTimestamp(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted timestamp is not a valid date');
  }

  return date;
}
