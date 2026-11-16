import {
  ArtifactFilenameSchema,
  IdSchema,
  PYTHON_AGENT_LIMITS,
  PythonAgentInputSchema,
  toInvalidArgumentError,
} from '@ember/contracts';
import {
  DomainError,
  isTerminalTaskStatus,
  type DomainErrorCode,
  type Id,
  type LeasedRun,
  type PythonAgentInput,
  type RunTerminalStatus,
  type TaskStatus,
} from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import type { RetryPolicyConfig } from '../lease-queue/config.js';
import {
  applyFinishConvergence,
  planFinishConvergence,
  type RunRow,
  type TaskRow,
} from '../lease-queue/task-convergence.js';
import { parseLeaseEpoch, parsePersistedTimestamp } from '../lease-queue/validation.js';
import { lockBlobDigests } from '../storage/blob-store.js';
import { PostgresByteaBlobStore, decodePgBytea, sha256Hex } from '../storage/bytea-blob-store.js';
import type { B2ModelProviderId, B2SettlementOutcome } from './b2-interfaces.js';
import { B2_ABSOLUTE_DAY_CEILINGS } from './b2-ledger-limits.js';
import {
  applySpendCharge,
  findOutstandingHalt,
  insertBudgetIncident,
  lockBudgetHalt,
  tryReserveGlobalSpend,
  tryReserveScopeSpend,
} from './b2-spend-ledger.js';
import { appendTaskEvent } from './event-store.js';
import { asDomainError } from './support.js';

const SIMULATED_LABEL_PATTERN = /-(fake|echo)-/;

export interface PythonAgentAttemptReservation {
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly utcDay: string;
  readonly reservedMicroUsd: number;
}

export type PythonAgentReserveLlmOutcome =
  | { readonly kind: 'reserved'; readonly attempt: PythonAgentAttemptReservation }
  | {
      readonly kind: 'task_budget_exhausted';
      readonly reason: 'attempts_exhausted' | 'cost_exceeded';
    }
  | { readonly kind: 'run_budget_exhausted'; readonly reason: 'run_attempts_exhausted' }
  | { readonly kind: 'budget_exceeded'; readonly scope: 'global' | 'tenant' | 'principal' }
  | { readonly kind: 'principal_unavailable' }
  | { readonly kind: 'lease_lost' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'deadline_exceeded' }
  | {
      readonly kind: 'budget_halted';
      readonly scope: 'global' | 'tenant' | 'principal';
      readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
    };

export type PythonAgentOpKind = 'sandbox' | 'py';

export type PythonAgentReserveOpOutcome =
  | { readonly kind: 'reserved'; readonly operationId: string }
  | {
      readonly kind: 'limit_exceeded';
      readonly scope: 'run' | 'task';
      readonly opKind: PythonAgentOpKind;
    }
  | { readonly kind: 'lease_lost' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'deadline_exceeded' };

export interface PythonStepStagedOutput {
  readonly stagedId: Id;
  readonly storageKey: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly filename: string;
}

export interface PythonAgentStepCursor {
  readonly stepSequence: number;
  readonly runId: Id;
  readonly attempt: number;
  readonly toolCallId: string;
  readonly code: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly toolResultJson: string;
  readonly stagedOutputs: readonly PythonStepStagedOutput[];
}

export interface PythonAgentInputFile {
  readonly artifactId: Id;
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface PythonAgentRestoredOutput extends PythonStepStagedOutput {
  readonly bytes: Uint8Array;
}

export interface PythonAgentLoadedContext {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly agentId: Id;
  readonly policyVersion: number;
  readonly deadlineAt: string | null;
  readonly input: PythonAgentInput;
  readonly inputFiles: readonly PythonAgentInputFile[];
  readonly checkpoints: readonly PythonAgentStepCursor[];
  readonly latestStagedOutputs: readonly PythonAgentRestoredOutput[];
  readonly usage: {
    readonly taskLlmCallsUsed: number;
    readonly taskCostMicroUsd: number;
    readonly runLlmCallsUsed: number;
    readonly taskSandboxCreatesUsed: number;
    readonly runSandboxCreatesUsed: number;
    readonly taskPythonExecsUsed: number;
    readonly runPythonExecsUsed: number;
  };
}

export type PythonAgentLoadContextResult =
  | { readonly kind: 'ready'; readonly context: PythonAgentLoadedContext }
  | { readonly kind: 'lease_lost' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'deadline_exceeded' };

export interface PythonAgentReserveLlmCommand {
  readonly lease: LeasedRun;
  readonly ceilings: {
    readonly perAttemptMicroUsd: number;
    readonly principalDailyMicroUsd: number;
    readonly tenantDailyMicroUsd: number;
    readonly globalDailyMicroUsd: number;
  };
  readonly maxAttemptsPerTask: number;
  readonly maxAttemptsPerRun: number;
  readonly maxTaskCostMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly rateVersion: string;
  readonly providerId: B2ModelProviderId;
  readonly modelLabel: string;
}

export interface PythonAgentLlmCharge {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly attemptNo: number;
  readonly outcomeCode: string;
  readonly state: 'settled' | 'unknown_billed' | 'released' | 'conservative_billed';
  readonly observedCostMicroUsd?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
}

export interface PythonAgentCommitStepCommand {
  readonly lease: LeasedRun;
  readonly stepSequence: number;
  readonly toolCallId: string;
  readonly code: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly toolResultJson: string;
  readonly stagedOutputs: readonly PythonStepStagedOutput[];
}

export interface PythonAgentCommitCompletionCommand {
  readonly lease: LeasedRun;
  readonly policy: RetryPolicyConfig;
  readonly durationMs: number;
  readonly summaryText: string;
  readonly detailText: string | null;
  readonly truncated: boolean;
  readonly modelLabel: string;
  readonly simulated: boolean;
  readonly finalStagedOutputs: readonly PythonStepStagedOutput[];
}

export type PythonAgentCommitResult =
  | {
      readonly outcome: 'committed';
      readonly taskStatus: TaskStatus;
      readonly runStatus: RunTerminalStatus;
      readonly publishedArtifactIds: readonly Id[];
    }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'deadline_exceeded' };

export interface PythonAgentCommitFailureCommand {
  readonly lease: LeasedRun;
  readonly policy: RetryPolicyConfig;
  readonly outcome: 'failed_retryable' | 'failed_terminal' | 'cancelled';
  readonly errorCode?: DomainErrorCode;
  readonly durationMs?: number;
  readonly simulated?: boolean;
}

export type PythonAgentFailureResult =
  | {
      readonly outcome: 'committed';
      readonly taskStatus: TaskStatus;
      readonly runStatus: RunTerminalStatus;
      readonly nextRunAt?: Date;
    }
  | { readonly outcome: 'stale_lease' };

class Refusal extends Error {
  override readonly name = 'Refusal';
  readonly outcome: PythonAgentReserveLlmOutcome;

  constructor(outcome: PythonAgentReserveLlmOutcome) {
    super(outcome.kind);
    this.outcome = outcome;
  }
}

async function runTx<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw asDomainError(error);
  }

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Refusal) {
      throw error;
    }
    throw asDomainError(error);
  } finally {
    client.release();
  }
}

const leasedRunSchema = z.strictObject({
  tenantId: IdSchema,
  taskId: IdSchema,
  runId: IdSchema,
  attempt: z.number().int().min(1),
  leaseEpoch: z.number().int().nonnegative(),
  leaseExpiresAt: z.string().min(1),
});

const stagedOutputSchema = z.strictObject({
  stagedId: IdSchema,
  storageKey: z.string().regex(/^staging\/[0-9a-f-]{36}\/[0-9a-f]{64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(0).max(PYTHON_AGENT_LIMITS.maxFileBytes),
  mediaType: z.string().min(1).max(128),
  filename: ArtifactFilenameSchema,
});

const stepCursorSchema = z.strictObject({
  stepSequence: z.number().int().min(1).max(50),
  runId: IdSchema,
  attempt: z.number().int().min(1),
  toolCallId: z.string().min(1).max(128),
  code: z.string().min(1).max(PYTHON_AGENT_LIMITS.maxPythonCodeChars),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stdoutPreview: z.string().max(PYTHON_AGENT_LIMITS.maxStepOutputPreviewChars),
  stderrPreview: z.string().max(PYTHON_AGENT_LIMITS.maxStepOutputPreviewChars),
  toolResultJson: z.string().min(2).max(16_384),
  stagedOutputs: z.array(stagedOutputSchema).max(PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask),
});

const reserveLlmSchema = z.strictObject({
  lease: leasedRunSchema,
  maxAttemptsPerTask: z.number().int().min(1).max(PYTHON_AGENT_LIMITS.maxLlmCallsPerTask),
  maxAttemptsPerRun: z.number().int().min(1).max(PYTHON_AGENT_LIMITS.maxLlmCallsPerRun),
  maxTaskCostMicroUsd: z.number().int().min(1).max(PYTHON_AGENT_LIMITS.maxTaskCostMicroUsd),
  ceilings: z.strictObject({
    perAttemptMicroUsd: z.number().int().min(1).max(5_000),
    principalDailyMicroUsd: z.number().int().min(0).max(B2_ABSOLUTE_DAY_CEILINGS.principalMicroUsd),
    tenantDailyMicroUsd: z.number().int().min(0).max(B2_ABSOLUTE_DAY_CEILINGS.tenantMicroUsd),
    globalDailyMicroUsd: z.number().int().min(0).max(B2_ABSOLUTE_DAY_CEILINGS.globalMicroUsd),
  }),
  reservedMicroUsd: z.number().int().min(1).max(5_000),
  rateVersion: z.string().min(1).max(128),
  providerId: z.enum(['openai', 'openrouter']),
  modelLabel: z.string().min(1).max(120),
});

const markSentSchema = z.strictObject({
  lease: leasedRunSchema,
  attemptNo: z.number().int().min(1).max(PYTHON_AGENT_LIMITS.maxLlmCallsPerTask),
});

const settleLlmSchema = z
  .strictObject({
    tenantId: IdSchema,
    taskId: IdSchema,
    attemptNo: z.number().int().min(1).max(PYTHON_AGENT_LIMITS.maxLlmCallsPerTask),
    outcomeCode: z.enum([
      'ok',
      'model_timeout',
      'model_unavailable',
      'model_rate_limited',
      'model_auth_failed',
      'model_invalid_output',
      'client_cancelled',
      'not_sent',
      'usage_missing',
    ]),
    state: z.enum(['settled', 'unknown_billed', 'released', 'conservative_billed']),
    observedCostMicroUsd: z.number().int().min(0).nullable().optional(),
    inputTokens: z.number().int().min(0).nullable().optional(),
    outputTokens: z.number().int().min(0).nullable().optional(),
  })
  .refine(
    (value) =>
      value.state !== 'settled' ||
      (value.observedCostMicroUsd !== null && value.observedCostMicroUsd !== undefined),
    { message: 'settled requires an observed cost', path: ['observedCostMicroUsd'] },
  )
  .refine(
    (value) =>
      value.state !== 'conservative_billed' ||
      value.observedCostMicroUsd === null ||
      value.observedCostMicroUsd === undefined,
    { message: 'conservative billing must not carry an observed cost', path: ['state'] },
  );

const reserveOpSchema = z.strictObject({
  lease: leasedRunSchema,
  opKind: z.enum(['sandbox', 'py']),
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  maxDurationMs: z.number().int().min(1).max(300_000),
});

const settleOpSchema = z.strictObject({
  tenantId: IdSchema,
  runId: IdSchema,
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  elapsedMs: z.number().int().nonnegative(),
  state: z.enum(['settled', 'released']),
});

const commitStepSchema = z.strictObject({
  lease: leasedRunSchema,
  stepSequence: z.number().int().min(1).max(50),
  toolCallId: z.string().min(1).max(128),
  code: z.string().min(1).max(PYTHON_AGENT_LIMITS.maxPythonCodeChars),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stdoutPreview: z.string().max(PYTHON_AGENT_LIMITS.maxStepOutputPreviewChars),
  stderrPreview: z.string().max(PYTHON_AGENT_LIMITS.maxStepOutputPreviewChars),
  toolResultJson: z.string().min(2).max(16_384),
  stagedOutputs: z.array(stagedOutputSchema).max(PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask),
});

const commitCompletionSchema = z
  .strictObject({
    lease: leasedRunSchema,
    durationMs: z.number().int().nonnegative(),
    summaryText: z.string().min(1).max(2_048),
    detailText: z.string().min(1).max(16_384).nullable(),
    truncated: z.boolean(),
    modelLabel: z.string().min(1).max(128),
    simulated: z.boolean(),
    finalStagedOutputs: z
      .array(stagedOutputSchema)
      .max(PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask),
  })
  .refine((value) => value.simulated === SIMULATED_LABEL_PATTERN.test(value.modelLabel), {
    message: 'simulated must match the model label',
    path: ['simulated'],
  });

const LOCK_TASK_SQL = `
SELECT id, tenant_id, agent_id, kind, status, input, attempt_count, max_attempts,
       lease_epoch::text AS lease_epoch, current_run_id, next_run_at, lease_expires_at,
       deadline_at, cancel_requested_at
  FROM tasks
 WHERE tenant_id = $1 AND id = $2
 FOR UPDATE
`;

const LOCK_RUN_SQL = `
SELECT id, tenant_id, task_id, attempt, lease_epoch::text AS lease_epoch, status, worker_id,
       leased_until, started_at, finished_at
  FROM runs
 WHERE tenant_id = $1 AND task_id = $2 AND id = $3
 FOR UPDATE
`;

interface ExtendedTaskRow extends TaskRow {
  readonly agent_id: string;
  readonly input: unknown;
}

async function lockTaskAndRun(
  client: pg.PoolClient,
  lease: LeasedRun,
): Promise<{
  readonly task: ExtendedTaskRow | null;
  readonly run: RunRow | null;
  readonly now: Date;
  readonly utcDay: string;
  readonly leaseLive: boolean;
}> {
  const taskResult = await client.query<ExtendedTaskRow>(LOCK_TASK_SQL, [
    lease.tenantId,
    lease.taskId,
  ]);
  const task = taskResult.rows[0] ?? null;

  if (task === null) {
    const clock = await client.query<{ readonly now: Date; readonly utc_day: string }>(
      `SELECT clock_timestamp() AS now, (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS utc_day`,
    );
    return {
      task: null,
      run: null,
      now: clock.rows[0]!.now,
      utcDay: clock.rows[0]!.utc_day,
      leaseLive: false,
    };
  }

  const runResult = await client.query<RunRow>(LOCK_RUN_SQL, [
    lease.tenantId,
    lease.taskId,
    lease.runId,
  ]);
  const run = runResult.rows[0] ?? null;
  const clock = await client.query<{ readonly now: Date; readonly utc_day: string }>(
    `SELECT clock_timestamp() AS now, (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS utc_day`,
  );
  const { now, utc_day: utcDay } = clock.rows[0]!;

  if (run === null) {
    return { task, run: null, now, utcDay, leaseLive: false };
  }

  const runLeasedUntil = parsePersistedTimestamp(run.leased_until);
  const taskEpoch = parseLeaseEpoch(task.lease_epoch);
  const runEpoch = parseLeaseEpoch(run.lease_epoch);

  const leaseLive =
    task.status === 'running' &&
    run.status === 'running' &&
    task.current_run_id === run.id &&
    taskEpoch === lease.leaseEpoch &&
    runEpoch === lease.leaseEpoch &&
    run.attempt === lease.attempt &&
    runLeasedUntil !== null &&
    runLeasedUntil.getTime() > now.getTime();

  return { task, run, now, utcDay, leaseLive };
}

/** Resolve the server-owned principal mapped to `tenantId` (`consumers` 1:1 invariant). */
async function resolveTenantPrincipalId(
  client: pg.PoolClient,
  tenantId: string,
): Promise<string | null> {
  const principal = await client.query<{ readonly principal_id: string }>(
    'SELECT principal_id FROM consumers WHERE tenant_id = $1',
    [tenantId],
  );
  return principal.rows[0]?.principal_id ?? null;
}

/**
 * Edge-safe durable execution persistence for `python.agent` Tasks.
 *
 * Keeps zero `node:*` imports so Cloudflare Workers (`apps/cloud-async-runtime`) and Node
 * workers share identical budget accounting, `budget_operations` (`sandbox:` / `py:`),
 * `step_checkpoints`, and fenced Run/Task terminal convergence.
 */
export class PostgresPythonAgentExecutionRepository {
  private readonly byteaStore: PostgresByteaBlobStore;

  constructor(private readonly pool: pg.Pool) {
    this.byteaStore = new PostgresByteaBlobStore(pool);
  }

  async loadAgentContext(lease: LeasedRun): Promise<PythonAgentLoadContextResult> {
    const parsedLease = leasedRunSchema.safeParse(lease);
    if (!parsedLease.success) {
      throw toInvalidArgumentError(parsedLease.error);
    }

    return runTx(this.pool, async (client) => {
      const { task, now, leaseLive } = await lockTaskAndRun(client, parsedLease.data);

      if (!leaseLive || task === null) {
        return { kind: 'lease_lost' as const };
      }
      if (task.cancel_requested_at !== null) {
        return { kind: 'cancelled' as const };
      }
      const deadlineAt = parsePersistedTimestamp(task.deadline_at);
      if (deadlineAt !== null && deadlineAt.getTime() <= now.getTime()) {
        return { kind: 'deadline_exceeded' as const };
      }
      if (task.kind !== 'python.agent') {
        throw new DomainError('INVALID_ARGUMENT', 'task kind is not python.agent');
      }

      const inputParsed = PythonAgentInputSchema.safeParse(task.input);
      if (!inputParsed.success) {
        throw new DomainError('INVALID_ARGUMENT', 'persisted python.agent input is malformed');
      }
      const input = inputParsed.data;

      const agentMeta = await client.query<{ readonly policy_version: number }>(
        `SELECT policy_version FROM agents WHERE tenant_id = $1 AND id = $2`,
        [task.tenant_id, task.agent_id],
      );
      const policyVersion = Number(agentMeta.rows[0]?.policy_version ?? 0);

      const artifactRows = await client.query<{
        readonly id: string;
        readonly filename: string | null;
        readonly media_type: string;
        readonly sha256: string;
        readonly size: string | number;
        readonly bytes: unknown;
      }>(
        `SELECT a.id, a.filename, a.media_type, a.sha256, a.size, bb.bytes
           FROM artifacts a
           JOIN blobs b ON b.tenant_id = a.tenant_id AND b.sha256 = a.sha256
           JOIN bytea_blobs bb ON bb.tenant_id = b.tenant_id AND bb.storage_key = b.storage_key
          WHERE a.tenant_id = $1
            AND a.task_id = $2
            AND a.created_by = 'user'
          ORDER BY a.created_at ASC, a.id ASC`,
        [task.tenant_id, task.id],
      );

      const fileById = new Map<string, PythonAgentInputFile>();
      for (const row of artifactRows.rows) {
        const bytes = decodePgBytea(row.bytes);
        const expectedSize = Number(row.size);
        if (bytes.byteLength !== expectedSize || (await sha256Hex(bytes)) !== row.sha256) {
          throw new DomainError('DB_UNAVAILABLE', 'persisted input artifact failed verification');
        }
        const safeFilename = row.filename ?? `${row.id}.txt`;
        fileById.set(
          row.id,
          Object.freeze({
            artifactId: row.id,
            filename: safeFilename,
            mediaType: row.media_type,
            sha256: row.sha256,
            size: expectedSize,
            bytes,
          }),
        );
      }

      const orderedInputFiles: PythonAgentInputFile[] = [];
      if (input.inputArtifactIds !== undefined && input.inputArtifactIds.length > 0) {
        for (const id of input.inputArtifactIds) {
          const found = fileById.get(id);
          if (found !== undefined) {
            orderedInputFiles.push(found);
          }
        }
      } else {
        orderedInputFiles.push(...fileById.values());
      }

      const checkpointRows = await client.query<{ readonly cursor: unknown }>(
        `SELECT cursor
           FROM step_checkpoints
          WHERE tenant_id = $1 AND task_id = $2
          ORDER BY step_sequence ASC`,
        [task.tenant_id, task.id],
      );

      const checkpoints: PythonAgentStepCursor[] = [];
      const latestOutputByName = new Map<string, PythonStepStagedOutput>();
      for (const row of checkpointRows.rows) {
        const parsedCursor = stepCursorSchema.safeParse(row.cursor);
        if (!parsedCursor.success) {
          throw new DomainError('DB_UNAVAILABLE', 'persisted python step checkpoint is malformed');
        }
        checkpoints.push(parsedCursor.data);
        for (const staged of parsedCursor.data.stagedOutputs) {
          latestOutputByName.set(staged.filename, staged);
        }
      }

      const latestStagedOutputs: PythonAgentRestoredOutput[] = [];
      const selectedOutputs = [...latestOutputByName.values()].slice(
        0,
        PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask,
      );
      if (selectedOutputs.length > 0) {
        const storageKeys = selectedOutputs.map((entry) => entry.storageKey);
        const stagedRows = await client.query<{
          readonly storage_key: string;
          readonly bytes: unknown;
        }>(
          `SELECT storage_key, bytes
             FROM bytea_staged_blobs
            WHERE tenant_id = $1::uuid AND storage_key = ANY($2::text[])`,
          [task.tenant_id, storageKeys],
        );
        const bytesByKey = new Map<string, Uint8Array>();
        for (const row of stagedRows.rows) {
          bytesByKey.set(row.storage_key, decodePgBytea(row.bytes));
        }
        for (const meta of selectedOutputs) {
          const bytes = bytesByKey.get(meta.storageKey);
          if (
            bytes !== undefined &&
            bytes.byteLength === meta.size &&
            (await sha256Hex(bytes)) === meta.sha256
          ) {
            latestStagedOutputs.push(Object.freeze({ ...meta, bytes }));
          }
        }
      }

      const llmUsage = await client.query<{
        readonly max_attempt: number;
        readonly run_attempts: number;
        readonly cumulative_micro_usd: string | number;
      }>(
        `SELECT COALESCE(MAX(attempt_no), 0)::int AS max_attempt,
                COUNT(*) FILTER (WHERE run_id = $3)::int AS run_attempts,
                COALESCE(
                  SUM(
                    CASE WHEN state = 'released' THEN 0
                         ELSE COALESCE(observed_cost_micro_usd, applied_cost_micro_usd, reserved_micro_usd)
                    END
                  ),
                  0
                )::bigint AS cumulative_micro_usd
           FROM task_model_attempts
          WHERE tenant_id = $1 AND task_id = $2`,
        [task.tenant_id, task.id, parsedLease.data.runId],
      );

      const opsUsage = await client.query<{
        readonly task_sandboxes: number;
        readonly run_sandboxes: number;
        readonly task_pys: number;
        readonly run_pys: number;
      }>(
        `SELECT COUNT(*) FILTER (WHERE operation_id LIKE 'sandbox:%' AND state IN ('reserved', 'settled', 'expired'))::int AS task_sandboxes,
                COUNT(*) FILTER (WHERE run_id = $3 AND operation_id LIKE 'sandbox:%' AND state IN ('reserved', 'settled', 'expired'))::int AS run_sandboxes,
                COUNT(*) FILTER (WHERE operation_id LIKE 'py:%' AND state IN ('reserved', 'settled', 'expired'))::int AS task_pys,
                COUNT(*) FILTER (WHERE run_id = $3 AND operation_id LIKE 'py:%' AND state IN ('reserved', 'settled', 'expired'))::int AS run_pys
           FROM budget_operations
          WHERE tenant_id = $1 AND task_id = $2`,
        [task.tenant_id, task.id, parsedLease.data.runId],
      );

      const llmRow = llmUsage.rows[0]!;
      const opsRow = opsUsage.rows[0]!;

      return {
        kind: 'ready' as const,
        context: Object.freeze({
          tenantId: task.tenant_id,
          taskId: task.id,
          runId: parsedLease.data.runId,
          attempt: parsedLease.data.attempt,
          leaseEpoch: parsedLease.data.leaseEpoch,
          agentId: task.agent_id,
          policyVersion,
          deadlineAt: deadlineAt === null ? null : deadlineAt.toISOString(),
          input,
          inputFiles: Object.freeze(orderedInputFiles),
          checkpoints: Object.freeze(checkpoints),
          latestStagedOutputs: Object.freeze(latestStagedOutputs),
          usage: Object.freeze({
            taskLlmCallsUsed: Number(llmRow.max_attempt),
            taskCostMicroUsd: Number(llmRow.cumulative_micro_usd),
            runLlmCallsUsed: Number(llmRow.run_attempts),
            taskSandboxCreatesUsed: Number(opsRow.task_sandboxes),
            runSandboxCreatesUsed: Number(opsRow.run_sandboxes),
            taskPythonExecsUsed: Number(opsRow.task_pys),
            runPythonExecsUsed: Number(opsRow.run_pys),
          }),
        }),
      };
    });
  }

  async reserveLlmAttempt(
    command: PythonAgentReserveLlmCommand,
  ): Promise<PythonAgentReserveLlmOutcome> {
    const parsed = reserveLlmSchema.safeParse(command);
    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const input = parsed.data;
    const principalCeiling = Math.min(
      input.ceilings.principalDailyMicroUsd,
      B2_ABSOLUTE_DAY_CEILINGS.principalMicroUsd,
    );
    const tenantCeiling = Math.min(
      input.ceilings.tenantDailyMicroUsd,
      B2_ABSOLUTE_DAY_CEILINGS.tenantMicroUsd,
    );
    const globalCeiling = Math.min(
      input.ceilings.globalDailyMicroUsd,
      B2_ABSOLUTE_DAY_CEILINGS.globalMicroUsd,
    );

    try {
      return await runTx(this.pool, async (client) => {
        await lockBudgetHalt(client);

        const principalId = await resolveTenantPrincipalId(client, input.lease.tenantId);
        if (principalId === null) {
          return { kind: 'principal_unavailable' as const };
        }

        const halt = await findOutstandingHalt(client, input.lease.tenantId, principalId);

        if (halt !== null) {
          return {
            kind: 'budget_halted' as const,
            scope: halt.scope,
            reason: halt.reason,
          };
        }

        const { task, now, utcDay, leaseLive } = await lockTaskAndRun(client, input.lease);

        if (!leaseLive || task === null) {
          return { kind: 'lease_lost' as const };
        }
        if (task.cancel_requested_at !== null) {
          return { kind: 'cancelled' as const };
        }
        const deadlineAt = parsePersistedTimestamp(task.deadline_at);
        if (deadlineAt !== null && deadlineAt.getTime() <= now.getTime()) {
          return { kind: 'deadline_exceeded' as const };
        }

        const prior = await client.query<{
          readonly max_attempt: number;
          readonly run_attempts: number;
          readonly cumulative_micro_usd: string | number;
        }>(
          `SELECT COALESCE(MAX(attempt_no), 0)::int AS max_attempt,
                  COUNT(*) FILTER (WHERE run_id = $3)::int AS run_attempts,
                  COALESCE(
                    SUM(
                      CASE WHEN state = 'released' THEN 0
                           ELSE COALESCE(observed_cost_micro_usd, applied_cost_micro_usd, reserved_micro_usd)
                      END
                    ),
                    0
                  )::bigint AS cumulative_micro_usd
             FROM task_model_attempts
            WHERE tenant_id = $1 AND task_id = $2`,
          [input.lease.tenantId, input.lease.taskId, input.lease.runId],
        );
        const maxAttempt = Number(prior.rows[0]?.max_attempt ?? 0);
        const runAttempts = Number(prior.rows[0]?.run_attempts ?? 0);
        const cumulativeMicroUsd = Number(prior.rows[0]?.cumulative_micro_usd ?? 0);

        if (runAttempts >= input.maxAttemptsPerRun) {
          return {
            kind: 'run_budget_exhausted' as const,
            reason: 'run_attempts_exhausted' as const,
          };
        }
        if (maxAttempt >= input.maxAttemptsPerTask) {
          return { kind: 'task_budget_exhausted' as const, reason: 'attempts_exhausted' as const };
        }
        if (cumulativeMicroUsd + input.reservedMicroUsd > input.maxTaskCostMicroUsd) {
          return { kind: 'task_budget_exhausted' as const, reason: 'cost_exceeded' as const };
        }

        // Strict 3-scope lock order matching B2 Turns and B3 Notes: global -> tenant -> principal.
        if (!(await tryReserveGlobalSpend(client, utcDay, input.reservedMicroUsd, globalCeiling))) {
          throw new Refusal({ kind: 'budget_exceeded', scope: 'global' });
        }

        if (
          !(await tryReserveScopeSpend(
            client,
            input.lease.tenantId,
            'tenant',
            input.lease.tenantId,
            utcDay,
            input.reservedMicroUsd,
            tenantCeiling,
            0,
            60,
          ))
        ) {
          throw new Refusal({ kind: 'budget_exceeded', scope: 'tenant' });
        }

        if (
          !(await tryReserveScopeSpend(
            client,
            input.lease.tenantId,
            'principal',
            principalId,
            utcDay,
            input.reservedMicroUsd,
            principalCeiling,
            0,
            60,
          ))
        ) {
          throw new Refusal({ kind: 'budget_exceeded', scope: 'principal' });
        }

        const attemptNo = maxAttempt + 1;
        const operationId = globalThis.crypto.randomUUID();

        await client.query(
          `INSERT INTO task_model_attempts (
             tenant_id, task_id, run_id, lease_epoch, attempt_no, operation_id,
             principal_id, utc_day, provider_id, model_label, rate_version, state, reserved_micro_usd
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, 'reserved', $12)`,
          [
            input.lease.tenantId,
            input.lease.taskId,
            input.lease.runId,
            input.lease.leaseEpoch,
            attemptNo,
            operationId,
            principalId,
            utcDay,
            input.providerId,
            input.modelLabel,
            input.rateVersion,
            input.reservedMicroUsd,
          ],
        );

        return {
          kind: 'reserved' as const,
          attempt: {
            attemptNo,
            operationId,
            utcDay,
            reservedMicroUsd: input.reservedMicroUsd,
          },
        };
      });
    } catch (error) {
      if (error instanceof Refusal) {
        return error.outcome;
      }
      throw error;
    }
  }

  async markLlmAttemptSent(command: {
    readonly lease: LeasedRun;
    readonly attemptNo: number;
  }): Promise<boolean> {
    const parsed = markSentSchema.safeParse(command);
    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { lease, attemptNo } = parsed.data;
    return runTx(this.pool, async (client) => {
      const { task, now, leaseLive } = await lockTaskAndRun(client, lease);
      if (!leaseLive || task === null || task.cancel_requested_at !== null) {
        return false;
      }
      const deadlineAt = parsePersistedTimestamp(task.deadline_at);
      if (deadlineAt !== null && deadlineAt.getTime() <= now.getTime()) {
        return false;
      }

      const updated = await client.query(
        `UPDATE task_model_attempts
            SET send_started_at = clock_timestamp()
          WHERE tenant_id = $1
            AND task_id = $2
            AND run_id = $3
            AND lease_epoch = $4
            AND attempt_no = $5
            AND state = 'reserved'
            AND send_started_at IS NULL`,
        [lease.tenantId, lease.taskId, lease.runId, lease.leaseEpoch, attemptNo],
      );
      return (updated.rowCount ?? 0) === 1;
    });
  }

  async settleLlmAttempt(charge: PythonAgentLlmCharge): Promise<B2SettlementOutcome> {
    const parsed = settleLlmSchema.safeParse(charge);
    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const input = parsed.data;

    return runTx(this.pool, async (client) => {
      await lockBudgetHalt(client);

      const attempt = await client.query<{
        readonly state: string;
        readonly reserved_micro_usd: string | number;
        readonly utc_day: string;
        readonly principal_id: string;
      }>(
        `SELECT state, reserved_micro_usd, utc_day::text AS utc_day, principal_id
           FROM task_model_attempts
          WHERE tenant_id = $1 AND task_id = $2 AND attempt_no = $3
          FOR UPDATE`,
        [input.tenantId, input.taskId, input.attemptNo],
      );
      const row = attempt.rows[0];

      if (row === undefined) {
        return { kind: 'not_found' as const };
      }
      if (row.state !== 'reserved') {
        return { kind: 'already_settled' as const, state: row.state };
      }

      const reserved = Number(row.reserved_micro_usd);
      const observed = input.observedCostMicroUsd ?? null;

      let applied: number | null = null;
      let chargeMicroUsd = 0;
      let releaseMicroUsd = 0;
      let billingBasis: string | null = null;

      if (input.state === 'settled') {
        applied = Math.min(observed ?? 0, reserved);
        chargeMicroUsd = observed ?? 0;
        releaseMicroUsd = reserved;
        billingBasis = 'provider_usage';
      } else if (input.state === 'conservative_billed') {
        applied = reserved;
        chargeMicroUsd = reserved;
        releaseMicroUsd = reserved;
        billingBasis = 'conservative_reservation';
      } else if (input.state === 'released') {
        applied = 0;
        billingBasis = 'not_billed';
        releaseMicroUsd = reserved;
      }

      let incidentsOpened = 0;
      let bucketOverage = 0;

      if (releaseMicroUsd > 0 || chargeMicroUsd > 0) {
        const charged = await applySpendCharge(client, {
          utcDay: row.utc_day,
          tenantId: input.tenantId,
          principalId: row.principal_id,
          releaseMicroUsd,
          chargeMicroUsd,
        });

        for (const bucket of charged) {
          if (bucket.overageMicroUsd > 0) {
            await insertBudgetIncident(client, {
              tenantId: input.tenantId,
              scope: bucket.scope,
              scopeId: bucket.scopeId,
              utcDay: row.utc_day,
              reason: 'day_ceiling_exceeded',
              taskId: input.taskId,
              attemptNo: input.attemptNo,
              observedMicroUsd: chargeMicroUsd,
              appliedMicroUsd: bucket.appliedMicroUsd,
              overageMicroUsd: bucket.overageMicroUsd,
              reservationMicroUsd: reserved,
            });
            incidentsOpened += 1;
            bucketOverage += bucket.overageMicroUsd;
          }
        }
      }

      if (incidentsOpened === 0 && observed !== null && observed > reserved) {
        await insertBudgetIncident(client, {
          tenantId: input.tenantId,
          scope: 'tenant',
          scopeId: input.tenantId,
          utcDay: row.utc_day,
          reason: 'reservation_exceeded',
          taskId: input.taskId,
          attemptNo: input.attemptNo,
          observedMicroUsd: observed,
          appliedMicroUsd: observed,
          overageMicroUsd: 0,
          reservationMicroUsd: reserved,
        });
        incidentsOpened = 1;
      }

      if (input.state === 'conservative_billed') {
        await insertBudgetIncident(client, {
          tenantId: input.tenantId,
          scope: 'tenant',
          scopeId: input.tenantId,
          utcDay: row.utc_day,
          reason: 'usage_missing',
          taskId: input.taskId,
          attemptNo: input.attemptNo,
          observedMicroUsd: reserved,
          appliedMicroUsd: reserved,
          overageMicroUsd: 0,
          reservationMicroUsd: reserved,
        });
        incidentsOpened += 1;
      }

      const attemptOverage = applied === null ? 0 : Math.max(0, (observed ?? 0) - applied);

      await client.query(
        `UPDATE task_model_attempts
            SET state = $4,
                outcome_code = $5,
                applied_cost_micro_usd = $6,
                observed_cost_micro_usd = $7,
                input_tokens = $8,
                output_tokens = $9,
                billing_basis = $10,
                overage_micro_usd = $11,
                settled_at = clock_timestamp()
          WHERE tenant_id = $1 AND task_id = $2 AND attempt_no = $3 AND state = 'reserved'`,
        [
          input.tenantId,
          input.taskId,
          input.attemptNo,
          input.state,
          input.outcomeCode,
          applied,
          observed,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          billingBasis,
          attemptOverage,
        ],
      );

      return {
        kind: 'applied' as const,
        state: input.state,
        appliedMicroUsd: applied,
        overageMicroUsd: bucketOverage,
        incidentsOpened,
      };
    });
  }

  /**
   * Reserve a `budget_operations` slot for `'sandbox:'` creation or `'py:'` script execution
   * following the 0006 lock order: advisory tenant lock -> tasks -> runs -> budget_operations.
   */
  async reserveAgentOperation(command: {
    readonly lease: LeasedRun;
    readonly opKind: PythonAgentOpKind;
    readonly operationId: string;
    readonly maxDurationMs: number;
  }): Promise<PythonAgentReserveOpOutcome> {
    const parsed = reserveOpSchema.safeParse(command);
    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const input = parsed.data;
    const expectedPrefix = `${input.opKind}:`;
    if (!input.operationId.startsWith(expectedPrefix)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `operationId for ${input.opKind} must start with ${expectedPrefix}`,
      );
    }

    return runTx(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `ember.budget:${input.lease.tenantId}`,
      ]);

      const { task, now, utcDay, leaseLive } = await lockTaskAndRun(client, input.lease);
      if (!leaseLive || task === null) {
        return { kind: 'lease_lost' as const };
      }
      if (task.cancel_requested_at !== null) {
        return { kind: 'cancelled' as const };
      }
      const deadlineAt = parsePersistedTimestamp(task.deadline_at);
      if (deadlineAt !== null && deadlineAt.getTime() <= now.getTime()) {
        return { kind: 'deadline_exceeded' as const };
      }

      // Sweep stale reservations whose lease already expired.
      await client.query(
        `UPDATE budget_operations
            SET state = 'expired',
                consumed_steps = reserved_steps,
                consumed_units = reserved_units,
                consumed_elapsed_ms = reserved_elapsed_ms,
                consumed_slots = reserved_slots,
                settled_at = $2
          WHERE tenant_id = $1 AND state = 'reserved' AND expires_at <= $2`,
        [input.lease.tenantId, now],
      );

      // Idempotent lookup for same (tenant, run, operationId).
      const existing = await client.query<{ readonly operation_id: string }>(
        `SELECT operation_id
           FROM budget_operations
          WHERE tenant_id = $1 AND run_id = $2 AND operation_id = $3`,
        [input.lease.tenantId, input.lease.runId, input.operationId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        return { kind: 'reserved' as const, operationId: input.operationId };
      }

      const counts = await client.query<{
        readonly run_count: number;
        readonly task_count: number;
      }>(
        `SELECT COUNT(*) FILTER (WHERE run_id = $3)::int AS run_count,
                COUNT(*)::int AS task_count
           FROM budget_operations
          WHERE tenant_id = $1
            AND task_id = $2
            AND operation_id LIKE $4
            AND state IN ('reserved', 'settled', 'expired')`,
        [input.lease.tenantId, input.lease.taskId, input.lease.runId, `${expectedPrefix}%`],
      );
      const runCount = Number(counts.rows[0]?.run_count ?? 0);
      const taskCount = Number(counts.rows[0]?.task_count ?? 0);

      const maxPerRun =
        input.opKind === 'sandbox'
          ? PYTHON_AGENT_LIMITS.maxSandboxesPerRun
          : PYTHON_AGENT_LIMITS.maxPythonExecsPerRun;
      const maxPerTask =
        input.opKind === 'sandbox'
          ? PYTHON_AGENT_LIMITS.maxSandboxesPerTask
          : PYTHON_AGENT_LIMITS.maxPythonExecsPerTask;

      if (runCount >= maxPerRun) {
        return { kind: 'limit_exceeded' as const, scope: 'run' as const, opKind: input.opKind };
      }
      if (taskCount >= maxPerTask) {
        return { kind: 'limit_exceeded' as const, scope: 'task' as const, opKind: input.opKind };
      }

      const agentMeta = await client.query<{ readonly policy_version: number }>(
        `SELECT policy_version FROM agents WHERE tenant_id = $1 AND id = $2`,
        [task.tenant_id, task.agent_id],
      );
      const policyVersion = Number(agentMeta.rows[0]?.policy_version ?? 0);
      const expiresAt =
        parsePersistedTimestamp(task.lease_expires_at) ?? new Date(now.getTime() + 60_000);

      await client.query(
        `INSERT INTO budget_operations (
           id, tenant_id, task_id, run_id, lease_epoch, policy_version, operation_id,
           reserved_steps, reserved_units, reserved_elapsed_ms, reserved_slots,
           state, utc_day, created_at, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 1, $8, 1, 'reserved', $9::date, $10, $11)`,
        [
          globalThis.crypto.randomUUID(),
          input.lease.tenantId,
          input.lease.taskId,
          input.lease.runId,
          input.lease.leaseEpoch,
          policyVersion,
          input.operationId,
          input.maxDurationMs,
          utcDay,
          now,
          expiresAt,
        ],
      );

      return { kind: 'reserved' as const, operationId: input.operationId };
    });
  }

  async settleAgentOperation(command: {
    readonly tenantId: Id;
    readonly runId: Id;
    readonly operationId: string;
    readonly elapsedMs: number;
    readonly state: 'settled' | 'released';
  }): Promise<boolean> {
    const parsed = settleOpSchema.safeParse(command);
    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const input = parsed.data;
    try {
      const result = await this.pool.query(
        `UPDATE budget_operations
            SET state = $4,
                consumed_steps = CASE WHEN $4 = 'settled' THEN reserved_steps ELSE 0 END,
                consumed_units = CASE WHEN $4 = 'settled' THEN reserved_units ELSE 0 END,
                consumed_elapsed_ms = CASE
                  WHEN $4 = 'settled' THEN LEAST($5::bigint, reserved_elapsed_ms)
                  ELSE 0
                END,
                consumed_slots = 0,
                settled_at = clock_timestamp()
          WHERE tenant_id = $1
            AND run_id = $2
            AND operation_id = $3
            AND state = 'reserved'`,
        [input.tenantId, input.runId, input.operationId, input.state, input.elapsedMs],
      );
      return (result.rowCount ?? 0) === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async commitStepCheckpoint(
    command: PythonAgentCommitStepCommand,
  ): Promise<
    | { readonly outcome: 'committed'; readonly replayed: boolean }
    | { readonly outcome: 'cancelled' }
    | { readonly outcome: 'deadline_exceeded' }
  > {
    const parsed = commitStepSchema.safeParse(command);
    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const input = parsed.data;
    const stepId = `py.step.${input.stepSequence}`;
    const cursor: PythonAgentStepCursor = {
      stepSequence: input.stepSequence,
      runId: input.lease.runId,
      attempt: input.lease.attempt,
      toolCallId: input.toolCallId,
      code: input.code,
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      durationMs: input.durationMs,
      stdoutPreview: input.stdoutPreview,
      stderrPreview: input.stderrPreview,
      toolResultJson: input.toolResultJson,
      stagedOutputs: input.stagedOutputs,
    };
    const inputDigest = await sha256Hex(
      new TextEncoder().encode(
        JSON.stringify({
          stepSequence: input.stepSequence,
          toolCallId: input.toolCallId,
          code: input.code,
        }),
      ),
    );

    return runTx(this.pool, async (client) => {
      const { task, run, now, leaseLive } = await lockTaskAndRun(client, input.lease);
      if (task === null) {
        throw new DomainError('NOT_FOUND', 'task does not exist in this tenant');
      }
      if (!leaseLive || run === null) {
        throw new DomainError('STALE_LEASE', 'step checkpoint refused by lease fence');
      }
      if (task.cancel_requested_at !== null) {
        return { outcome: 'cancelled' as const };
      }
      const deadlineAt = parsePersistedTimestamp(task.deadline_at);
      if (deadlineAt !== null && deadlineAt.getTime() <= now.getTime()) {
        return { outcome: 'deadline_exceeded' as const };
      }

      const existing = await client.query<{ readonly input_digest: string }>(
        `SELECT input_digest
           FROM step_checkpoints
          WHERE tenant_id = $1 AND task_id = $2 AND step_sequence = $3`,
        [input.lease.tenantId, input.lease.taskId, input.stepSequence],
      );
      if ((existing.rowCount ?? 0) > 0) {
        if (existing.rows[0]!.input_digest !== inputDigest) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'step checkpoint sequence already belongs to different step input',
          );
        }
        return { outcome: 'committed' as const, replayed: true };
      }

      await client.query(
        `INSERT INTO step_checkpoints (
           id, tenant_id, task_id, run_id, attempt, lease_epoch, schema_version,
           step_id, step_sequence, input_digest, executor_version, cursor, artifacts, external_effects
         )
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 'python-agent.v1', $10::jsonb, '[]'::jsonb, '[]'::jsonb)`,
        [
          globalThis.crypto.randomUUID(),
          input.lease.tenantId,
          input.lease.taskId,
          input.lease.runId,
          input.lease.attempt,
          input.lease.leaseEpoch,
          stepId,
          input.stepSequence,
          inputDigest,
          JSON.stringify(cursor),
        ],
      );

      await appendTaskEvent(client, {
        tenantId: input.lease.tenantId,
        taskId: input.lease.taskId,
        phase: 'progress',
        occurredAt: now,
        payload: {
          runId: input.lease.runId,
          attempt: input.lease.attempt,
          durationMs: input.durationMs,
        },
      });

      return { outcome: 'committed' as const, replayed: false };
    });
  }

  async commitCompletion(
    command: PythonAgentCommitCompletionCommand,
  ): Promise<PythonAgentCommitResult> {
    const { policy, ...rest } = command;
    const parsed = commitCompletionSchema.safeParse(rest);
    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const input = parsed.data;

    return runTx(this.pool, async (client) => {
      const { task, run, now, leaseLive } = await lockTaskAndRun(client, input.lease);
      if (task === null) {
        throw new DomainError('NOT_FOUND', 'task does not exist in this tenant');
      }
      if (!leaseLive || run === null) {
        throw new DomainError('STALE_LEASE', 'python agent completion refused by lease fence');
      }

      const deadlineAt = parsePersistedTimestamp(task.deadline_at);
      const cancelRequested = task.cancel_requested_at !== null;
      const deadlineReached = deadlineAt !== null && deadlineAt.getTime() <= now.getTime();

      if (cancelRequested || deadlineReached) {
        const convergence = planFinishConvergence({
          outcome: cancelRequested ? 'cancelled' : 'failed_terminal',
          task,
          runRow: run,
          finishedAt: now,
          deadlineAt,
          cancelRequested,
          policy,
        });
        await applyFinishConvergence(client, {
          task,
          runRow: run,
          convergence,
          finishedAt: now,
          payloadExtra: {
            taskKind: 'python.agent',
            route: 'standard',
            durationMs: input.durationMs,
            simulated: input.simulated,
          },
        });
        await client.query(
          `UPDATE b3_task_dispatch_outbox
              SET completed_at = COALESCE(completed_at, clock_timestamp()),
                  dispatch_lease_owner = NULL,
                  dispatch_lease_expires_at = NULL
            WHERE task_id = $1`,
          [input.lease.taskId],
        );
        return cancelRequested
          ? { outcome: 'cancelled' as const }
          : { outcome: 'deadline_exceeded' as const };
      }

      const uniqueOutputsByName = new Map<string, PythonStepStagedOutput>();
      for (const output of input.finalStagedOutputs) {
        uniqueOutputsByName.set(output.filename, output);
      }
      const dedupedOutputs = [...uniqueOutputsByName.values()]
        .sort((a, b) => a.filename.localeCompare(b.filename))
        .slice(0, PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask);

      // Acquire content-digest advisory locks in sorted order before filename-ordered installs.
      await lockBlobDigests(
        client,
        input.lease.tenantId,
        dedupedOutputs.map((output) => output.sha256),
      );

      const publishedArtifactIds: Id[] = [];
      for (const staged of dedupedOutputs) {
        const installed = await this.byteaStore.installInTransaction(
          client,
          input.lease.tenantId,
          staged,
        );
        await client.query(
          `INSERT INTO blobs (tenant_id, sha256, size, media_type, storage_key)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, sha256) DO NOTHING`,
          [
            input.lease.tenantId,
            installed.sha256,
            installed.size,
            installed.mediaType,
            installed.storageKey,
          ],
        );
        const artifactId = globalThis.crypto.randomUUID();
        await client.query(
          `INSERT INTO artifacts (
             id, tenant_id, task_id, run_id, created_by, sha256, size, media_type, retention, filename
           )
           VALUES ($1, $2, $3, $4, 'run', $5, $6, $7, 'task', $8)`,
          [
            artifactId,
            input.lease.tenantId,
            input.lease.taskId,
            input.lease.runId,
            installed.sha256,
            installed.size,
            installed.mediaType,
            staged.filename,
          ],
        );
        publishedArtifactIds.push(artifactId);
      }

      await client.query(
        `INSERT INTO task_results (
           id, tenant_id, task_id, result_state, reason_code, summary_text, detail_text,
           truncated, model_label, simulated, produced_at, created_at, updated_at
         )
         VALUES ($1, $2, $3, 'available', NULL, $4, $5, $6, $7, $8, $9, $9, $9)
         ON CONFLICT (tenant_id, task_id) DO NOTHING`,
        [
          globalThis.crypto.randomUUID(),
          input.lease.tenantId,
          input.lease.taskId,
          input.summaryText,
          input.detailText,
          input.truncated,
          input.modelLabel,
          input.simulated,
          now,
        ],
      );

      const convergence = planFinishConvergence({
        outcome: 'succeeded',
        task,
        runRow: run,
        finishedAt: now,
        deadlineAt,
        cancelRequested: false,
        policy,
      });
      const finished = await applyFinishConvergence(client, {
        task,
        runRow: run,
        convergence,
        finishedAt: now,
        payloadExtra: {
          taskKind: 'python.agent',
          route: 'standard',
          durationMs: input.durationMs,
          simulated: input.simulated,
        },
      });

      await client.query(
        `UPDATE b3_task_dispatch_outbox
            SET completed_at = COALESCE(completed_at, clock_timestamp()),
                dispatch_lease_owner = NULL,
                dispatch_lease_expires_at = NULL
          WHERE task_id = $1`,
        [input.lease.taskId],
      );

      return {
        outcome: 'committed' as const,
        taskStatus: finished.taskStatus,
        runStatus: finished.runStatus,
        publishedArtifactIds: Object.freeze(publishedArtifactIds),
      };
    });
  }

  async commitFailure(command: PythonAgentCommitFailureCommand): Promise<PythonAgentFailureResult> {
    const parsedLease = leasedRunSchema.safeParse(command.lease);
    if (!parsedLease.success) {
      throw toInvalidArgumentError(parsedLease.error);
    }

    return runTx(this.pool, async (client) => {
      const { task, run, now, leaseLive } = await lockTaskAndRun(client, parsedLease.data);
      if (task === null || !leaseLive || run === null) {
        return { outcome: 'stale_lease' as const };
      }

      const deadlineAt = parsePersistedTimestamp(task.deadline_at);
      const cancelRequested = task.cancel_requested_at !== null;
      const baseConvergence = planFinishConvergence({
        outcome: command.outcome,
        task,
        runRow: run,
        finishedAt: now,
        deadlineAt,
        cancelRequested,
        policy: command.policy,
      });
      const convergence =
        baseConvergence.errorCode === undefined &&
        command.errorCode !== undefined &&
        baseConvergence.taskStatus === 'failed'
          ? { ...baseConvergence, errorCode: command.errorCode }
          : baseConvergence;

      const finished = await applyFinishConvergence(client, {
        task,
        runRow: run,
        convergence,
        finishedAt: now,
        payloadExtra: {
          taskKind: 'python.agent',
          route: 'standard',
          ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }),
          ...(command.simulated === undefined ? {} : { simulated: command.simulated }),
        },
      });

      if (finished.taskStatus === 'retryable_failed' && convergence.nextRunAt !== undefined) {
        await client.query(
          `INSERT INTO b3_task_dispatch_outbox (tenant_id, task_id, kind, next_dispatch_at)
           VALUES ($1, $2, 'python.agent', $3)
           ON CONFLICT (task_id) DO UPDATE
             SET next_dispatch_at = EXCLUDED.next_dispatch_at,
                 completed_at = NULL,
                 dispatch_lease_owner = NULL,
                 dispatch_lease_expires_at = NULL,
                 last_error_code = $4`,
          [
            parsedLease.data.tenantId,
            parsedLease.data.taskId,
            convergence.nextRunAt,
            command.errorCode ?? null,
          ],
        );
      } else if (isTerminalTaskStatus(finished.taskStatus)) {
        await client.query(
          `UPDATE b3_task_dispatch_outbox
              SET completed_at = COALESCE(completed_at, clock_timestamp()),
                  dispatch_lease_owner = NULL,
                  dispatch_lease_expires_at = NULL,
                  last_error_code = COALESCE($2, last_error_code)
            WHERE task_id = $1`,
          [parsedLease.data.taskId, command.errorCode ?? null],
        );
      }

      return {
        outcome: 'committed' as const,
        taskStatus: finished.taskStatus,
        runStatus: finished.runStatus,
        ...(convergence.nextRunAt === undefined ? {} : { nextRunAt: convergence.nextRunAt }),
      };
    });
  }
}
