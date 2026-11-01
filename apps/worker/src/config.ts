import { WorkerIdSchema, resolveLeaseQueueConfig, type LeaseQueueConfig } from '@ember/postgres';
import {
  MAX_BUDGET_POLICY_VERSION,
  SENTINEL_POLICY_VERSION,
  type BudgetPolicy,
} from '@ember/execution';
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
  /**
   * Absolute path of the controlled blob root. When set, poll mode uses the durable
   * `RunResultCommitter` (artifacts + checkpoint + atomic terminal commit); when absent it
   * can only run the in-memory P0B-05 simulation.
   */
  readonly blobRoot: string | null;
  readonly workerId: string;
  readonly intervalMs: number;
  readonly errorBackoffMs: number;
  readonly concurrency: number;
  readonly logLevel: LogLevel;
  readonly lease: LeaseQueueConfig;
  /**
   * Trusted P0B-08b budget policy (B08b-D3).
   *
   * It comes from Worker configuration, never from a Task payload or a request field: a caller
   * that could name its own limits would make every limit advisory. It is passed to the
   * durable budget ledger, which evaluates it inside the transaction that charges the Run.
   */
  readonly budget: BudgetPolicy;
  /**
   * Trusted Sentinel admission policy settings (P0-C2B).
   *
   * Configures the authoritative server-side Sentinel policy ID, version, and allowed actions.
   * Default excludes mock.write unless explicitly enabled via EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE
   * or EMBER_WORKER_SENTINEL_ALLOWED_ACTIONS.
   */
  readonly sentinel: {
    readonly policyId: string;
    readonly policyVersion: number;
    readonly allowedActions: readonly string[];
  };
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
  EMBER_WORKER_BLOB_ROOT: z.string().min(1).optional(),
  // P0B-08b budget policy. Every limit is a non-negative safe integer; `0` is a legal,
  // explicit, fail-closed value (it denies every step that would consume that dimension).
  EMBER_WORKER_BUDGET_POLICY_ID: z.string().min(1).max(128).default('p0b08b-simulated-v1'),
  EMBER_WORKER_BUDGET_POLICY_VERSION: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_BUDGET_POLICY_VERSION)
    .default(1),
  EMBER_WORKER_BUDGET_MAX_RUN_STEPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(8),
  EMBER_WORKER_BUDGET_MAX_RUN_UNITS: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(100),
  EMBER_WORKER_BUDGET_MAX_RUN_ELAPSED_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(120_000),
  EMBER_WORKER_BUDGET_MAX_TENANT_DAILY_UNITS: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(5_000),
  EMBER_WORKER_BUDGET_MAX_CONCURRENT_SLOTS: z.coerce.number().int().min(0).max(1_024).default(8),
  // P0-C2B Sentinel admission policy configuration.
  EMBER_WORKER_SENTINEL_POLICY_ID: z.string().min(1).max(128).default('sentinel-policy-default'),
  EMBER_WORKER_SENTINEL_POLICY_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(SENTINEL_POLICY_VERSION),
  EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((val) => val === 'true'),
  EMBER_WORKER_SENTINEL_ALLOWED_ACTIONS: z.string().optional(),
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
        'poll mode requires EMBER_WORKER_SIMULATED_EXECUTION=local-only: a claimed Task must ' +
          'not be treated as fully processed without an explicit simulated-execution opt-in',
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
    blobRoot: parsed.data.EMBER_WORKER_BLOB_ROOT ?? null,
    workerId: workerId.data,
    intervalMs: parsed.data.EMBER_WORKER_INTERVAL_MS,
    errorBackoffMs: parsed.data.EMBER_WORKER_ERROR_BACKOFF_MS,
    concurrency: parsed.data.EMBER_WORKER_CONCURRENCY,
    logLevel: parsed.data.EMBER_LOG_LEVEL,
    lease,
    budget: Object.freeze({
      policyId: parsed.data.EMBER_WORKER_BUDGET_POLICY_ID,
      policyVersion: parsed.data.EMBER_WORKER_BUDGET_POLICY_VERSION,
      maxRunSteps: parsed.data.EMBER_WORKER_BUDGET_MAX_RUN_STEPS,
      maxRunUnits: parsed.data.EMBER_WORKER_BUDGET_MAX_RUN_UNITS,
      maxRunElapsedMs: parsed.data.EMBER_WORKER_BUDGET_MAX_RUN_ELAPSED_MS,
      maxTenantDailyUnits: parsed.data.EMBER_WORKER_BUDGET_MAX_TENANT_DAILY_UNITS,
      maxConcurrentSlots: parsed.data.EMBER_WORKER_BUDGET_MAX_CONCURRENT_SLOTS,
    }),
    sentinel: Object.freeze({
      policyId: parsed.data.EMBER_WORKER_SENTINEL_POLICY_ID,
      policyVersion: parsed.data.EMBER_WORKER_SENTINEL_POLICY_VERSION,
      allowedActions: Object.freeze(
        parsed.data.EMBER_WORKER_SENTINEL_ALLOWED_ACTIONS !== undefined
          ? parsed.data.EMBER_WORKER_SENTINEL_ALLOWED_ACTIONS.split(',')
              .map((a) => a.trim())
              .filter((a) => a.length > 0)
          : parsed.data.EMBER_WORKER_SENTINEL_ALLOW_MOCK_WRITE
            ? ['mock.read', 'mock.compute', 'mock.write']
            : ['mock.read', 'mock.compute'],
      ),
    }),
  };
}
