import { WorkerIdSchema, resolveLeaseQueueConfig, type LeaseQueueConfig } from '@ember/postgres';
import { z } from 'zod';

export class WorkerConfigError extends Error {
  override readonly name = 'WorkerConfigError';
}

export type WorkerMode = 'reaper-only' | 'poll';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EmberEnv = 'local' | 'test' | 'ci' | 'production';

/**
 * Simulated execution opt-in.
 *
 * P0B-05 has no ArtifactStore and no durable execution result, so a poll worker can only
 * produce an in-memory result. Claiming Tasks in that state must therefore be an explicit
 * local/test decision, never the default and never a production behaviour.
 */
export type SimulatedExecutionMode = 'disabled' | 'local-only';

export interface WorkerConfig {
  readonly mode: WorkerMode;
  readonly env: EmberEnv;
  readonly simulatedExecution: SimulatedExecutionMode;
  readonly workerId: string;
  readonly intervalMs: number;
  readonly errorBackoffMs: number;
  readonly concurrency: number;
  readonly logLevel: LogLevel;
  readonly lease: LeaseQueueConfig;
}

const workerEnvSchema = z.object({
  EMBER_ENV: z.enum(['local', 'test', 'ci', 'production']).default('local'),
  EMBER_WORKER_MODE: z.enum(['reaper-only', 'poll']).default('reaper-only'),
  EMBER_WORKER_SIMULATED_EXECUTION: z.enum(['disabled', 'local-only']).default('disabled'),
  EMBER_WORKER_ID: z.string().default('worker-local'),
  EMBER_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  EMBER_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
  EMBER_WORKER_ERROR_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  EMBER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  EMBER_WORKER_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  EMBER_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(100).max(299_999).default(10_000),
  EMBER_WORKER_RETRY_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  EMBER_WORKER_RETRY_CAP_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
  EMBER_WORKER_REAPER_BATCH: z.coerce.number().int().min(1).max(100).default(50),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validate worker process settings. The worker id is an operational label, not a credential.
 * Lease/retry bounds are validated by the same `LeaseQueue` configuration used in production.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = workerEnvSchema.safeParse(env);

  if (!parsed.success) {
    throw new WorkerConfigError(`Invalid worker environment: ${formatIssues(parsed.error)}`);
  }

  const workerId = WorkerIdSchema.safeParse(parsed.data.EMBER_WORKER_ID);

  if (!workerId.success) {
    throw new WorkerConfigError('EMBER_WORKER_ID must be an opaque 1-128 character identifier');
  }

  let lease: LeaseQueueConfig;

  try {
    lease = resolveLeaseQueueConfig({
      leaseDurationMs: parsed.data.EMBER_WORKER_LEASE_MS,
      heartbeatIntervalMs: parsed.data.EMBER_WORKER_HEARTBEAT_MS,
      baseDelayMs: parsed.data.EMBER_WORKER_RETRY_BASE_MS,
      capDelayMs: parsed.data.EMBER_WORKER_RETRY_CAP_MS,
      reaperBatchSize: parsed.data.EMBER_WORKER_REAPER_BATCH,
    });
  } catch (error) {
    throw new WorkerConfigError(
      `Invalid worker lease configuration: ${error instanceof Error ? error.message : 'invalid'}`,
    );
  }

  const mode = parsed.data.EMBER_WORKER_MODE;
  const simulatedExecution = parsed.data.EMBER_WORKER_SIMULATED_EXECUTION;

  // Claiming a Task without a durable execution result would report work as processed that a
  // restart cannot recover. Both guards are therefore hard failures, not warnings.
  if (mode === 'poll') {
    if (simulatedExecution !== 'local-only') {
      throw new WorkerConfigError(
        'poll mode requires EMBER_WORKER_SIMULATED_EXECUTION=local-only: P0B-05 has no durable ' +
          'execution result, so a claimed Task must not be treated as fully processed',
      );
    }

    if (parsed.data.EMBER_ENV === 'production') {
      throw new WorkerConfigError(
        'simulated execution is refused when EMBER_ENV=production; it stays a local/test ' +
          'capability until P0B-06 provides durable execution results',
      );
    }
  }

  return {
    mode,
    env: parsed.data.EMBER_ENV,
    simulatedExecution,
    workerId: workerId.data,
    intervalMs: parsed.data.EMBER_WORKER_INTERVAL_MS,
    errorBackoffMs: parsed.data.EMBER_WORKER_ERROR_BACKOFF_MS,
    concurrency: parsed.data.EMBER_WORKER_CONCURRENCY,
    logLevel: parsed.data.EMBER_LOG_LEVEL,
    lease,
  };
}
