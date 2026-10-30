import { InvalidStateTransitionError } from './errors.js';
import {
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  APPROVAL_TERMINAL_STATUSES,
  type ApprovalDecision,
  type ApprovalStatus,
  type ApprovalTerminalStatus,
} from './types.js';

export const APPROVAL_TRANSITION_TABLE: Readonly<
  Record<ApprovalStatus, readonly ApprovalStatus[]>
> = Object.freeze({
  pending: Object.freeze(['approved', 'denied', 'expired'] as const),
  approved: Object.freeze([] as const),
  denied: Object.freeze([] as const),
  expired: Object.freeze([] as const),
});

const APPROVAL_STATUS_SET: ReadonlySet<string> = new Set(APPROVAL_STATUSES);
const APPROVAL_TERMINAL_SET: ReadonlySet<string> = new Set(APPROVAL_TERMINAL_STATUSES);
const APPROVAL_DECISION_SET: ReadonlySet<string> = new Set(APPROVAL_DECISIONS);

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === 'string' && APPROVAL_STATUS_SET.has(value);
}

export function isApprovalTerminalStatus(value: unknown): value is ApprovalTerminalStatus {
  return typeof value === 'string' && APPROVAL_TERMINAL_SET.has(value);
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && APPROVAL_DECISION_SET.has(value);
}

export function targetStatusForDecision(decision: ApprovalDecision): 'approved' | 'denied' {
  return decision === 'approve' ? 'approved' : 'denied';
}

export function canTransitionApprovalStatus(from: ApprovalStatus, to: ApprovalStatus): boolean {
  if (!isApprovalStatus(from) || !isApprovalStatus(to)) {
    return false;
  }

  return APPROVAL_TRANSITION_TABLE[from].includes(to);
}

export function assertApprovalStatusTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
): ApprovalStatus {
  if (!canTransitionApprovalStatus(from, to)) {
    throw new InvalidStateTransitionError('approval', from, to);
  }

  return to;
}
