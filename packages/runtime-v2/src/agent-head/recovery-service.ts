import { type Id, isTerminalTaskStatus } from '@ember/domain';
import { V2_B1_COMPAT_CONSTANTS, V2_TIMING_LIMITS } from '../contracts/constants.js';
import {
  PROACTIVE_SCHEDULER_MODEL_LABEL,
  PROACTIVE_TASK_DEADLINE_MS,
  type ProactiveScheduleKind,
  type ProactiveScheduleTaskPayload,
} from '../contracts/proactive-schedules.js';
import { parseDurableTaskOutcome, parseDurableTurnOutcome } from '../contracts/validation.js';
import {
  computePreDeadlineRetryAtMs,
  validateDispatchEnvelope,
  type V2DispatchEnvelope,
} from '../recovery/envelope.js';
import type {
  AgentHeadRecoveryPort,
  AuthoritativeBusinessPort,
  EventRuntimeCoordinatorPort,
  RecoveryAdmissionPort,
  RecoveryRegistryPort,
} from '../recovery/ports.js';
import type {
  OrdinaryOutboxEntityKind,
  V2DispatchOutboxRow,
  V2ScheduleRow,
} from '../recovery/schema.js';
import type { DurableObjectStorageLike } from '../storage.js';
import {
  doesSettlementNeedBudgetCoverageSync,
  getBoundModelAttemptSync,
  reconcileBoundAttemptSettlementSync,
  settleLocalAttemptAndEnqueueSync,
  type LocalBudgetCeilings,
} from './budget.js';
import { readPersonalMemoriesForTurnSync } from './memory-service.js';
import {
  assertHeadScopeSync,
  earliestBusinessAlarmAtMsSync,
  getHeadMetaSync,
  getLatestAttemptForSubjectSync,
  getLatestRunForTaskSync,
  getMainConversationSync,
  getTaskRowSync,
  getTurnRowSync,
  insertEmberMessageSync,
  listReservedAttemptsSync,
  readRecentTurnContextSync,
  sqlExecAll,
  sqlExecMaybe,
  sqlExecOne,
} from './queries.js';
import type {
  ApprovalRow,
  AssistantTurnRow,
  ModelAttemptRow,
  ProactiveScheduleRow,
  TaskRow,
} from './schema.js';
import { toUtcDayString } from './state-machine.js';
import {
  appendTaskEventSync,
  finishTaskRunSync,
  hasLiveTaskLease,
  startTaskRunSync,
} from './task-execution.js';
import {
  confirmOrVerifyCoverageInTxSync,
  executeAuthoritativeTurnCommit,
  isCoverageValidAtSync,
  prepareObligationCoverageAsync,
  syncAlarmAndRelayBudget,
  type CoverageHelperDeps,
  type TurnCommitDeps,
} from './turn-commit.js';

/**
 * Seam delegates owned by Agent B (`OutboxCoordinator`, `RecoveryCoverageCoordinator`,
 * `AlarmMultiplexer`, `relayDueBudgetSyncBatch`) and consumed by Agent A without duplication.
 */
export interface RecoveryCoordinatorHooks {
  /** Maps to `RecoveryCoverageCoordinator.reconcileFromRegistrySync`. */
  readonly reconcileCoverageSync: (cmd: {
    readonly expectedGen: number;
    readonly nowMs: number;
  }) => Awaited<ReturnType<AgentHeadRecoveryPort['reconcileFromRegistry']>>;

  /** Maps to `RecoveryCoverageCoordinator.confirmRegistryPlanSync`. */
  readonly confirmCoveragePlanSync: (cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
    readonly nowMs: number;
  }) => { readonly confirmed: boolean };

  /** Maps to `OutboxCoordinator.getOutboxByIdSync`. */
  readonly getOutboxByIdSync?: (outboxId: string) => V2DispatchOutboxRow | null;

  /** Maps to `AlarmMultiplexer.syncPlatformAlarm`. */
  readonly syncPlatformAlarm?: (
    targetAlarmAtMs: number | null,
    nowMs: number,
  ) => Promise<boolean | void>;

  /** Maps to `relayDueBudgetSyncBatch`. */
  readonly relayBudgetSync?: (nowMs: number) => Promise<void>;
}

export interface RecoveryServiceDeps {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly eventCoordinator: EventRuntimeCoordinatorPort;
  readonly recoveryAdmission: RecoveryAdmissionPort;
  readonly recoveryRegistry: RecoveryRegistryPort;
  readonly hooks: RecoveryCoordinatorHooks;
  readonly nowMs: () => number;
  readonly idFactory?: () => Id;
  readonly localCeilings?: LocalBudgetCeilings;
}

/**
 * Implements `AuthoritativeBusinessPort` (Agent A synchronous business convergence & inspection
 * invoked by Agent B coordinators) and `AgentHeadRecoveryPort` (delegating coverage state transitions
 * to B's `RecoveryCoverageCoordinator` while owning Turn/Task/Run lease & atomic settlement).
 */
export class AgentHeadRecoveryService implements AuthoritativeBusinessPort, AgentHeadRecoveryPort {
  private readonly newId: () => Id;

  constructor(private readonly deps: RecoveryServiceDeps) {
    this.newId = deps.idFactory ?? (() => globalThis.crypto.randomUUID());
  }

  earliestRequiredDiscoveryAtMsSync(_nowMs: number): number | null {
    const sql = this.deps.storage.sql;
    const bizDue = earliestBusinessAlarmAtMsSync(sql);
    const outboxDue = sqlExecOne<{ readonly m: number | null }>(
      sql,
      `SELECT MIN(next_attempt_at_ms) AS m
         FROM v2_dispatch_outbox
        WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
    ).m;
    const schedDue = sqlExecOne<{ readonly m: number | null }>(
      sql,
      `SELECT MIN(next_fire_at_ms) AS m
         FROM v2_schedules
        WHERE status = 'active'`,
    ).m;

    // An accepted turn or active task run can create immediate budget_sync work at any
    // time before its lease expires. The lease alarm is not its discovery bound.
    const activeSince = sqlExecOne<{ readonly m: number | null }>(
      sql,
      `SELECT MIN(started_at_ms) AS m FROM (
         SELECT created_at_ms AS started_at_ms FROM assistant_turns WHERE status = 'running'
         UNION ALL
         SELECT r.started_at_ms FROM tasks t JOIN runs r ON r.id = t.current_run_id
          WHERE t.execution_target = 'cloud' AND t.status = 'running' AND r.status = 'running'
       )`,
    ).m;
    const candidates = [bizDue, outboxDue, schedDue, activeSince].filter(
      (v): v is number => v !== null,
    );
    if (candidates.length === 0) {
      return null;
    }
    const required = Math.min(...candidates) + V2_TIMING_LIMITS.d1RecoveryGraceMs;
    if (activeSince === null) return required;

    // Keep the existing independently discoverable marker through the atomic transfer
    // from dispatch outbox to live lease and final settlement. Do not postpone it
    // just because the next lease alarm moved forward.
    const confirmed = sqlExecMaybe<{ readonly covered_recovery_at_ms: number }>(
      sql,
      `SELECT covered_recovery_at_ms FROM v2_recovery_coverage
        WHERE id = 1 AND coverage_state = 'covered' AND pending_kind IS NULL
          AND covered_recovery_at_ms IS NOT NULL`,
    );
    return confirmed === null ? required : Math.min(required, confirmed.covered_recovery_at_ms);
  }

  listDueBusinessActionsSync(
    nowMs: number,
    limit: number,
  ): ReadonlyArray<{
    readonly targetKind: 'turn' | 'task';
    readonly targetId: string;
    readonly actionKind: 'preclaim_deadline' | 'lease_expired' | 'cancel_converge' | 'retry_due';
    readonly deadlineAtMs: number;
  }> {
    if (limit <= 0) {
      return [];
    }
    const actions: Array<{
      readonly targetKind: 'turn' | 'task';
      readonly targetId: string;
      readonly actionKind: 'preclaim_deadline' | 'lease_expired' | 'cancel_converge' | 'retry_due';
      readonly deadlineAtMs: number;
    }> = [];

    const dueTurns = sqlExecAll<AssistantTurnRow>(
      this.deps.storage.sql,
      `SELECT *
         FROM assistant_turns
        WHERE status = 'running'
          AND (
            cancel_requested_at_ms IS NOT NULL
            OR deadline_at_ms <= ?
            OR (lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?)
          )
        ORDER BY CASE
                   WHEN lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < deadline_at_ms
                     THEN lease_expires_at_ms
                   ELSE deadline_at_ms
                 END ASC, id ASC
        LIMIT ?`,
      nowMs,
      nowMs,
      limit,
    );

    for (const turn of dueTurns) {
      const nextDueMs =
        turn.lease_expires_at_ms !== null && turn.lease_expires_at_ms < turn.deadline_at_ms
          ? turn.lease_expires_at_ms
          : turn.deadline_at_ms;
      const actionKind =
        turn.cancel_requested_at_ms !== null
          ? 'cancel_converge'
          : nowMs >= turn.deadline_at_ms
            ? 'preclaim_deadline'
            : 'lease_expired';
      actions.push({
        targetKind: 'turn',
        targetId: turn.id,
        actionKind,
        deadlineAtMs: nextDueMs,
      });
    }

    if (actions.length >= limit) {
      return actions.slice(0, limit);
    }

    const remaining = limit - actions.length;
    const dueTasks = sqlExecAll<TaskRow>(
      this.deps.storage.sql,
      `SELECT *
         FROM tasks
        WHERE status IN ('queued', 'retryable_failed', 'running', 'waiting_approval')
          AND (
            (deadline_at_ms IS NOT NULL AND deadline_at_ms <= ?)
            OR cancel_requested_at_ms IS NOT NULL
            OR (status = 'running' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?)
            OR (execution_target = 'cloud' AND status IN ('queued', 'retryable_failed') AND next_run_at_ms <= ?)
          )
        ORDER BY CASE WHEN execution_target = 'device' AND status = 'queued' THEN deadline_at_ms
                       ELSE COALESCE(lease_expires_at_ms, deadline_at_ms, next_run_at_ms)
                   END ASC, id ASC
        LIMIT ?`,
      nowMs,
      nowMs,
      nowMs,
      remaining,
    );

    for (const task of dueTasks) {
      let nextDueMs = task.next_run_at_ms;
      if (task.status === 'running' && task.lease_expires_at_ms !== null) {
        nextDueMs =
          task.deadline_at_ms !== null
            ? Math.min(task.lease_expires_at_ms, task.deadline_at_ms)
            : task.lease_expires_at_ms;
      } else if (task.deadline_at_ms !== null) {
        nextDueMs =
          task.status === 'waiting_approval' || task.execution_target === 'device'
            ? task.deadline_at_ms
            : Math.min(task.next_run_at_ms, task.deadline_at_ms);
      }

      const actionKind =
        task.cancel_requested_at_ms !== null
          ? 'cancel_converge'
          : task.deadline_at_ms !== null && nowMs >= task.deadline_at_ms
            ? 'preclaim_deadline'
            : task.status === 'running' &&
                task.lease_expires_at_ms !== null &&
                nowMs >= task.lease_expires_at_ms
              ? 'lease_expired'
              : 'retry_due';
      actions.push({
        targetKind: 'task',
        targetId: task.id,
        actionKind,
        deadlineAtMs: nextDueMs,
      });
    }

    if (actions.length < limit) {
      const remApprovals = limit - actions.length;
      const dueApprovals = sqlExecAll<ApprovalRow>(
        this.deps.storage.sql,
        `SELECT *
           FROM approvals
          WHERE status = 'pending' AND expires_at_ms <= ?
          ORDER BY expires_at_ms ASC, id ASC
          LIMIT ?`,
        nowMs,
        remApprovals,
      );
      for (const approval of dueApprovals) {
        actions.push({
          targetKind: 'task',
          targetId: approval.task_id,
          actionKind: 'preclaim_deadline',
          deadlineAtMs: approval.expires_at_ms,
        });
      }
    }

    actions.sort((a, b) => a.deadlineAtMs - b.deadlineAtMs);
    return actions.slice(0, limit);
  }

  convergeDueBusinessItemSync(targetKind: 'turn' | 'task', targetId: string, nowMs: number): void {
    const meta = getHeadMetaSync(this.deps.storage.sql);
    if (meta === null) {
      return;
    }

    if (targetKind === 'turn') {
      this.convergeDueTurnSync(meta.tenant_id, meta.agent_id, targetId, nowMs);
    } else {
      const before = getTaskRowSync(this.deps.storage.sql, targetId);
      this.convergeDueTaskSync(meta.tenant_id, meta.agent_id, before, nowMs);
      if (before?.execution_target === 'device') {
        const after = getTaskRowSync(this.deps.storage.sql, targetId)!;
        if (
          after.status !== before.status &&
          (after.status === 'queued' || after.status === 'cancelled' || after.status === 'failed')
        ) {
          const eventId = this.newId();
          appendTaskEventSync(this.deps.storage.sql, {
            id: eventId,
            traceId: eventId,
            taskId: after.id,
            nowMs,
            phase: after.status === 'queued' ? 'retry_scheduled' : after.status,
            payload: { leaseEpoch: after.lease_epoch },
          });
        }
      }
    }

    this.deps.eventCoordinator.recomputeAlarmSync(nowMs);
  }

  private settleOpenAttemptsForSubjectSync(
    tenantId: Id,
    agentId: Id,
    subjectType: 'turn' | 'task',
    subjectId: Id,
    outcomeCodeOnRelease: string,
    outcomeCodeOnUncertain: string,
    nowMs: number,
  ): { readonly anyUncertain: boolean } {
    const reservedAttempts = listReservedAttemptsSync(
      this.deps.storage.sql,
      subjectType,
      subjectId,
    );
    let anyUncertain = false;

    for (const attempt of reservedAttempts) {
      const provablyUnsent =
        attempt.send_started_at_ms === null && attempt.send_authorizing_at_ms === null;
      if (!provablyUnsent) {
        anyUncertain = true;
      }

      settleLocalAttemptAndEnqueueSync({
        sql: this.deps.storage.sql,
        coordinator: this.deps.eventCoordinator,
        tenantId,
        agentId,
        attempt,
        requestedState: provablyUnsent ? 'released' : 'unknown_billed',
        outcomeCode: provablyUnsent ? outcomeCodeOnRelease : outcomeCodeOnUncertain,
        nowMs,
        ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
        idFactory: this.newId,
      });
    }

    return { anyUncertain };
  }

  private convergeDueTurnSync(tenantId: Id, agentId: Id, turnId: string, nowMs: number): void {
    const sql = this.deps.storage.sql;
    const turn = getTurnRowSync(sql, turnId);
    if (turn === null || turn.status !== 'running') {
      return;
    }

    if (turn.cancel_requested_at_ms !== null) {
      this.settleOpenAttemptsForSubjectSync(
        tenantId,
        agentId,
        'turn',
        turn.id,
        'client_cancelled',
        'client_cancelled',
        nowMs,
      );
      sql.exec(
        `UPDATE assistant_turns
            SET status = 'cancelled',
                failure_reason = NULL,
                response_message_id = NULL,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        nowMs,
        turn.id,
      );
      this.deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      return;
    }

    if (nowMs >= turn.deadline_at_ms) {
      this.settleOpenAttemptsForSubjectSync(
        tenantId,
        agentId,
        'turn',
        turn.id,
        'not_sent',
        'model_timeout',
        nowMs,
      );
      const { messageId } = insertEmberMessageSync({
        sql,
        messageId: this.newId(),
        conversationId: turn.conversation_id,
        text: V2_B1_COMPAT_CONSTANTS.failureAssistantMessageText,
        modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: true,
        nowMs,
      });
      sql.exec(
        `UPDATE assistant_turns
            SET status = 'failed',
                failure_reason = 'timeout',
                response_message_id = ?,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        messageId,
        nowMs,
        turn.id,
      );
      this.deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      return;
    }

    if (turn.lease_expires_at_ms !== null && nowMs >= turn.lease_expires_at_ms) {
      const retryDecision = computePreDeadlineRetryAtMs(nowMs, turn.deadline_at_ms);
      const hasResumableHandle =
        turn.provider_job_handle !== null && turn.provider_job_handle.length > 0;

      // A durable claim that crashed before the send gate has not spent its model
      // attempt. Transfer the existing reservation, not a released attempt, to the
      // next fenced lease. Never preserve an uncertain or expired grant for a send.
      const latest = getLatestAttemptForSubjectSync(sql, 'turn', turn.id);
      const reserved = listReservedAttemptsSync(sql, 'turn', turn.id);
      const preserveUnsentReservation =
        turn.execution_mode === 'durable_queue' &&
        retryDecision.shouldRetry &&
        !hasResumableHandle &&
        latest !== null &&
        reserved.length === 1 &&
        reserved[0]?.operation_id === latest.operation_id &&
        latest.state === 'reserved' &&
        latest.send_started_at_ms === null &&
        latest.send_authorizing_at_ms === null &&
        (latest.budget_mode === 'disabled_echo_only' ||
          (latest.global_grant_id !== null &&
            latest.global_grant_expires_ms !== null &&
            latest.global_grant_expires_ms >= turn.deadline_at_ms));
      const { anyUncertain } = preserveUnsentReservation
        ? { anyUncertain: false }
        : this.settleOpenAttemptsForSubjectSync(
            tenantId,
            agentId,
            'turn',
            turn.id,
            'not_sent',
            'model_unavailable',
            nowMs,
          );

      // Honest degradation: uncertain outbound call with NO resumable provider handle never blindly replays
      if (anyUncertain && !hasResumableHandle) {
        const { messageId } = insertEmberMessageSync({
          sql,
          messageId: this.newId(),
          conversationId: turn.conversation_id,
          text: V2_B1_COMPAT_CONSTANTS.failureAssistantMessageText,
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          simulated: true,
          nowMs,
        });
        sql.exec(
          `UPDATE assistant_turns
              SET status = 'failed',
                  failure_reason = 'internal_error',
                  response_message_id = ?,
                  lease_owner = NULL,
                  lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE id = ?`,
          messageId,
          nowMs,
          turn.id,
        );
        this.deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
        return;
      }

      if (!retryDecision.shouldRetry) {
        sql.exec(
          `UPDATE assistant_turns
              SET lease_owner = NULL,
                  lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE id = ?`,
          nowMs,
          turn.id,
        );
        this.deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
        return;
      }

      const nextEpoch = turn.lease_epoch + 1;
      sql.exec(
        `UPDATE assistant_turns
            SET execution_mode = 'durable_queue',
                lease_epoch = ?,
                lease_owner = NULL,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        nextEpoch,
        nowMs,
        turn.id,
      );
      this.deps.eventCoordinator.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      const outboxId = `turn:${turn.id}:epoch:${nextEpoch}`;
      const envelope: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId,
        agentId,
        entityKind: 'turn',
        entityId: turn.id,
        queueName: 'durable_turn',
        fenceEpoch: nextEpoch,
      };
      this.deps.eventCoordinator.enqueueDurableOutboxSync({
        outboxId,
        entityKind: 'turn',
        entityId: turn.id,
        queueName: 'durable_turn',
        payloadJson: JSON.stringify(envelope),
        fenceEpoch: nextEpoch,
        nextAttemptAtMs: retryDecision.nextAttemptAtMs,
      });
    }
  }

  private convergeDueTaskSync(
    tenantId: Id,
    agentId: Id,
    task: TaskRow | null,
    nowMs: number,
  ): void {
    const sql = this.deps.storage.sql;
    if (task === null || isTerminalTaskStatus(task.status)) {
      return;
    }

    // Expire overdue pending approvals before checking overall task state
    sql.exec(
      `UPDATE approvals
          SET status = 'expired',
              decided_at_ms = ?,
              updated_at_ms = ?
        WHERE task_id = ? AND status = 'pending' AND expires_at_ms <= ?`,
      nowMs,
      nowMs,
      task.id,
      nowMs,
    );

    if (task.cancel_requested_at_ms !== null) {
      this.settleOpenAttemptsForSubjectSync(
        tenantId,
        agentId,
        'task',
        task.id,
        'client_cancelled',
        'client_cancelled',
        nowMs,
      );
      sql.exec(
        `UPDATE runs
            SET status = 'cancelled',
                finished_at_ms = ?,
                updated_at_ms = ?
          WHERE task_id = ? AND status IN ('created', 'running')`,
        nowMs,
        nowMs,
        task.id,
      );
      sql.exec(
        `UPDATE approvals
            SET status = 'expired',
                decided_at_ms = ?,
                updated_at_ms = ?
          WHERE task_id = ? AND status = 'pending'`,
        nowMs,
        nowMs,
        task.id,
      );
      sql.exec(
        `UPDATE tasks
            SET status = 'cancelled',
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        nowMs,
        task.id,
      );
      this.purgeUncommittedTaskOutputsSync(task.id);
      this.deps.eventCoordinator.cancelEntityOutboxSync('task', task.id, nowMs);
      this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', task.id, nowMs);
      return;
    }

    if (task.deadline_at_ms !== null && nowMs >= task.deadline_at_ms) {
      this.settleOpenAttemptsForSubjectSync(
        tenantId,
        agentId,
        'task',
        task.id,
        'not_sent',
        'model_timeout',
        nowMs,
      );
      sql.exec(
        `UPDATE runs
            SET status = 'failed_terminal',
                finished_at_ms = ?,
                updated_at_ms = ?
          WHERE task_id = ? AND status IN ('created', 'running')`,
        nowMs,
        nowMs,
        task.id,
      );
      sql.exec(
        `UPDATE approvals
            SET status = 'expired',
                decided_at_ms = ?,
                updated_at_ms = ?
          WHERE task_id = ? AND status = 'pending'`,
        nowMs,
        nowMs,
        task.id,
      );
      sql.exec(
        `UPDATE tasks
            SET status = 'failed',
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        nowMs,
        task.id,
      );
      this.recordAndDeliverProactiveFailureSync(task, 'model_timeout', nowMs);
      this.purgeUncommittedTaskOutputsSync(task.id);
      this.deps.eventCoordinator.cancelEntityOutboxSync('task', task.id, nowMs);
      this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', task.id, nowMs);
      return;
    }

    if (
      task.status === 'running' &&
      task.lease_expires_at_ms !== null &&
      nowMs >= task.lease_expires_at_ms
    ) {
      const { anyUncertain } = this.settleOpenAttemptsForSubjectSync(
        tenantId,
        agentId,
        'task',
        task.id,
        'not_sent',
        'model_unavailable',
        nowMs,
      );
      sql.exec(
        `UPDATE runs
            SET status = 'lease_expired',
                finished_at_ms = ?,
                updated_at_ms = ?
          WHERE task_id = ? AND status IN ('created', 'running')`,
        nowMs,
        nowMs,
        task.id,
      );
      this.purgeUncommittedTaskOutputsSync(task.id);

      const hasHandle = task.provider_job_handle !== null && task.provider_job_handle.length > 0;
      const canRetry = task.attempt_count < task.max_attempts && (!anyUncertain || hasHandle);

      if (!canRetry) {
        sql.exec(
          `UPDATE tasks
              SET status = 'failed',
                  lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE id = ?`,
          nowMs,
          task.id,
        );
        this.recordAndDeliverProactiveFailureSync(
          task,
          anyUncertain ? 'model_unavailable' : 'lease_expired',
          nowMs,
        );
        this.deps.eventCoordinator.cancelEntityOutboxSync('task', task.id, nowMs);
        this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', task.id, nowMs);
        return;
      }

      const deadline = task.deadline_at_ms ?? nowMs + 60_000;
      const retryDecision =
        task.execution_target === 'device'
          ? { shouldRetry: true as const, nextAttemptAtMs: nowMs }
          : computePreDeadlineRetryAtMs(nowMs, deadline, 5_000);
      if (!retryDecision.shouldRetry) {
        sql.exec(
          `UPDATE tasks
              SET status = 'retryable_failed',
                  lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE id = ?`,
          nowMs,
          task.id,
        );
        this.deps.eventCoordinator.cancelEntityOutboxSync('task', task.id, nowMs);
        return;
      }

      const nextEpoch = task.lease_epoch + 1;
      sql.exec(
        `UPDATE tasks
            SET status = 'queued',
                lease_epoch = ?,
                lease_expires_at_ms = NULL,
                current_run_id = NULL,
                next_run_at_ms = ?,
                updated_at_ms = ?
          WHERE id = ?`,
        nextEpoch,
        retryDecision.nextAttemptAtMs,
        nowMs,
        task.id,
      );
      this.deps.eventCoordinator.cancelEntityOutboxSync('task', task.id, nowMs);
      // Device work is discovered only by the assigned device's authenticated poll.
      if (task.execution_target === 'device') return;
      const outboxId = `task:${task.id}:epoch:${nextEpoch}`;
      const envelope: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId,
        agentId,
        entityKind: 'task',
        entityId: task.id,
        queueName: 'agent_task',
        fenceEpoch: nextEpoch,
      };
      this.deps.eventCoordinator.enqueueDurableOutboxSync({
        outboxId,
        entityKind: 'task',
        entityId: task.id,
        queueName: 'agent_task',
        payloadJson: JSON.stringify(envelope),
        fenceEpoch: nextEpoch,
        nextAttemptAtMs: retryDecision.nextAttemptAtMs,
      });
    }
  }

  inspectOutboxTargetSync(
    entityKind: OrdinaryOutboxEntityKind,
    entityId: string,
  ): {
    readonly exists: boolean;
    readonly targetKind: 'turn' | 'task' | null;
    readonly targetId: string | null;
    readonly currentLeaseEpoch: number;
    readonly deadlineAtMs: number;
    readonly isTerminal: boolean;
    readonly cancelRequested: boolean;
  } {
    const sql = this.deps.storage.sql;

    if (entityKind === 'turn') {
      const turn = getTurnRowSync(sql, entityId);
      if (turn === null) {
        return {
          exists: false,
          targetKind: null,
          targetId: null,
          currentLeaseEpoch: 0,
          deadlineAtMs: 0,
          isTerminal: true,
          cancelRequested: false,
        };
      }
      return {
        exists: true,
        targetKind: 'turn',
        targetId: turn.id,
        currentLeaseEpoch: turn.lease_epoch,
        deadlineAtMs: turn.deadline_at_ms,
        isTerminal: turn.status !== 'running',
        cancelRequested: turn.cancel_requested_at_ms !== null,
      };
    }

    if (entityKind === 'task') {
      const task = getTaskRowSync(sql, entityId);
      if (task === null) {
        return {
          exists: false,
          targetKind: null,
          targetId: null,
          currentLeaseEpoch: 0,
          deadlineAtMs: 0,
          isTerminal: true,
          cancelRequested: false,
        };
      }
      return {
        exists: true,
        targetKind: 'task',
        targetId: task.id,
        currentLeaseEpoch: task.lease_epoch,
        deadlineAtMs: task.deadline_at_ms ?? Number.MAX_SAFE_INTEGER,
        isTerminal: isTerminalTaskStatus(task.status),
        cancelRequested: task.cancel_requested_at_ms !== null,
      };
    }

    if (entityKind === 'handoff') {
      const turn = getTurnRowSync(sql, entityId);
      if (turn !== null) {
        return {
          exists: true,
          targetKind: 'turn',
          targetId: turn.id,
          currentLeaseEpoch: turn.lease_epoch,
          deadlineAtMs: turn.deadline_at_ms,
          isTerminal: turn.status !== 'running',
          cancelRequested: turn.cancel_requested_at_ms !== null,
        };
      }
      const task = getTaskRowSync(sql, entityId);
      if (task !== null) {
        return {
          exists: true,
          targetKind: 'task',
          targetId: task.id,
          currentLeaseEpoch: task.lease_epoch,
          deadlineAtMs: task.deadline_at_ms ?? Number.MAX_SAFE_INTEGER,
          isTerminal: isTerminalTaskStatus(task.status),
          cancelRequested: task.cancel_requested_at_ms !== null,
        };
      }
      return {
        exists: false,
        targetKind: null,
        targetId: null,
        currentLeaseEpoch: 0,
        deadlineAtMs: 0,
        isTerminal: true,
        cancelRequested: false,
      };
    }

    const task = sqlExecMaybe<TaskRow>(
      sql,
      `SELECT * FROM tasks WHERE idempotency_key = ? LIMIT 1`,
      `schedule:${entityId}`,
    );
    if (task !== null) {
      return {
        exists: true,
        targetKind: 'task',
        targetId: task.id,
        currentLeaseEpoch: task.lease_epoch,
        deadlineAtMs: task.deadline_at_ms ?? Number.MAX_SAFE_INTEGER,
        isTerminal: isTerminalTaskStatus(task.status),
        cancelRequested: task.cancel_requested_at_ms !== null,
      };
    }

    return {
      exists: false,
      targetKind: null,
      targetId: null,
      currentLeaseEpoch: 0,
      deadlineAtMs: 0,
      isTerminal: true,
      cancelRequested: false,
    };
  }

  private hasProactiveSchedulesTableSync(): boolean {
    return (
      sqlExecMaybe<{ readonly name: string }>(
        this.deps.storage.sql,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proactive_schedules'`,
      ) !== null
    );
  }

  private hasTaskArtifactsTableSync(): boolean {
    return (
      sqlExecMaybe<{ readonly name: string }>(
        this.deps.storage.sql,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v2_task_artifacts'`,
      ) !== null
    );
  }

  private purgeUncommittedTaskOutputsSync(taskId: string): void {
    if (!this.hasTaskArtifactsTableSync()) return;
    this.deps.storage.sql.exec(
      `DELETE FROM v2_task_artifacts
        WHERE task_id = ? AND created_by = 'run' AND committed = 0`,
      taskId,
    );
  }

  materializeScheduleOccurrenceSync(
    scheduleId: string,
    occurrenceSeq: number,
    nowMs: number,
  ): void {
    const sql = this.deps.storage.sql;
    const sched = sqlExecMaybe<V2ScheduleRow>(
      sql,
      `SELECT * FROM v2_schedules WHERE schedule_id = ?`,
      scheduleId,
    );
    const isMaterializableOnce =
      sched !== null &&
      sched.schedule_kind === 'once' &&
      sched.status === 'completed' &&
      sched.occurrence_seq === occurrenceSeq;
    if (sched === null || (sched.status !== 'active' && !isMaterializableOnce)) {
      return;
    }

    const idempotencyKey = `schedule:${scheduleId}:${occurrenceSeq}`;
    const existing = sqlExecMaybe<TaskRow>(
      sql,
      `SELECT * FROM tasks WHERE idempotency_key = ?`,
      idempotencyKey,
    );
    if (existing !== null) {
      return;
    }

    const proactive = this.hasProactiveSchedulesTableSync()
      ? sqlExecMaybe<ProactiveScheduleRow>(
          sql,
          `SELECT * FROM proactive_schedules WHERE schedule_id = ?`,
          scheduleId,
        )
      : null;

    const taskId = this.newId();
    const scheduledForMs = sched.last_fired_at_ms ?? nowMs;
    const taskTitle = proactive !== null ? proactive.title : `Scheduled ${sched.source_kind}`;
    const inputJson =
      proactive !== null
        ? JSON.stringify({
            prompt: proactive.prompt,
            proactiveSchedule: {
              scheduleId: proactive.schedule_id,
              occurrenceSeq,
              principalId: proactive.principal_id,
              kind: proactive.kind,
              title: proactive.title,
              prompt: proactive.prompt,
              deliveryMode: proactive.delivery_mode,
              scheduleKind: sched.schedule_kind,
              timezone: sched.timezone,
              scheduledForMs,
            } satisfies ProactiveScheduleTaskPayload,
          })
        : JSON.stringify({
            prompt: `Scheduled execution for ${sched.source_kind}:${sched.source_id}`,
          });
    const deadlineAtMs = proactive !== null ? nowMs + PROACTIVE_TASK_DEADLINE_MS : null;

    sql.exec(
      `INSERT INTO tasks (
         id, kind, title, input_json, digest, idempotency_key, status,
         execution_path, execution_target, attempt_count, max_attempts,
         lease_epoch, next_run_at_ms, deadline_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, 'mock.chat', ?, ?, ?, ?, 'queued', 'standard', 'cloud', 0, 3, 1, ?, ?, ?, ?)`,
      taskId,
      taskTitle,
      inputJson,
      idempotencyKey,
      idempotencyKey,
      nowMs,
      deadlineAtMs,
      nowMs,
      nowMs,
    );
    if (proactive !== null) {
      sql.exec(
        `INSERT INTO proactive_schedule_runs (
           schedule_id, occurrence_seq, task_id, scheduled_for_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
        scheduleId,
        occurrenceSeq,
        taskId,
        scheduledForMs,
        nowMs,
      );
    }
    sql.exec(
      `INSERT INTO task_events (id, task_id, sequence, phase, payload_json, trace_id, occurred_at_ms)
       VALUES (?, ?, 1, 'accepted', ?, ?, ?)`,
      this.newId(),
      taskId,
      JSON.stringify({
        taskKind: 'mock.chat',
        replayed: false,
        ...(proactive !== null ? { scheduleId, occurrenceSeq, proactiveKind: proactive.kind } : {}),
      }),
      this.newId(),
      nowMs,
    );

    const outboxId = `schedule_occurrence:${scheduleId}:${occurrenceSeq}`;
    const envelope: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: outboxId,
      tenantId: sched.tenant_id,
      agentId: sched.agent_id,
      entityKind: 'task',
      entityId: taskId,
      queueName: 'agent_task',
      fenceEpoch: 1,
    };
    this.deps.eventCoordinator.enqueueDurableOutboxSync({
      outboxId,
      entityKind: 'task',
      entityId: taskId,
      queueName: 'agent_task',
      payloadJson: JSON.stringify(envelope),
      fenceEpoch: 1,
      nextAttemptAtMs: nowMs,
    });
  }

  /**
   * Delegates recovery coverage plan decisions to Agent B's `RecoveryCoverageCoordinator`,
   * then recalculates & syncs the single DO Alarm via B's `OutboxCoordinator` / `AlarmMultiplexer`.
   */
  async reconcileFromRegistry(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedGen: number;
    readonly nowMs: number;
  }): Promise<Awaited<ReturnType<AgentHeadRecoveryPort['reconcileFromRegistry']>>> {
    const outcome = this.deps.storage.transactionSync(() => {
      assertHeadScopeSync(this.deps.storage.sql, cmd.tenantId, cmd.agentId);
      const plan = this.deps.hooks.reconcileCoverageSync({
        expectedGen: cmd.expectedGen,
        nowMs: cmd.nowMs,
      });
      const nextAlarm = this.deps.eventCoordinator.recomputeAlarmSync(cmd.nowMs);
      return { plan, nextAlarm };
    });

    if (this.deps.hooks.syncPlatformAlarm !== undefined) {
      await this.deps.hooks.syncPlatformAlarm(outcome.nextAlarm, cmd.nowMs);
    }
    return outcome.plan;
  }

  confirmRegistryPlan(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
  }): Promise<{ readonly confirmed: boolean }> {
    const nowMs = this.deps.nowMs();
    const res = this.deps.storage.transactionSync(() =>
      this.deps.hooks.confirmCoveragePlanSync({
        generation: cmd.generation,
        actualRecoveryAtMs: cmd.actualRecoveryAtMs,
        applied: cmd.applied,
        nowMs,
      }),
    );
    return Promise.resolve(res);
  }

  async claimDurableWork(cmd: {
    readonly envelope: V2DispatchEnvelope;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<Awaited<ReturnType<AgentHeadRecoveryPort['claimDurableWork']>>> {
    const envCheck = validateDispatchEnvelope(cmd.envelope);
    if (!envCheck.ok) {
      return { kind: 'not_claimed', reason: 'stale_or_invalid_envelope' };
    }
    const env = envCheck.envelope;
    const nowMs = this.deps.nowMs();

    const result = this.deps.storage.transactionSync(() => {
      const meta = getHeadMetaSync(this.deps.storage.sql);
      if (meta === null || meta.tenant_id !== env.tenantId || meta.agent_id !== env.agentId) {
        return {
          res: { kind: 'not_claimed' as const, reason: 'stale_or_invalid_envelope' as const },
          alarmAtMs: undefined as number | null | undefined,
        };
      }

      const outbox =
        this.deps.hooks.getOutboxByIdSync !== undefined
          ? this.deps.hooks.getOutboxByIdSync(env.eventId)
          : sqlExecMaybe<V2DispatchOutboxRow>(
              this.deps.storage.sql,
              `SELECT * FROM v2_dispatch_outbox WHERE outbox_id = ?`,
              env.eventId,
            );

      if (outbox === null) {
        return {
          res: { kind: 'not_claimed' as const, reason: 'not_found' as const },
          alarmAtMs: undefined,
        };
      }

      if (
        outbox.entity_kind === 'budget_sync' ||
        outbox.queue_name === null ||
        outbox.entity_kind !== env.entityKind ||
        outbox.entity_id !== env.entityId ||
        outbox.queue_name !== env.queueName ||
        outbox.fence_epoch !== env.fenceEpoch
      ) {
        return {
          res: { kind: 'not_claimed' as const, reason: 'stale_or_invalid_envelope' as const },
          alarmAtMs: undefined,
        };
      }

      if (outbox.state === 'acked' || outbox.state === 'cancelled') {
        return {
          res: { kind: 'not_claimed' as const, reason: 'terminal' as const },
          alarmAtMs: undefined,
        };
      }

      const target = this.inspectOutboxTargetSync(env.entityKind, env.entityId);
      if (!target.exists || target.targetKind === null || target.targetId === null) {
        return {
          res: { kind: 'not_claimed' as const, reason: 'not_found' as const },
          alarmAtMs: undefined,
        };
      }

      if (env.fenceEpoch !== target.currentLeaseEpoch) {
        return {
          res: { kind: 'not_claimed' as const, reason: 'stale_or_invalid_envelope' as const },
          alarmAtMs: undefined,
        };
      }

      if (target.isTerminal) {
        this.deps.eventCoordinator.ackOutboxSync(outbox.outbox_id, outbox.fence_epoch, nowMs);
        const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);
        return {
          res: { kind: 'not_claimed' as const, reason: 'terminal' as const },
          alarmAtMs,
        };
      }

      if (target.cancelRequested) {
        this.convergeDueBusinessItemSync(target.targetKind, target.targetId, nowMs);
        const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);
        return {
          res: { kind: 'not_claimed' as const, reason: 'terminal' as const },
          alarmAtMs,
        };
      }

      if (nowMs >= target.deadlineAtMs) {
        this.convergeDueBusinessItemSync(target.targetKind, target.targetId, nowMs);
        const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);
        return {
          res: { kind: 'not_claimed' as const, reason: 'deadline_expired' as const },
          alarmAtMs,
        };
      }

      if (target.targetKind === 'turn') {
        const turn = getTurnRowSync(this.deps.storage.sql, target.targetId)!;
        if (turn.lease_expires_at_ms !== null && nowMs < turn.lease_expires_at_ms) {
          return {
            res: { kind: 'not_claimed' as const, reason: 'lease_active' as const },
            alarmAtMs: undefined,
          };
        }
        const nextEpoch = turn.lease_epoch + 1;
        const leaseExpiresAtMs = Math.min(nowMs + cmd.leaseMs, turn.deadline_at_ms);
        this.deps.storage.sql.exec(
          `UPDATE assistant_turns
              SET execution_mode = 'durable_queue',
                  lease_epoch = ?,
                  lease_owner = ?,
                  lease_expires_at_ms = ?,
                  claim_count = claim_count + 1,
                  updated_at_ms = ?
            WHERE id = ?`,
          nextEpoch,
          cmd.workerId,
          leaseExpiresAtMs,
          nowMs,
          turn.id,
        );
        this.deps.eventCoordinator.ackOutboxSync(outbox.outbox_id, outbox.fence_epoch, nowMs);
        const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);

        const source = this.deps.storage.sql
          .exec<{ sequence: number }>(
            'SELECT sequence FROM conversation_messages WHERE id = ?',
            turn.source_message_id,
          )
          .one();
        const context = readRecentTurnContextSync(
          this.deps.storage.sql,
          turn.conversation_id,
          undefined,
          source.sequence,
        );
        const latestAttempt = getLatestAttemptForSubjectSync(
          this.deps.storage.sql,
          'turn',
          turn.id,
        );
        const personalMemories =
          latestAttempt !== null
            ? readPersonalMemoriesForTurnSync(
                this.deps.storage.sql,
                cmd.envelope.tenantId,
                latestAttempt.principal_id,
              )
            : [];
        return {
          res: {
            kind: 'claimed' as const,
            targetKind: 'turn' as const,
            targetId: turn.id,
            leaseEpoch: nextEpoch,
            leaseExpiresAtMs,
            contextJson: JSON.stringify(
              buildClaimAttemptContextFields(latestAttempt, turn.created_at_ms, {
                entityKind: 'turn',
                entityId: turn.id,
                fallbackOperationId: turn.id,
                providerJobHandle: turn.provider_job_handle,
                interactiveHandoff: turn.handoff_reason !== null,
                turnId: turn.id,
                conversationId: turn.conversation_id,
                deadlineAtMs: turn.deadline_at_ms,
                context,
                ...(personalMemories.length > 0 ? { personalMemories } : {}),
              }),
            ),
          },
          alarmAtMs,
        };
      }

      const task = getTaskRowSync(this.deps.storage.sql, target.targetId)!;
      if (task.execution_target !== 'cloud') {
        return {
          res: { kind: 'not_claimed' as const, reason: 'stale_or_invalid_envelope' as const },
          alarmAtMs: undefined,
        };
      }
      if (task.lease_expires_at_ms !== null && nowMs < task.lease_expires_at_ms) {
        return {
          res: { kind: 'not_claimed' as const, reason: 'lease_active' as const },
          alarmAtMs: undefined,
        };
      }
      if (task.status === 'waiting_approval') {
        return {
          res: { kind: 'not_claimed' as const, reason: 'lease_active' as const },
          alarmAtMs: undefined,
        };
      }

      const runId = this.newId();
      const { nextEpoch, nextAttempt, leaseExpiresAtMs } = startTaskRunSync(
        this.deps.storage.sql,
        task,
        {
          runId,
          workerId: cmd.workerId,
          executorKind: 'queue_worker',
          nowMs,
          leaseMs: cmd.leaseMs,
        },
      );
      appendTaskEventSync(this.deps.storage.sql, {
        id: this.newId(),
        taskId: task.id,
        phase: 'leased',
        traceId: this.newId(),
        nowMs,
        payload: { taskKind: task.kind, runId, attempt: nextAttempt },
      });
      this.deps.eventCoordinator.ackOutboxSync(outbox.outbox_id, outbox.fence_epoch, nowMs);
      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);
      const latestTaskAttempt = getLatestAttemptForSubjectSync(
        this.deps.storage.sql,
        'task',
        task.id,
      );
      const mainConversation = getMainConversationSync(this.deps.storage.sql);
      const ownerPrincipalId = this.resolveTaskPrincipalIdSync(task, latestTaskAttempt);

      return {
        res: {
          kind: 'claimed' as const,
          targetKind: 'task' as const,
          targetId: task.id,
          leaseEpoch: nextEpoch,
          leaseExpiresAtMs,
          contextJson: JSON.stringify(
            buildClaimAttemptContextFields(latestTaskAttempt, task.created_at_ms, {
              entityKind: 'task',
              entityId: task.id,
              fallbackOperationId: `${task.id}:run:${runId}`,
              providerJobHandle: task.provider_job_handle,
              ...(mainConversation !== null ? { conversationId: mainConversation.id } : {}),
              taskId: task.id,
              runId,
              attempt: nextAttempt,
              kind: task.kind,
              inputJson: task.input_json,
              deadlineAtMs: task.deadline_at_ms,
              ...(ownerPrincipalId === null ? {} : { principalId: ownerPrincipalId }),
            }),
          ),
        },
        alarmAtMs,
      };
    });

    if (result.alarmAtMs !== undefined && this.deps.hooks.syncPlatformAlarm !== undefined) {
      await this.deps.hooks.syncPlatformAlarm(result.alarmAtMs, nowMs);
    }
    return result.res;
  }

  private toCoverageDeps(): CoverageHelperDeps {
    return {
      storage: this.deps.storage,
      recoveryAdmission: this.deps.recoveryAdmission,
      recoveryHooks: this.deps.hooks,
      recoveryRegistry: this.deps.recoveryRegistry,
      earliestDiscovery: this,
      nowMs: this.deps.nowMs,
    };
  }

  private toTurnCommitDeps(): TurnCommitDeps {
    return {
      ...this.toCoverageDeps(),
      eventCoordinator: this.deps.eventCoordinator,
      idFactory: this.newId,
      ...(this.deps.localCeilings !== undefined ? { localCeilings: this.deps.localCeilings } : {}),
    };
  }

  async commitDurableResult(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly entityType: 'turn' | 'task';
    readonly entityId: string;
    readonly leaseEpoch: number;
    readonly workerId: string;
    readonly outcome: unknown;
  }): Promise<{ readonly accepted: boolean }> {
    if (cmd.entityType === 'turn') {
      const parsed = parseDurableTurnOutcome(cmd.outcome);
      if (parsed === null) {
        return { accepted: false };
      }

      const result =
        parsed.status === 'completed'
          ? {
              status: 'completed' as const,
              text: parsed.text!,
              modelLabel: parsed.modelLabel ?? V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
              simulated: parsed.simulated ?? true,
              ...(parsed.delegation !== undefined ? { delegation: parsed.delegation } : {}),
              ...(parsed.personalMemorySave !== undefined
                ? { personalMemorySave: parsed.personalMemorySave }
                : {}),
              ...(parsed.proactiveScheduleCreate !== undefined
                ? { proactiveScheduleCreate: parsed.proactiveScheduleCreate }
                : {}),
            }
          : parsed.status === 'failed'
            ? {
                status: 'failed' as const,
                failureReason: parsed.failureReason ?? ('internal_error' as const),
              }
            : { status: 'aborted_for_retry_or_reconcile' as const };

      const commitOutcome = await executeAuthoritativeTurnCommit(this.toTurnCommitDeps(), {
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        turnId: cmd.entityId,
        leaseEpoch: cmd.leaseEpoch,
        leaseOwner: cmd.workerId,
        attemptNo: parsed.attemptNo,
        operationId: parsed.operationId,
        settlement: parsed.settlement,
        result,
        allowDeadlineTimeoutPublish: false,
        throwOnScopeMismatch: false,
      });

      const accepted =
        commitOutcome.outcome === 'published' ||
        (parsed.status === 'aborted_for_retry_or_reconcile' &&
          commitOutcome.outcome === 'reconciled_only' &&
          commitOutcome.turn.status === 'running');
      return { accepted };
    }

    const parsedTask = parseDurableTaskOutcome(cmd.outcome);
    if (parsedTask === null) {
      return { accepted: false };
    }

    const covDeps = this.toCoverageDeps();
    const budgetCoverageReg =
      parsedTask.settlement !== undefined
        ? await prepareObligationCoverageAsync(covDeps, {
            tenantId: cmd.tenantId,
            agentId: cmd.agentId,
            shouldCoverSync: () => {
              const bound = this.deps.nowMs() + V2_TIMING_LIMITS.d1RecoveryGraceMs;
              if (isCoverageValidAtSync(covDeps, bound)) {
                return false;
              }
              return doesSettlementNeedBudgetCoverageSync({
                sql: this.deps.storage.sql,
                subjectType: 'task',
                subjectId: cmd.entityId,
                attemptNo: parsedTask.attemptNo!,
                operationId: parsedTask.operationId!,
                observedCostMicroUsd: parsedTask.settlement!.observedCostMicroUsd ?? null,
              });
            },
          })
        : null;

    const committed = this.deps.storage.transactionSync(() => {
      const nowMs = this.deps.nowMs();
      const meta = getHeadMetaSync(this.deps.storage.sql);
      if (meta === null || meta.tenant_id !== cmd.tenantId || meta.agent_id !== cmd.agentId) {
        return {
          accepted: false,
          alarmAtMs: undefined as number | null | undefined,
          nowMs,
          hasBudgetSync: false,
        };
      }

      const task = getTaskRowSync(this.deps.storage.sql, cmd.entityId);
      const run = task === null ? null : getLatestRunForTaskSync(this.deps.storage.sql, task.id);
      if (task?.execution_target === 'device') {
        return { accepted: false, alarmAtMs: undefined, nowMs, hasBudgetSync: false };
      }
      const isFencedValid =
        task !== null &&
        run !== null &&
        hasLiveTaskLease(task, run, nowMs, {
          leaseEpoch: cmd.leaseEpoch,
          workerId: cmd.workerId,
          executorKind: 'queue_worker',
        });

      if (!isFencedValid) {
        let alarmAtMs: number | null | undefined;
        let hasBudgetSync = false;
        if (parsedTask.settlement !== undefined) {
          const allowActiveReservedSettle = task === null || task.status !== 'running';
          const needsCoverage =
            doesSettlementNeedBudgetCoverageSync({
              sql: this.deps.storage.sql,
              subjectType: 'task',
              subjectId: cmd.entityId,
              attemptNo: parsedTask.attemptNo!,
              operationId: parsedTask.operationId!,
              observedCostMicroUsd: parsedTask.settlement.observedCostMicroUsd ?? null,
            }) &&
            (allowActiveReservedSettle ||
              getBoundModelAttemptSync(
                this.deps.storage.sql,
                'task',
                cmd.entityId,
                parsedTask.attemptNo!,
                parsedTask.operationId!,
              )?.state !== 'reserved');

          if (needsCoverage) {
            confirmOrVerifyCoverageInTxSync(
              covDeps,
              budgetCoverageReg,
              nowMs + V2_TIMING_LIMITS.d1RecoveryGraceMs,
              nowMs,
              'recovery coverage lost or insufficient for late task budget_sync',
            );
          }

          const reconciled = reconcileBoundAttemptSettlementSync({
            sql: this.deps.storage.sql,
            coordinator: this.deps.eventCoordinator,
            tenantId: cmd.tenantId,
            agentId: cmd.agentId,
            subjectType: 'task',
            subjectId: cmd.entityId,
            attemptNo: parsedTask.attemptNo!,
            operationId: parsedTask.operationId!,
            requestedState: parsedTask.settlement.state,
            outcomeCode: parsedTask.settlement.outcomeCode,
            observedCostMicroUsd: parsedTask.settlement.observedCostMicroUsd ?? null,
            inputTokens: parsedTask.settlement.inputTokens ?? null,
            outputTokens: parsedTask.settlement.outputTokens ?? null,
            nowMs,
            allowActiveReservedSettle,
            ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
            idFactory: this.newId,
          });
          if (reconciled.matched) {
            hasBudgetSync = reconciled.outboxId !== null;
            alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);
          }
        }
        return { accepted: false, alarmAtMs, nowMs, hasBudgetSync };
      }

      const openReserved = listReservedAttemptsSync(this.deps.storage.sql, 'task', task.id);
      let hasBudgetSync = false;
      if (parsedTask.settlement !== undefined) {
        const boundAttempt = getBoundModelAttemptSync(
          this.deps.storage.sql,
          'task',
          task.id,
          parsedTask.attemptNo!,
          parsedTask.operationId!,
        );
        if (
          boundAttempt === null ||
          openReserved.some((a) => a.attempt_no !== boundAttempt.attempt_no)
        ) {
          return { accepted: false, alarmAtMs: undefined, nowMs, hasBudgetSync: false };
        }
        if (
          doesSettlementNeedBudgetCoverageSync({
            sql: this.deps.storage.sql,
            subjectType: 'task',
            subjectId: task.id,
            attemptNo: parsedTask.attemptNo!,
            operationId: parsedTask.operationId!,
            observedCostMicroUsd: parsedTask.settlement.observedCostMicroUsd ?? null,
          })
        ) {
          confirmOrVerifyCoverageInTxSync(
            covDeps,
            budgetCoverageReg,
            nowMs + V2_TIMING_LIMITS.d1RecoveryGraceMs,
            nowMs,
            'recovery coverage lost or insufficient for task budget_sync',
          );
        }
        const settled = settleLocalAttemptAndEnqueueSync({
          sql: this.deps.storage.sql,
          coordinator: this.deps.eventCoordinator,
          tenantId: cmd.tenantId,
          agentId: cmd.agentId,
          attempt: boundAttempt,
          requestedState: parsedTask.settlement.state,
          outcomeCode: parsedTask.settlement.outcomeCode,
          observedCostMicroUsd: parsedTask.settlement.observedCostMicroUsd ?? null,
          inputTokens: parsedTask.settlement.inputTokens ?? null,
          outputTokens: parsedTask.settlement.outputTokens ?? null,
          nowMs,
          ...(this.deps.localCeilings !== undefined ? { ceilings: this.deps.localCeilings } : {}),
          idFactory: this.newId,
        });
        hasBudgetSync = settled.outboxId !== null;
      } else if (openReserved.length > 0) {
        // Model-backed task with open reserved budget must supply bound settlement before completion
        return { accepted: false, alarmAtMs: undefined, nowMs, hasBudgetSync: false };
      }

      const isCompleted = parsedTask.status !== 'failed';
      const reasonCode = parsedTask.reasonCode ?? (isCompleted ? 'ok' : 'internal_error');
      finishTaskRunSync(this.deps.storage.sql, task, run, nowMs, {
        status: isCompleted ? 'completed' : 'failed',
        summaryText: parsedTask.summaryText ?? null,
        detailText: parsedTask.detailText ?? null,
        modelLabel: parsedTask.modelLabel ?? V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        simulated: parsedTask.simulated ?? true,
        truncated: parsedTask.truncated ?? false,
        reasonCode,
      });
      this.deliverProactiveTerminalOutcomeSync(
        task,
        isCompleted
          ? {
              status: 'completed',
              summaryText: parsedTask.summaryText ?? null,
              detailText: parsedTask.detailText ?? null,
              modelLabel: parsedTask.modelLabel ?? V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
              simulated: parsedTask.simulated ?? true,
            }
          : {
              status: 'failed',
              reasonCode,
            },
        nowMs,
      );

      // Atomically commit only the winning run's staged output artifacts and purge uncommitted
      // rows from any other/failed attempts inside the same SQLite transaction as task completion.
      if (this.hasTaskArtifactsTableSync()) {
        if (isCompleted) {
          this.deps.storage.sql.exec(
            `UPDATE v2_task_artifacts
                SET committed = 1
              WHERE task_id = ? AND created_by = 'run' AND run_id = ?`,
            task.id,
            run.id,
          );
        }
        this.purgeUncommittedTaskOutputsSync(task.id);
      }

      appendTaskEventSync(this.deps.storage.sql, {
        id: this.newId(),
        taskId: task.id,
        phase: isCompleted ? 'completed' : 'failed',
        traceId: this.newId(),
        nowMs,
        payload: {
          taskKind: task.kind,
          runId: run.id,
          attempt: run.attempt,
          toStatus: isCompleted ? 'completed' : 'failed',
          simulated: parsedTask.simulated ?? true,
        },
      });
      this.deps.eventCoordinator.cancelEntityOutboxSync('task', task.id, nowMs);
      this.deps.eventCoordinator.cancelEntityOutboxSync('handoff', task.id, nowMs);
      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);
      return { accepted: true, alarmAtMs, nowMs, hasBudgetSync };
    });

    await syncAlarmAndRelayBudget({
      recoveryHooks: this.deps.hooks,
      alarmAtMs: committed.alarmAtMs,
      nowMs: committed.nowMs,
      shouldRelayBudgetSync: committed.hasBudgetSync,
      recomputeAlarmSync: (ts) =>
        this.deps.storage.transactionSync(() => this.deps.eventCoordinator.recomputeAlarmSync(ts)),
    });
    return { accepted: committed.accepted };
  }

  private findProactiveRunScheduleSync(taskId: string): {
    readonly title: string;
    readonly kind: ProactiveScheduleKind;
    readonly delivery_mode: 'direct_reminder' | 'model_brief';
    readonly schedule_status: V2ScheduleRow['status'];
  } | null {
    if (!this.hasProactiveSchedulesTableSync()) return null;
    return sqlExecMaybe<{
      readonly title: string;
      readonly kind: ProactiveScheduleKind;
      readonly delivery_mode: 'direct_reminder' | 'model_brief';
      readonly schedule_status: V2ScheduleRow['status'];
    }>(
      this.deps.storage.sql,
      `SELECT ps.title, ps.kind, ps.delivery_mode, s.status AS schedule_status
         FROM proactive_schedule_runs r
         JOIN proactive_schedules ps ON ps.schedule_id = r.schedule_id
         JOIN v2_schedules s ON s.schedule_id = ps.schedule_id
        WHERE r.task_id = ?`,
      taskId,
    );
  }

  private deliverProactiveTerminalOutcomeSync(
    task: TaskRow,
    outcome:
      | {
          readonly status: 'completed';
          readonly summaryText: string | null;
          readonly detailText: string | null;
          readonly modelLabel: string;
          readonly simulated: boolean;
        }
      | {
          readonly status: 'failed';
          readonly reasonCode: string;
        },
    nowMs: number,
  ): void {
    if (task.linked_message_id !== null || task.cancel_requested_at_ms !== null) {
      return;
    }
    const proactive = this.findProactiveRunScheduleSync(task.id);
    if (proactive === null || proactive.schedule_status === 'cancelled') {
      return;
    }
    const conv = getMainConversationSync(this.deps.storage.sql);
    if (conv === null) {
      return;
    }

    const messageText =
      outcome.status === 'completed'
        ? formatProactiveOutcomeMessage({
            title: proactive.title,
            deliveryMode: proactive.delivery_mode,
            summaryText: outcome.summaryText,
            detailText: outcome.detailText,
          })
        : formatProactiveFailureMessage({
            title: proactive.title,
            kind: proactive.kind,
            reasonCode: outcome.reasonCode,
          });

    const delivered = insertEmberMessageSync({
      sql: this.deps.storage.sql,
      messageId: this.newId(),
      conversationId: conv.id,
      text: messageText,
      modelLabel: outcome.status === 'completed' ? outcome.modelLabel : PROACTIVE_SCHEDULER_MODEL_LABEL,
      simulated: outcome.status === 'completed' ? outcome.simulated : false,
      nowMs,
    });
    this.deps.storage.sql.exec(
      `UPDATE tasks SET linked_message_id = ?, updated_at_ms = ? WHERE id = ?`,
      delivered.messageId,
      nowMs,
      task.id,
    );
  }

  private recordAndDeliverProactiveFailureSync(
    task: TaskRow,
    reasonCode: string,
    nowMs: number,
  ): void {
    if (task.cancel_requested_at_ms !== null) return;
    const proactive = this.findProactiveRunScheduleSync(task.id);
    if (proactive === null || proactive.schedule_status === 'cancelled') {
      return;
    }
    this.deps.storage.sql.exec(
      `INSERT INTO task_results (
        task_id, summary_text, detail_text, model_label, simulated, truncated, reason_code, produced_at_ms
      ) VALUES (?, ?, NULL, ?, 0, 0, ?, ?)
      ON CONFLICT (task_id) DO NOTHING`,
      task.id,
      proactive.title,
      PROACTIVE_SCHEDULER_MODEL_LABEL,
      reasonCode,
      nowMs,
    );
    this.deliverProactiveTerminalOutcomeSync(
      task,
      { status: 'failed', reasonCode },
      nowMs,
    );
  }

  private resolveTaskPrincipalIdSync(
    task: TaskRow,
    latestAttempt: ModelAttemptRow | null,
  ): string | null {
    if (latestAttempt !== null) return latestAttempt.principal_id;

    if (this.hasTaskArtifactsTableSync()) {
      const boundInput = sqlExecMaybe<{ readonly principal_id: string }>(
        this.deps.storage.sql,
        `SELECT principal_id
           FROM v2_task_artifacts
          WHERE task_id = ? AND created_by = 'user'
          LIMIT 1`,
        task.id,
      );
      if (boundInput !== null) return boundInput.principal_id;
    }

    const linkedTurn = sqlExecMaybe<{ readonly principal_id: string }>(
      this.deps.storage.sql,
      `SELECT ma.principal_id
         FROM assistant_turns t
         JOIN model_attempts ma ON ma.subject_type = 'turn' AND ma.subject_id = t.id
        WHERE t.linked_task_id = ?
        ORDER BY ma.attempt_no DESC
        LIMIT 1`,
      task.id,
    );
    if (linkedTurn !== null) return linkedTurn.principal_id;

    if (task.idempotency_key.startsWith('v2-python:')) {
      const keyPart = task.idempotency_key.slice('v2-python:'.length).split(':')[0];
      if (keyPart !== undefined && keyPart.length > 0) return keyPart;
    }

    if (this.hasProactiveSchedulesTableSync()) {
      const proactive = sqlExecMaybe<{ readonly principal_id: string }>(
        this.deps.storage.sql,
        `SELECT ps.principal_id
           FROM proactive_schedule_runs psr
           JOIN proactive_schedules ps ON ps.schedule_id = psr.schedule_id
          WHERE psr.task_id = ?
          LIMIT 1`,
        task.id,
      );
      if (proactive !== null) return proactive.principal_id;
    }

    return null;
  }

  async renewTaskLease(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly leaseEpoch: number;
    readonly workerId: string;
    readonly extendMs: number;
  }): Promise<{
    readonly renewed: boolean;
    readonly cancelRequested: boolean;
    readonly leaseExpiresAtMs: number | null;
  }> {
    const tx = this.deps.storage.transactionSync(() => {
      assertHeadScopeSync(this.deps.storage.sql, cmd.tenantId, cmd.agentId);
      const nowMs = this.deps.nowMs();
      const task = getTaskRowSync(this.deps.storage.sql, cmd.taskId);
      const run = task === null ? null : getLatestRunForTaskSync(this.deps.storage.sql, task.id);
      if (
        task === null ||
        run === null ||
        run.id !== cmd.runId ||
        !hasLiveTaskLease(task, run, nowMs, {
          leaseEpoch: cmd.leaseEpoch,
          workerId: cmd.workerId,
          executorKind: 'queue_worker',
        })
      ) {
        return {
          result: {
            renewed: false,
            cancelRequested: task?.cancel_requested_at_ms != null,
            leaseExpiresAtMs: task?.lease_expires_at_ms ?? null,
          },
          alarmAtMs: undefined as number | null | undefined,
          nowMs,
        };
      }

      const extendMs = Math.max(1_000, Math.trunc(cmd.extendMs));
      const newLeaseExpiresAtMs = Math.min(nowMs + extendMs, task.deadline_at_ms ?? Infinity);
      this.deps.storage.sql.exec(
        `UPDATE tasks SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
        newLeaseExpiresAtMs,
        nowMs,
        task.id,
      );
      this.deps.storage.sql.exec(
        `UPDATE runs SET leased_until_ms = ?, updated_at_ms = ? WHERE id = ?`,
        newLeaseExpiresAtMs,
        nowMs,
        run.id,
      );
      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(nowMs);
      return {
        result: {
          renewed: true,
          cancelRequested: false,
          leaseExpiresAtMs: newLeaseExpiresAtMs,
        },
        alarmAtMs,
        nowMs,
      };
    });

    if (tx.alarmAtMs !== undefined && this.deps.hooks.syncPlatformAlarm !== undefined) {
      await this.deps.hooks.syncPlatformAlarm(tx.alarmAtMs, tx.nowMs);
    }
    return tx.result;
  }
}

function extractReadableText(raw: string | null): string {
  if (raw === null) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed['text'] === 'string') {
        return parsed['text'].trim();
      }
    } catch {
      // Treat as plain text.
    }
  }
  return trimmed;
}

function formatProactiveOutcomeMessage(input: {
  readonly title: string;
  readonly deliveryMode: 'direct_reminder' | 'model_brief';
  readonly summaryText: string | null;
  readonly detailText: string | null;
}): string {
  const detail = extractReadableText(input.detailText);
  const summary = extractReadableText(input.summaryText);
  const body = detail.length > 0 ? detail : summary;
  const maxTextBytes = 8_000;
  let formatted: string;
  if (input.deliveryMode === 'direct_reminder') {
    formatted =
      body.length > 0 && body !== input.title
        ? `Reminder: ${input.title}\n\n${body}`
        : `Reminder: ${input.title}`;
  } else {
    formatted = body.length > 0 ? `**${input.title}**\n\n${body}` : `**${input.title}**`;
  }
  return formatted.length > maxTextBytes ? `${formatted.slice(0, maxTextBytes - 1)}…` : formatted;
}

function describeProactiveFailureReason(reasonCode: string): string {
  switch (reasonCode) {
    case 'budget_exceeded':
    case 'budget_halted':
      return 'the daily model budget limit was reached';
    case 'model_unauthorized_tenant':
      return 'model execution is not enabled for this account';
    case 'recurring_real_model_unauthorized':
      return 'recurring AI briefs are not enabled for this account';
    case 'model_timeout':
    case 'TIMEOUT':
    case 'lease_expired':
      return 'execution timed out before completing';
    case 'model_unavailable':
    case 'PROVIDER_UNAVAILABLE':
    case 'model_gateway_unavailable':
    case 'JOB_UNAVAILABLE':
      return 'the model provider was temporarily unavailable';
    default:
      return 'execution did not complete';
  }
}

function formatProactiveFailureMessage(input: {
  readonly title: string;
  readonly kind: ProactiveScheduleKind;
  readonly reasonCode: string;
}): string {
  const kindLabel =
    input.kind === 'follow_up' ? 'follow-up' : input.kind === 'brief' ? 'brief' : 'reminder';
  const reasonText = describeProactiveFailureReason(input.reasonCode);
  const formatted = `Could not deliver "**${input.title}**" — ${reasonText}. Open Schedules to review or reschedule this ${kindLabel}.`;
  return formatted.length > 8_000 ? `${formatted.slice(0, 7_999)}…` : formatted;
}

function buildClaimAttemptContextFields<TExtra extends Record<string, unknown>>(
  attempt: ModelAttemptRow | null,
  subjectCreatedAtMs: number,
  extra: TExtra & {
    readonly entityKind: 'turn' | 'task';
    readonly entityId: string;
    readonly fallbackOperationId: string;
  },
): Record<string, unknown> {
  const sendStartedAtMs = attempt?.send_started_at_ms ?? null;
  const sendAuthorizingAtMs = attempt?.send_authorizing_at_ms ?? null;
  const sendState =
    sendStartedAtMs !== null
      ? 'sent'
      : sendAuthorizingAtMs !== null
        ? 'authorizing_unknown'
        : 'unsent';

  return {
    ...extra,
    operationId: attempt?.operation_id ?? extra.fallbackOperationId,
    attemptNo: attempt?.attempt_no ?? 1,
    ...(attempt !== null ? { attemptId: String(attempt.attempt_no) } : {}),
    sendStartedAtMs,
    sendAuthorizingAtMs,
    sendState,
    budgetMode: attempt?.budget_mode ?? 'disabled_echo_only',
    globalGrantId: attempt?.global_grant_id ?? null,
    reservedMicroUsd: attempt?.reserved_micro_usd ?? 0,
    utcDay: attempt?.utc_day ?? toUtcDayString(subjectCreatedAtMs),
  };
}
