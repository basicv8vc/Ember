import { randomUUID } from 'node:crypto';
import {
  parseApprovalDecisionRequestDto,
  toApprovalDecisionReceiptDto,
  toApprovalViewDto,
} from '@ember/contracts';
import {
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  APPROVAL_TERMINAL_STATUSES,
  APPROVAL_TRANSITION_TABLE,
  InvalidArgumentError,
  InvalidStateTransitionError,
  assertApprovalStatusTransition,
  canTransitionApprovalStatus,
  isApprovalDecision,
  isApprovalStatus,
  isApprovalTerminalStatus,
  targetStatusForDecision,
  type ApprovalStatus,
} from '@ember/domain';
import { describe, expect, it } from 'vitest';

const APPROVED_APPROVAL_TRANSITIONS = [
  ['pending', 'approved'],
  ['pending', 'denied'],
  ['pending', 'expired'],
] as const satisfies readonly (readonly [ApprovalStatus, ApprovalStatus])[];

const approvedKeys = new Set(APPROVED_APPROVAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

const ALL_APPROVAL_PAIRS = APPROVAL_STATUSES.flatMap((from) =>
  APPROVAL_STATUSES.map((to) => [from, to] as const),
);

const DISALLOWED_APPROVAL_PAIRS = ALL_APPROVAL_PAIRS.filter(
  ([from, to]) => !approvedKeys.has(`${from}->${to}`),
);

describe('Approval state machine — legal transitions', () => {
  it('publishes the closed approval status and decision sets', () => {
    expect(APPROVAL_STATUSES).toEqual(['pending', 'approved', 'denied', 'expired']);
    expect(APPROVAL_TERMINAL_STATUSES).toEqual(['approved', 'denied', 'expired']);
    expect(APPROVAL_DECISIONS).toEqual(['approve', 'deny']);
  });

  it.each(APPROVED_APPROVAL_TRANSITIONS)('allows %s → %s', (from, to) => {
    expect(canTransitionApprovalStatus(from, to)).toBe(true);
    expect(() => assertApprovalStatusTransition(from, to)).not.toThrow();
  });

  it('matches the published transition table', () => {
    const actualEdges = APPROVAL_STATUSES.flatMap((from) =>
      APPROVAL_TRANSITION_TABLE[from].map((to) => `${from}->${to}`),
    ).sort();

    expect(actualEdges).toEqual([...approvedKeys].sort());
  });

  it.each(DISALLOWED_APPROVAL_PAIRS)(
    'rejects %s → %s with INVALID_STATE_TRANSITION',
    (from, to) => {
      expect(canTransitionApprovalStatus(from, to)).toBe(false);
      expect(() => assertApprovalStatusTransition(from, to)).toThrowError(
        InvalidStateTransitionError,
      );
    },
  );

  it('classifies terminal and non-terminal statuses and decisions', () => {
    expect(isApprovalTerminalStatus('pending')).toBe(false);
    expect(isApprovalTerminalStatus('approved')).toBe(true);
    expect(isApprovalTerminalStatus('denied')).toBe(true);
    expect(isApprovalTerminalStatus('expired')).toBe(true);

    expect(isApprovalStatus('pending')).toBe(true);
    expect(isApprovalStatus('unknown')).toBe(false);
    expect(isApprovalDecision('approve')).toBe(true);
    expect(isApprovalDecision('deny')).toBe(true);
    expect(isApprovalDecision('expire')).toBe(false);

    expect(targetStatusForDecision('approve')).toBe('approved');
    expect(targetStatusForDecision('deny')).toBe('denied');
  });
});

describe('Approval contract DTO schemas', () => {
  it('parses valid approve and deny decision bodies and rejects unknown keys', () => {
    expect(parseApprovalDecisionRequestDto({ decision: 'approve' })).toBe('approve');
    expect(parseApprovalDecisionRequestDto({ decision: 'deny' })).toBe('deny');

    expect(() =>
      parseApprovalDecisionRequestDto({ decision: 'approve', tenant_id: randomUUID() }),
    ).toThrowError(InvalidArgumentError);
    expect(() => parseApprovalDecisionRequestDto({ decision: 'expire' })).toThrowError(
      InvalidArgumentError,
    );
    expect(() => parseApprovalDecisionRequestDto({})).toThrowError(InvalidArgumentError);
  });

  it('maps ApprovalView and ApprovalDecisionReceipt to strict snake_case DTOs', () => {
    const approvalId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    const actionDigest = 'a'.repeat(64);
    const now = '2026-10-30T00:00:00.000Z';

    const viewDto = toApprovalViewDto({
      approvalId,
      taskId,
      runId,
      leaseEpoch: 1,
      actionDigest,
      status: 'pending',
      expiresAt: '2026-10-30T00:15:00.000Z',
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(viewDto).toEqual({
      approval_id: approvalId,
      task_id: taskId,
      run_id: runId,
      lease_epoch: 1,
      action_digest: actionDigest,
      status: 'pending',
      expires_at: '2026-10-30T00:15:00.000Z',
      decided_at: null,
      created_at: now,
      updated_at: now,
    });

    const receiptDto = toApprovalDecisionReceiptDto({
      approvalId,
      taskId,
      status: 'approved',
      taskStatus: 'queued',
      decidedAt: now,
      replayed: false,
    });

    expect(receiptDto).toEqual({
      approval_id: approvalId,
      task_id: taskId,
      status: 'approved',
      task_status: 'queued',
      decided_at: now,
      replayed: false,
    });
  });
});
