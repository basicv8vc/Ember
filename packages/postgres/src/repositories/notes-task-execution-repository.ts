import { IdSchema, toInvalidArgumentError } from '@ember/contracts';
import {
  DomainError,
  type Id,
  type LeasedRun,
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
import { asDomainError } from './support.js';

const SIMULATED_LABEL_PATTERN = /-(fake|echo)-/;

export interface NotesAttemptReservation {
  readonly attemptNo: number;
  readonly operationId: Id;
  readonly utcDay: string;
  readonly reservedMicroUsd: number;
}

export type NotesReserveOutcome =
  | { readonly kind: 'reserved'; readonly attempt: NotesAttemptReservation }
  | {
      readonly kind: 'task_budget_exhausted';
      readonly reason: 'attempts_exhausted' | 'cost_exceeded';
    }
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

export interface NotesReserveAttemptCommand {
  readonly lease: LeasedRun;
  readonly ceilings: {
    readonly perAttemptMicroUsd: number;
    readonly principalDailyMicroUsd: number;
    readonly tenantDailyMicroUsd: number;
    readonly globalDailyMicroUsd: number;
  };
  readonly maxAttemptsPerTask: number;
  readonly maxTaskCostMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly rateVersion: string;
  readonly providerId: B2ModelProviderId;
  readonly modelLabel: string;
}

export interface NotesAttemptCharge {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly attemptNo: number;
  readonly outcomeCode: string;
  readonly state: 'settled' | 'unknown_billed' | 'released' | 'conservative_billed';
  readonly observedCostMicroUsd?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
}

export interface NotesCommitCompletionCommand {
  readonly lease: LeasedRun;
  readonly policy: RetryPolicyConfig;
  readonly durationMs: number;
  readonly summaryText: string;
  readonly detailText: string | null;
  readonly truncated: boolean;
  readonly modelLabel: string;
  readonly simulated: boolean;
}

export type NotesCommitResult =
  | {
      readonly outcome: 'committed';
      readonly taskStatus: TaskStatus;
      readonly runStatus: RunTerminalStatus;
    }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'deadline_exceeded' };

class NotesRefusal extends Error {
  override readonly name = 'NotesRefusal';
  readonly outcome: NotesReserveOutcome;

  constructor(outcome: NotesReserveOutcome) {
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

    if (error instanceof NotesRefusal) {
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

const reserveSchema = z.strictObject({
  lease: leasedRunSchema,
  ceilings: z.strictObject({
    perAttemptMicroUsd: z.number().int().min(1).max(5_000),
    principalDailyMicroUsd: z.number().int().min(0).max(250_000),
    tenantDailyMicroUsd: z.number().int().min(0).max(1_000_000),
    globalDailyMicroUsd: z.number().int().min(0).max(5_000_000),
  }),
  maxAttemptsPerTask: z.number().int().min(1).max(4),
  maxTaskCostMicroUsd: z.number().int().min(1).max(20_000),
  reservedMicroUsd: z.number().int().min(1).max(5_000),
  rateVersion: z.string().min(1).max(128),
  providerId: z.enum(['openai', 'openrouter']),
  modelLabel: z.string().min(1).max(128),
});

const markSentSchema = z.strictObject({
  lease: leasedRunSchema,
  attemptNo: z.number().int().min(1).max(4),
});

const settleSchema = z
  .strictObject({
    tenantId: IdSchema,
    taskId: IdSchema,
    attemptNo: z.number().int().min(1).max(4),
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

const commitSchema = z
  .strictObject({
    lease: leasedRunSchema,
    durationMs: z.number().int().nonnegative(),
    summaryText: z.string().min(1).max(2_048),
    detailText: z.string().min(1).max(16_384).nullable(),
    truncated: z.boolean(),
    modelLabel: z.string().min(1).max(128),
    simulated: z.boolean(),
  })
  .refine((value) => value.simulated === SIMULATED_LABEL_PATTERN.test(value.modelLabel), {
    message: 'simulated must match the model label',
    path: ['simulated'],
  });

const LOCK_TASK_SQL = `
SELECT id, tenant_id, status, attempt_count, max_attempts,
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

async function lockTaskAndRun(
  client: pg.PoolClient,
  lease: LeasedRun,
): Promise<{
  readonly task: TaskRow | null;
  readonly run: RunRow | null;
  readonly now: Date;
  readonly utcDay: string;
  readonly leaseLive: boolean;
}> {
  const taskResult = await client.query<TaskRow>(LOCK_TASK_SQL, [lease.tenantId, lease.taskId]);
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

/**
 * Durable execution persistence for `notes.action_items` Tasks.
 *
 * Keeps paid attempt & budget state in `task_model_attempts` (per-Task across retries) while
 * sharing `model_global_spend_days`, `model_spend_days`, and `model_budget_incidents` with B2.
 */
export class PostgresNotesTaskExecutionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async reserveAttempt(command: NotesReserveAttemptCommand): Promise<NotesReserveOutcome> {
    const parsed = reserveSchema.safeParse(command);

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

        const principal = await client.query<{ readonly principal_id: string }>(
          'SELECT principal_id FROM consumers WHERE tenant_id = $1',
          [input.lease.tenantId],
        );
        const principalId = principal.rows[0]?.principal_id;

        if (principalId === undefined) {
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
          readonly cumulative_micro_usd: string | number;
        }>(
          `SELECT COALESCE(MAX(attempt_no), 0)::int AS max_attempt,
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
          [input.lease.tenantId, input.lease.taskId],
        );
        const maxAttempt = Number(prior.rows[0]?.max_attempt ?? 0);
        const cumulativeMicroUsd = Number(prior.rows[0]?.cumulative_micro_usd ?? 0);

        if (maxAttempt >= input.maxAttemptsPerTask) {
          return { kind: 'task_budget_exhausted' as const, reason: 'attempts_exhausted' as const };
        }

        if (cumulativeMicroUsd + input.reservedMicroUsd > input.maxTaskCostMicroUsd) {
          return { kind: 'task_budget_exhausted' as const, reason: 'cost_exceeded' as const };
        }

        if (!(await tryReserveGlobalSpend(client, utcDay, input.reservedMicroUsd, globalCeiling))) {
          throw new NotesRefusal({ kind: 'budget_exceeded', scope: 'global' });
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
          throw new NotesRefusal({ kind: 'budget_exceeded', scope: 'tenant' });
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
          throw new NotesRefusal({ kind: 'budget_exceeded', scope: 'principal' });
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
      if (error instanceof NotesRefusal) {
        return error.outcome;
      }
      throw error;
    }
  }

  async markAttemptSent(command: {
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

  async settleAttempt(charge: NotesAttemptCharge): Promise<B2SettlementOutcome> {
    const parsed = settleSchema.safeParse(charge);

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
   * Atomically write `task_results` (`available`), transition `tasks`+`runs` to `completed`/`succeeded`,
   * append terminal `task_events`, and append `outcome_reference` under Task + Run lock & fence.
   */
  async commitCompletion(command: NotesCommitCompletionCommand): Promise<NotesCommitResult> {
    const { policy, ...rest } = command;
    const parsed = commitSchema.safeParse(rest);

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
        throw new DomainError('STALE_LEASE', 'notes completion refused by lease fence');
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
            taskKind: 'notes.action_items',
            route: 'standard',
            durationMs: input.durationMs,
            simulated: input.simulated,
          },
        });
        return cancelRequested
          ? { outcome: 'cancelled' as const }
          : { outcome: 'deadline_exceeded' as const };
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
          taskKind: 'notes.action_items',
          route: 'standard',
          durationMs: input.durationMs,
          simulated: input.simulated,
        },
      });

      return {
        outcome: 'committed' as const,
        taskStatus: finished.taskStatus,
        runStatus: finished.runStatus,
      };
    });
  }
}
