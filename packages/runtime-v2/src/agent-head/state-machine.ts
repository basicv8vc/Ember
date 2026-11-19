import {
  canTransitionApprovalStatus,
  canTransitionRun,
  canTransitionTask,
  InvalidStateTransitionError,
  type ApprovalStatus,
  type RunStatus,
  type TaskKind,
  type TaskStatus,
} from '@ember/domain';
import { V2_BUDGET_LIMITS } from '../contracts/constants.js';
import type { HandoffTurnRequest } from '../contracts/agent-head-rpc.js';
import type { AssistantTurnRow, ModelAttemptRow, TaskRow } from './schema.js';
import type { TurnStatus } from './schema.js';

export const TURN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export const TURN_STATUSES = ['running', ...TURN_TERMINAL_STATUSES] as const;

export const TURN_TRANSITION_TABLE: Readonly<Record<TurnStatus, readonly TurnStatus[]>> =
  Object.freeze({
    running: ['running', 'completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  });

export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return status !== 'running';
}

export function canTransitionTurn(from: TurnStatus, to: TurnStatus): boolean {
  return TURN_TRANSITION_TABLE[from].includes(to);
}

export function assertTurnTransition(from: TurnStatus, to: TurnStatus): void {
  if (!canTransitionTurn(from, to)) {
    throw new InvalidStateTransitionError('task', from, to);
  }
}

export {
  canTransitionTask,
  canTransitionRun,
  canTransitionApprovalStatus,
  type TaskStatus,
  type RunStatus,
  type ApprovalStatus,
};

export function toUtcDayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function toIsoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

export type TurnFenceCheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'fenced' | 'expired' | 'cancelled' | 'terminal';
    };

/**
 * Evaluates the 4-dimensional Run / Lease / Epoch fencing invariants per V2-M0-A §3.3:
 * 1. Subject is active (`running`), and if `requireNotCancelled`, `cancel_requested_at_ms === null`.
 * 2. Exact match on `lease_epoch` and `lease_owner`.
 * 3. Neither `lease_expires_at_ms` nor `deadline_at_ms` has expired against DO clock `nowMs`.
 */
export function evaluateTurnFence(
  turn: AssistantTurnRow,
  expectedEpoch: number,
  expectedOwner: string,
  nowMs: number,
  options: { readonly allowCancelRequested?: boolean } = {},
): TurnFenceCheckResult {
  if (turn.status !== 'running') {
    return { ok: false, reason: 'terminal' };
  }
  if (turn.lease_epoch !== expectedEpoch || turn.lease_owner !== expectedOwner) {
    return { ok: false, reason: 'fenced' };
  }
  if (turn.lease_expires_at_ms === null || nowMs >= turn.lease_expires_at_ms) {
    return { ok: false, reason: 'expired' };
  }
  if (nowMs >= turn.deadline_at_ms) {
    return { ok: false, reason: 'expired' };
  }
  if (!options.allowCancelRequested && turn.cancel_requested_at_ms !== null) {
    return { ok: false, reason: 'cancelled' };
  }
  return { ok: true };
}

export type TaskFenceCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'fenced' | 'expired' | 'cancelled' | 'terminal' };

export function evaluateTaskFence(
  task: TaskRow,
  expectedEpoch: number,
  nowMs: number,
  options: { readonly allowCancelRequested?: boolean } = {},
): TaskFenceCheckResult {
  if (task.status !== 'running') {
    return { ok: false, reason: 'terminal' };
  }
  if (task.lease_epoch !== expectedEpoch) {
    return { ok: false, reason: 'fenced' };
  }
  if (task.lease_expires_at_ms === null || nowMs >= task.lease_expires_at_ms) {
    return { ok: false, reason: 'expired' };
  }
  if (task.deadline_at_ms !== null && nowMs >= task.deadline_at_ms) {
    return { ok: false, reason: 'expired' };
  }
  if (!options.allowCancelRequested && task.cancel_requested_at_ms !== null) {
    return { ok: false, reason: 'cancelled' };
  }
  return { ok: true };
}

/**
 * Evaluates all 7 authoritative gate conditions required before `handoffTurnToDurable`
 * transfers an active interactive lease to Durable Queue execution (V2-M0-A §6.2 Joint Review J4).
 */
export function evaluateTurnHandoffGate(input: {
  readonly turn: AssistantTurnRow;
  readonly req: HandoffTurnRequest;
  readonly activeAttempt: ModelAttemptRow | null;
  readonly nowMs: number;
}): boolean {
  const { turn, req, activeAttempt, nowMs } = input;

  // 1. Turn must still be running
  if (turn.status !== 'running') {
    return false;
  }
  // 2. Exact lease owner & epoch match
  if (turn.lease_owner !== req.leaseOwner || turn.lease_epoch !== req.leaseEpoch) {
    return false;
  }
  // 3. Lease must still be live (expired lease cannot handoff)
  if (turn.lease_expires_at_ms === null || nowMs >= turn.lease_expires_at_ms) {
    return false;
  }
  // 4. Total lifetime deadline must still be valid (never extended by handoff)
  if (nowMs >= turn.deadline_at_ms) {
    return false;
  }
  // 5. Cancellation flag must not be set
  if (turn.cancel_requested_at_ms !== null) {
    return false;
  }
  // 6. Conversation, attempt epoch & operation binding consistency
  if (turn.conversation_id !== req.conversationId) {
    return false;
  }
  if (activeAttempt !== null && activeAttempt.lease_epoch !== req.leaseEpoch) {
    return false;
  }
  // 7. Continuable only if a resumable provider job handle exists OR no outbound send occurred
  const hasHandle =
    (req.providerJobHandle !== undefined && req.providerJobHandle.length > 0) ||
    (turn.provider_job_handle !== null && turn.provider_job_handle.length > 0);
  const provablyUnsent =
    activeAttempt === null ||
    (activeAttempt.send_started_at_ms === null && activeAttempt.send_authorizing_at_ms === null);

  if (!hasHandle && !provablyUnsent) {
    return false;
  }

  return true;
}

export interface TaskModelLimitCheckInput {
  readonly taskKind: TaskKind;
  readonly existingTaskAttempts: number;
  readonly existingRunAttempts: number;
  readonly existingTaskCostMicroUsd: number;
  readonly candidateReserveMicroUsd: number;
}

export type TaskModelLimitCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'attempts_exhausted' | 'cost_ceiling_exceeded' };

/**
 * Enforces inherited V1 per-Task & per-Run model attempt and cumulative cost ceilings (V2-M0-A §5.2).
 */
export function checkTaskModelLimits(input: TaskModelLimitCheckInput): TaskModelLimitCheckResult {
  if (input.candidateReserveMicroUsd > V2_BUDGET_LIMITS.perAttemptMicroUsd) {
    return { allowed: false, reason: 'cost_ceiling_exceeded' };
  }

  if (input.taskKind === 'python.agent') {
    if (
      input.existingRunAttempts + 1 > V2_BUDGET_LIMITS.pythonAgentMaxLlmCallsPerRun ||
      input.existingTaskAttempts + 1 > V2_BUDGET_LIMITS.pythonAgentMaxLlmCallsPerTask
    ) {
      return { allowed: false, reason: 'attempts_exhausted' };
    }
    if (
      input.existingTaskCostMicroUsd + input.candidateReserveMicroUsd >
      V2_BUDGET_LIMITS.pythonAgentMaxTaskCostMicroUsd
    ) {
      return { allowed: false, reason: 'cost_ceiling_exceeded' };
    }
    return { allowed: true };
  }

  if (input.existingTaskAttempts + 1 > V2_BUDGET_LIMITS.maxModelAttemptsPerTask) {
    return { allowed: false, reason: 'attempts_exhausted' };
  }
  if (
    input.existingTaskCostMicroUsd + input.candidateReserveMicroUsd >
    V2_BUDGET_LIMITS.maxModelCostPerTaskMicroUsd
  ) {
    return { allowed: false, reason: 'cost_ceiling_exceeded' };
  }
  return { allowed: true };
}
