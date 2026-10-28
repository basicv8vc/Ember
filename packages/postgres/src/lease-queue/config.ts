import { toInvalidArgumentError } from '@ember/contracts';
import { z } from 'zod';

/**
 * Bounded retry policy. No jitter is introduced in P0: the delay for the Nth failed
 * attempt is `min(cap, base * 2^(N-1))`. A future multi-worker deployment should add
 * bounded jitter to avoid a thundering herd when many Tasks become due together.
 */
export interface RetryPolicyConfig {
  readonly baseDelayMs: number;
  readonly capDelayMs: number;
}

export interface LeaseQueueConfig extends RetryPolicyConfig {
  /** Length of each newly issued lease. */
  readonly leaseDurationMs: number;
  /** Worker heartbeat cadence. Must be strictly shorter than the lease. */
  readonly heartbeatIntervalMs: number;
  /** Maximum number of expired Tasks/Runs one reaper transaction locks. */
  readonly reaperBatchSize: number;
}

export const LEASE_QUEUE_DEFAULTS: LeaseQueueConfig = Object.freeze({
  baseDelayMs: 1_000,
  capDelayMs: 30_000,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
  reaperBatchSize: 50,
});

const leaseQueueConfigSchema = z
  .strictObject({
    baseDelayMs: z.number().int().min(100).max(60_000).default(LEASE_QUEUE_DEFAULTS.baseDelayMs),
    capDelayMs: z.number().int().min(100).max(300_000).default(LEASE_QUEUE_DEFAULTS.capDelayMs),
    leaseDurationMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(LEASE_QUEUE_DEFAULTS.leaseDurationMs),
    heartbeatIntervalMs: z
      .number()
      .int()
      .min(100)
      .max(299_999)
      .default(LEASE_QUEUE_DEFAULTS.heartbeatIntervalMs),
    reaperBatchSize: z.number().int().min(1).max(100).default(LEASE_QUEUE_DEFAULTS.reaperBatchSize),
  })
  .superRefine((value, context) => {
    if (value.capDelayMs < value.baseDelayMs) {
      context.addIssue({
        code: 'custom',
        path: ['capDelayMs'],
        message: 'capDelayMs must be greater than or equal to baseDelayMs',
      });
    }

    if (value.heartbeatIntervalMs >= value.leaseDurationMs) {
      context.addIssue({
        code: 'custom',
        path: ['heartbeatIntervalMs'],
        message: 'heartbeatIntervalMs must be strictly shorter than leaseDurationMs',
      });
    }
  });

export type LeaseQueueConfigOverrides = Partial<LeaseQueueConfig>;

/**
 * Resolve partial options with defaults and validate every bound.
 *
 * @throws {import('@ember/domain').InvalidArgumentError} for unknown fields or unsafe values.
 */
export function resolveLeaseQueueConfig(overrides: unknown = {}): LeaseQueueConfig {
  const parsed = leaseQueueConfigSchema.safeParse(overrides);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return Object.freeze(parsed.data);
}
