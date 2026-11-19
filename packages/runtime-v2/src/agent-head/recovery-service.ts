import { type Id, isTerminalTaskStatus } from '@ember/domain';
import { V2_B1_COMPAT_CONSTANTS, V2_TIMING_LIMITS } from '../contracts/constants.js';
import type { GlobalBudgetAuthority } from '../contracts/global-budget.js';
import {
  computePreDeadlineRetryAtMs,
  validateDispatchEnvelope,
  type V2DispatchEnvelope,
} from '../recovery/envelope.js';
import type { AgentHeadRecoveryPort, AuthoritativeBusinessPort } from '../recovery/ports.js';
import type {
  OrdinaryOutboxEntityKind,
  V2DispatchOutboxRow,
  V2ScheduleRow,
} from '../recovery/schema.js';
import type { DurableObjectStorageLike } from '../storage.js';
import { settleLocalAttemptAndEnqueueSync, type LocalBudgetCeilings } from './budget.js';
import type { DefaultEventRuntimePorts } from './default-event-ports.js';
import {
  assertHeadScopeSync,
  earliestBusinessAlarmAtMsSync,
  getHeadMetaSync,
  getLatestRunForTaskSync,
  getTaskRowSync,
  getTurnRowSync,
  insertEmberMessageSync,
  listReservedAttemptsSync,
  readRecentTurnContextSync,
  sqlExecAll,
  sqlExecMaybe,
} from './queries.js';
import type { AssistantTurnRow, TaskRow } from './schema.js';
import { toUtcDayString } from './state-machine.js';

export interface RecoveryServiceDeps {
  readonly storage: DurableObjectStorageLike;
  readonly eventPorts: DefaultEventRuntimePorts;
  readonly globalBudget: GlobalBudgetAuthority;
  readonly nowMs: () => number;
  readonly idFactory?: () => Id;
  readonly localCeilings?: LocalBudgetCeilings;
  readonly flushBudgetSyncAfterCommit?: () => Promise<void>;
}

/**
 * Implements `AuthoritativeBusinessPort` (sync DO SQLite contract for Agent B) and
 * `AgentHeadRecoveryPort` (Sweeper reconciliation + Durable Queue worker claim/commit).
 */
export class AgentHeadRecoveryService implements AuthoritativeBusinessPort, AgentHeadRecoveryPort {
  private readonly newId: () => Id;

  constructor(private readonly deps: RecoveryServiceDeps) {
    this.newId = deps.idFactory ?? (() => globalThis.crypto.randomUUID());
  }

  earliestRequiredDiscoveryAtMsSync(_nowMs: number): number | null {
    const sql = this.deps.storage.sql;
    const bizDue = earliestBusinessAlarmAtMsSync(sql);
    const outboxDue = sql
      .exec<{ readonly m: number | null }>(
        `SELECT MIN(next_attempt_at_ms) AS m
           FROM v2_dispatch_outbox
          WHERE state IN ('pending', 'enqueued', 'dead_lettered')`,
      )
      .one().m;
    const schedDue = sql
      .exec<{ readonly m: number | null }>(
        `SELECT MIN(next_fire_at_ms) AS m
           FROM v2_schedules
          WHERE status = 'active'`,
      )
      .one().m;

    const candidates = [bizDue, outboxDue, schedDue].filter((v): v is number => v !== null);
    if (candidates.length === 0) {
      return null;
    }
    return Math.min(...candidates) + V2_TIMING_LIMITS.d1RecoveryGraceMs;
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
            deadline_at_ms <= ?
            OR cancel_requested_at_ms IS NOT NULL
            OR (lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?)
          )
        ORDER BY deadline_at_ms ASC, id ASC
        LIMIT ?`,
      nowMs,
      nowMs,
      limit,
    );

    for (const turn of dueTurns) {
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
        deadlineAtMs: turn.deadline_at_ms,
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
            OR (status IN ('queued', 'retryable_failed') AND next_run_at_ms <= ?)
          )
        ORDER BY COALESCE(deadline_at_ms, next_run_at_ms) ASC, id ASC
        LIMIT ?`,
      nowMs,
      nowMs,
      nowMs,
      remaining,
    );

    for (const task of dueTasks) {
      const deadlineAtMs = task.deadline_at_ms ?? task.next_run_at_ms;
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
        deadlineAtMs,
      });
    }

    return actions;
  }

  convergeDueBusinessItemSync(targetKind: 'turn' | 'task', targetId: string, nowMs: number): void {
    const meta = getHeadMetaSync(this.deps.storage.sql);
    if (meta === null) {
      return;
    }

    if (targetKind === 'turn') {
      this.convergeDueTurnSync(meta.tenant_id, meta.agent_id, targetId, nowMs);
    } else {
      this.convergeDueTaskSync(meta.tenant_id, meta.agent_id, targetId, nowMs);
    }

    this.deps.eventPorts.recomputeAlarmSync(nowMs);
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
        coordinator: this.deps.eventPorts,
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
      this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
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
      this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
      return;
    }

    // Active lease expired strictly before total deadline
    if (turn.lease_expires_at_ms !== null && nowMs >= turn.lease_expires_at_ms) {
      const { anyUncertain } = this.settleOpenAttemptsForSubjectSync(
        tenantId,
        agentId,
        'turn',
        turn.id,
        'not_sent',
        'model_unavailable',
        nowMs,
      );

      // Honest degradation: uncertain outbound call with NO resumable provider handle must never be blindly replayed
      const hasResumableHandle =
        turn.provider_job_handle !== null && turn.provider_job_handle.length > 0;
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
        this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
        return;
      }

      const retryDecision = computePreDeadlineRetryAtMs(nowMs, turn.deadline_at_ms);
      if (!retryDecision.shouldRetry) {
        // <= 1_000 ms remaining: no new dispatch, let single alarm converge at deadline_at_ms
        sql.exec(
          `UPDATE assistant_turns
              SET lease_owner = NULL,
                  lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE id = ?`,
          nowMs,
          turn.id,
        );
        this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
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
      this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
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
      this.deps.eventPorts.enqueueDurableOutboxSync({
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

  private convergeDueTaskSync(tenantId: Id, agentId: Id, taskId: string, nowMs: number): void {
    const sql = this.deps.storage.sql;
    const task = getTaskRowSync(sql, taskId);
    if (task === null || isTerminalTaskStatus(task.status)) {
      return;
    }

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
      this.deps.eventPorts.cancelEntityOutboxSync('task', task.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', task.id, nowMs);
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
      this.deps.eventPorts.cancelEntityOutboxSync('task', task.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', task.id, nowMs);
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
        this.deps.eventPorts.cancelEntityOutboxSync('task', task.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', task.id, nowMs);
        return;
      }

      const deadline = task.deadline_at_ms ?? nowMs + 60_000;
      const retryDecision = computePreDeadlineRetryAtMs(nowMs, deadline, 5_000);
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
        this.deps.eventPorts.cancelEntityOutboxSync('task', task.id, nowMs);
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
      this.deps.eventPorts.cancelEntityOutboxSync('task', task.id, nowMs);
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
      this.deps.eventPorts.enqueueDurableOutboxSync({
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

    // schedule_occurrence: entityId is `${scheduleId}:${occurrenceSeq}` or existing task/turn linked
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
    if (sched === null || sched.status !== 'active') {
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

    const taskId = this.newId();
    const inputJson = JSON.stringify({
      prompt: `Scheduled execution for ${sched.source_kind}:${sched.source_id}`,
    });
    sql.exec(
      `INSERT INTO tasks (
         id, kind, title, input_json, digest, idempotency_key, status,
         execution_path, execution_target, attempt_count, max_attempts,
         lease_epoch, next_run_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, 'mock.chat', ?, ?, ?, ?, 'queued', 'standard', 'cloud', 0, 3, 1, ?, ?, ?)`,
      taskId,
      `Scheduled ${sched.source_kind}`,
      inputJson,
      idempotencyKey,
      idempotencyKey,
      nowMs,
      nowMs,
      nowMs,
    );
    sql.exec(
      `INSERT INTO task_events (id, task_id, sequence, phase, payload_json, trace_id, occurred_at_ms)
       VALUES (?, ?, 1, 'accepted', ?, ?, ?)`,
      this.newId(),
      taskId,
      JSON.stringify({ taskKind: 'mock.chat', replayed: false }),
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
    this.deps.eventPorts.enqueueDurableOutboxSync({
      outboxId,
      entityKind: 'task',
      entityId: taskId,
      queueName: 'agent_task',
      payloadJson: JSON.stringify(envelope),
      fenceEpoch: 1,
      nextAttemptAtMs: nowMs,
    });
  }

  async reconcileFromRegistry(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly expectedGen: number;
    readonly nowMs: number;
  }): Promise<
    | {
        readonly action: 'repair_ensure';
        readonly generation: number;
        readonly recoveryAtMs: number;
      }
    | { readonly action: 'noop_stale'; readonly currentGeneration: number }
    | { readonly action: 'retire'; readonly retireUpToGen: number }
    | {
        readonly action: 'postpone';
        readonly expectedPrevGen: number;
        readonly newGeneration: number;
        readonly nextRecoveryAtMs: number;
      }
    | { readonly action: 'keep_armed'; readonly currentGeneration: number }
  > {
    const result = this.deps.storage.transactionSync(() => {
      assertHeadScopeSync(this.deps.storage.sql, cmd.tenantId, cmd.agentId);

      const earliestDiscovery = this.earliestRequiredDiscoveryAtMsSync(cmd.nowMs);
      const cov = this.deps.eventPorts.ensureCoverageRowSync(cmd.nowMs);

      // Independent repair priority (V2-M0-A §8.3): never return noop_stale if obligations exist
      // and coverage is missing/registering/insufficient, even when expectedGen lags cov.generation.
      if (earliestDiscovery !== null) {
        const needsRepair =
          cov.coverage_state !== 'covered' ||
          cov.pending_kind !== null ||
          cov.covered_recovery_at_ms === null ||
          cov.covered_recovery_at_ms > earliestDiscovery;

        if (needsRepair) {
          const planned = this.deps.eventPorts.fastForwardEnsureSync(
            cmd.expectedGen,
            earliestDiscovery,
            cmd.nowMs,
          );
          this.deps.eventPorts.recomputeAlarmSync(cmd.nowMs);
          return {
            action: 'repair_ensure' as const,
            generation: planned.generation,
            recoveryAtMs: planned.targetAtMs,
          };
        }

        if (cov.covered_recovery_at_ms !== null && earliestDiscovery > cov.covered_recovery_at_ms) {
          if (cmd.nowMs >= cov.covered_recovery_at_ms) {
            const postponed = this.deps.eventPorts.planPostponeSync(
              cmd.expectedGen,
              earliestDiscovery,
              cmd.nowMs,
            );
            this.deps.eventPorts.recomputeAlarmSync(cmd.nowMs);
            return {
              action: 'postpone' as const,
              expectedPrevGen: postponed.expectedPrevGen,
              newGeneration: postponed.newGeneration,
              nextRecoveryAtMs: postponed.nextRecoveryAtMs,
            };
          }
        }

        this.deps.eventPorts.recomputeAlarmSync(cmd.nowMs);
        if (cmd.expectedGen < cov.generation && cov.coverage_state === 'covered') {
          return { action: 'keep_armed' as const, currentGeneration: cov.generation };
        }
        return { action: 'keep_armed' as const, currentGeneration: cov.generation };
      }

      // Zero committed obligations (including zero pending budget_sync): safe to retire
      if (cov.coverage_state === 'uncovered' && cmd.expectedGen < cov.generation) {
        this.deps.eventPorts.recomputeAlarmSync(cmd.nowMs);
        return { action: 'retire' as const, retireUpToGen: cov.generation };
      }

      const retired = this.deps.eventPorts.planRetireSync(cmd.expectedGen, cmd.nowMs);
      this.deps.eventPorts.recomputeAlarmSync(cmd.nowMs);
      return { action: 'retire' as const, retireUpToGen: retired.retireUpToGen };
    });

    await this.deps.eventPorts.flushPendingAlarmOp();
    return result;
  }

  confirmRegistryPlan(cmd: {
    readonly generation: number;
    readonly actualRecoveryAtMs: number | null;
    readonly applied: boolean;
  }): Promise<{ readonly confirmed: boolean }> {
    const nowMs = this.deps.nowMs();
    const confirmed = this.deps.storage.transactionSync(() => {
      const earliest = this.earliestRequiredDiscoveryAtMsSync(nowMs);
      if (earliest === null) {
        return false;
      }
      return this.deps.eventPorts.confirmCoverageSync({
        generation: cmd.generation,
        actualRecoveryAtMs: cmd.actualRecoveryAtMs,
        applied: cmd.applied,
        earliestRequiredRecoveryMs: earliest,
        nowMs,
      });
    });
    return Promise.resolve({ confirmed });
  }

  async claimDurableWork(cmd: {
    readonly envelope: V2DispatchEnvelope;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<
    | {
        readonly kind: 'claimed';
        readonly targetKind: 'turn' | 'task';
        readonly targetId: string;
        readonly leaseEpoch: number;
        readonly leaseExpiresAtMs: number;
        readonly contextJson: string;
      }
    | {
        readonly kind: 'not_claimed';
        readonly reason:
          | 'terminal'
          | 'lease_active'
          | 'deadline_expired'
          | 'not_found'
          | 'stale_or_invalid_envelope';
      }
  > {
    const envCheck = validateDispatchEnvelope(cmd.envelope);
    if (!envCheck.ok) {
      return { kind: 'not_claimed', reason: 'stale_or_invalid_envelope' };
    }
    const env = envCheck.envelope;
    const nowMs = this.deps.nowMs();

    const outcome = this.deps.storage.transactionSync(() => {
      const meta = getHeadMetaSync(this.deps.storage.sql);
      if (meta === null || meta.tenant_id !== env.tenantId || meta.agent_id !== env.agentId) {
        return { kind: 'not_claimed' as const, reason: 'stale_or_invalid_envelope' as const };
      }

      const outbox = sqlExecMaybe<V2DispatchOutboxRow>(
        this.deps.storage.sql,
        `SELECT * FROM v2_dispatch_outbox WHERE outbox_id = ?`,
        env.eventId,
      );

      if (outbox === null) {
        return { kind: 'not_claimed' as const, reason: 'not_found' as const };
      }

      if (
        outbox.entity_kind === 'budget_sync' ||
        outbox.queue_name === null ||
        outbox.entity_kind !== env.entityKind ||
        outbox.entity_id !== env.entityId ||
        outbox.queue_name !== env.queueName ||
        outbox.fence_epoch !== env.fenceEpoch
      ) {
        return { kind: 'not_claimed' as const, reason: 'stale_or_invalid_envelope' as const };
      }

      if (outbox.state === 'acked' || outbox.state === 'cancelled') {
        return { kind: 'not_claimed' as const, reason: 'terminal' as const };
      }

      const target = this.inspectOutboxTargetSync(env.entityKind, env.entityId);
      if (!target.exists || target.targetKind === null || target.targetId === null) {
        return { kind: 'not_claimed' as const, reason: 'not_found' as const };
      }

      // Reject BOTH stale (< currentLeaseEpoch) AND future (> currentLeaseEpoch) envelopes
      if (env.fenceEpoch !== target.currentLeaseEpoch) {
        return { kind: 'not_claimed' as const, reason: 'stale_or_invalid_envelope' as const };
      }

      if (target.isTerminal) {
        this.deps.eventPorts.ackOutboxSync(outbox.outbox_id, outbox.fence_epoch, nowMs);
        this.deps.eventPorts.recomputeAlarmSync(nowMs);
        return { kind: 'not_claimed' as const, reason: 'terminal' as const };
      }

      if (target.cancelRequested) {
        this.convergeDueBusinessItemSync(target.targetKind, target.targetId, nowMs);
        return { kind: 'not_claimed' as const, reason: 'terminal' as const };
      }

      if (nowMs >= target.deadlineAtMs) {
        this.convergeDueBusinessItemSync(target.targetKind, target.targetId, nowMs);
        return { kind: 'not_claimed' as const, reason: 'deadline_expired' as const };
      }

      if (target.targetKind === 'turn') {
        const turn = getTurnRowSync(this.deps.storage.sql, target.targetId)!;
        if (turn.lease_expires_at_ms !== null && nowMs < turn.lease_expires_at_ms) {
          return { kind: 'not_claimed' as const, reason: 'lease_active' as const };
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
        this.deps.eventPorts.ackOutboxSync(outbox.outbox_id, outbox.fence_epoch, nowMs);
        this.deps.eventPorts.recomputeAlarmSync(nowMs);

        const context = readRecentTurnContextSync(this.deps.storage.sql, turn.conversation_id);
        return {
          kind: 'claimed' as const,
          targetKind: 'turn' as const,
          targetId: turn.id,
          leaseEpoch: nextEpoch,
          leaseExpiresAtMs,
          contextJson: JSON.stringify({
            turnId: turn.id,
            conversationId: turn.conversation_id,
            providerJobHandle: turn.provider_job_handle,
            deadlineAtMs: turn.deadline_at_ms,
            utcDay: toUtcDayString(nowMs),
            context,
          }),
        };
      }

      // targetKind === 'task'
      const task = getTaskRowSync(this.deps.storage.sql, target.targetId)!;
      if (task.lease_expires_at_ms !== null && nowMs < task.lease_expires_at_ms) {
        return { kind: 'not_claimed' as const, reason: 'lease_active' as const };
      }
      if (task.status === 'waiting_approval') {
        return { kind: 'not_claimed' as const, reason: 'lease_active' as const };
      }

      const nextEpoch = task.lease_epoch + 1;
      const nextAttempt = task.attempt_count + 1;
      const leaseExpiresAtMs =
        task.deadline_at_ms === null
          ? nowMs + cmd.leaseMs
          : Math.min(nowMs + cmd.leaseMs, task.deadline_at_ms);
      const runId = this.newId();

      this.deps.storage.sql.exec(
        `INSERT INTO runs (
           id, task_id, attempt, lease_epoch, status, worker_id, executor_kind,
           leased_until_ms, provider_job_handle, started_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 'running', ?, 'queue_worker', ?, ?, ?, ?)`,
        runId,
        task.id,
        nextAttempt,
        nextEpoch,
        cmd.workerId,
        leaseExpiresAtMs,
        task.provider_job_handle,
        nowMs,
        nowMs,
      );
      this.deps.storage.sql.exec(
        `UPDATE tasks
            SET status = 'running',
                attempt_count = ?,
                current_run_id = ?,
                lease_epoch = ?,
                lease_expires_at_ms = ?,
                updated_at_ms = ?
          WHERE id = ?`,
        nextAttempt,
        runId,
        nextEpoch,
        leaseExpiresAtMs,
        nowMs,
        task.id,
      );
      this.deps.eventPorts.ackOutboxSync(outbox.outbox_id, outbox.fence_epoch, nowMs);
      this.deps.eventPorts.recomputeAlarmSync(nowMs);

      return {
        kind: 'claimed' as const,
        targetKind: 'task' as const,
        targetId: task.id,
        leaseEpoch: nextEpoch,
        leaseExpiresAtMs,
        contextJson: JSON.stringify({
          taskId: task.id,
          runId,
          attempt: nextAttempt,
          kind: task.kind,
          inputJson: task.input_json,
          providerJobHandle: task.provider_job_handle,
          deadlineAtMs: task.deadline_at_ms,
        }),
      };
    });

    await this.deps.eventPorts.flushPendingAlarmOp();
    return outcome;
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
    const nowMs = this.deps.nowMs();
    const accepted = this.deps.storage.transactionSync(() => {
      const meta = getHeadMetaSync(this.deps.storage.sql);
      if (meta === null || meta.tenant_id !== cmd.tenantId || meta.agent_id !== cmd.agentId) {
        return false;
      }

      if (cmd.entityType === 'turn') {
        const turn = getTurnRowSync(this.deps.storage.sql, cmd.entityId);
        if (
          turn === null ||
          turn.status !== 'running' ||
          turn.lease_epoch !== cmd.leaseEpoch ||
          turn.lease_owner !== cmd.workerId ||
          turn.lease_expires_at_ms === null ||
          nowMs >= turn.lease_expires_at_ms ||
          nowMs >= turn.deadline_at_ms ||
          turn.cancel_requested_at_ms !== null
        ) {
          return false;
        }
        const payload = cmd.outcome as {
          readonly status?: string;
          readonly text?: string;
          readonly modelLabel?: string;
          readonly simulated?: boolean;
          readonly failureReason?: 'timeout' | 'internal_error';
        };
        if (
          payload?.status === 'completed' &&
          typeof payload.text === 'string' &&
          payload.text.length > 0
        ) {
          const { messageId } = insertEmberMessageSync({
            sql: this.deps.storage.sql,
            messageId: this.newId(),
            conversationId: turn.conversation_id,
            text: payload.text,
            modelLabel: payload.modelLabel ?? V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
            simulated: payload.simulated ?? true,
            nowMs,
          });
          this.deps.storage.sql.exec(
            `UPDATE assistant_turns
                SET status = 'completed',
                    response_message_id = ?,
                    lease_owner = NULL,
                    lease_expires_at_ms = NULL,
                    updated_at_ms = ?
              WHERE id = ?`,
            messageId,
            nowMs,
            turn.id,
          );
          this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
          this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
          this.deps.eventPorts.recomputeAlarmSync(nowMs);
          return true;
        }

        const { messageId } = insertEmberMessageSync({
          sql: this.deps.storage.sql,
          messageId: this.newId(),
          conversationId: turn.conversation_id,
          text: V2_B1_COMPAT_CONSTANTS.failureAssistantMessageText,
          modelLabel: V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
          simulated: true,
          nowMs,
        });
        this.deps.storage.sql.exec(
          `UPDATE assistant_turns
              SET status = 'failed',
                  failure_reason = ?,
                  response_message_id = ?,
                  lease_owner = NULL,
                  lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE id = ?`,
          payload?.failureReason === 'timeout' ? 'timeout' : 'internal_error',
          messageId,
          nowMs,
          turn.id,
        );
        this.deps.eventPorts.cancelEntityOutboxSync('turn', turn.id, nowMs);
        this.deps.eventPorts.cancelEntityOutboxSync('handoff', turn.id, nowMs);
        this.deps.eventPorts.recomputeAlarmSync(nowMs);
        return true;
      }

      // entityType === 'task'
      const task = getTaskRowSync(this.deps.storage.sql, cmd.entityId);
      const run = task === null ? null : getLatestRunForTaskSync(this.deps.storage.sql, task.id);
      if (
        task === null ||
        run === null ||
        task.status !== 'running' ||
        run.status !== 'running' ||
        task.lease_epoch !== cmd.leaseEpoch ||
        run.lease_epoch !== cmd.leaseEpoch ||
        run.worker_id !== cmd.workerId ||
        task.lease_expires_at_ms === null ||
        nowMs >= task.lease_expires_at_ms ||
        (task.deadline_at_ms !== null && nowMs >= task.deadline_at_ms) ||
        task.cancel_requested_at_ms !== null
      ) {
        return false;
      }

      const payload = cmd.outcome as {
        readonly status?: 'completed' | 'failed';
        readonly summaryText?: string | null;
        readonly detailText?: string | null;
        readonly modelLabel?: string;
        readonly simulated?: boolean;
        readonly truncated?: boolean;
        readonly reasonCode?: string;
      };
      const isCompleted = payload?.status !== 'failed';
      this.deps.storage.sql.exec(
        `UPDATE runs
            SET status = ?,
                finished_at_ms = ?,
                updated_at_ms = ?
          WHERE id = ?`,
        isCompleted ? 'succeeded' : 'failed_terminal',
        nowMs,
        nowMs,
        run.id,
      );
      this.deps.storage.sql.exec(
        `INSERT INTO task_results (
           task_id, summary_text, detail_text, model_label, simulated, truncated, reason_code, produced_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO NOTHING`,
        task.id,
        payload?.summaryText ?? null,
        payload?.detailText ?? null,
        payload?.modelLabel ?? V2_B1_COMPAT_CONSTANTS.simulatedModelLabel,
        (payload?.simulated ?? true) ? 1 : 0,
        (payload?.truncated ?? false) ? 1 : 0,
        payload?.reasonCode ?? (isCompleted ? 'ok' : 'internal_error'),
        nowMs,
      );
      this.deps.storage.sql.exec(
        `UPDATE tasks
            SET status = ?,
                lease_expires_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ?`,
        isCompleted ? 'completed' : 'failed',
        nowMs,
        task.id,
      );
      this.deps.eventPorts.cancelEntityOutboxSync('task', task.id, nowMs);
      this.deps.eventPorts.cancelEntityOutboxSync('handoff', task.id, nowMs);
      this.deps.eventPorts.recomputeAlarmSync(nowMs);
      return true;
    });

    await this.deps.eventPorts.flushPendingAlarmOp();
    if (this.deps.flushBudgetSyncAfterCommit !== undefined) {
      await this.deps.flushBudgetSyncAfterCommit();
    }
    return { accepted };
  }
}
