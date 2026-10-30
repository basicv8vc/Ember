import { createHash, randomUUID } from 'node:crypto';
import {
  DomainError,
  InvalidStateTransitionError,
  targetStatusForDecision,
  type ApprovalDecision,
  type ApprovalDecisionReceipt,
  type ApprovalStatus,
  type ApprovalView,
  type AuthContext,
  type Id,
  type TaskStatus,
} from '@ember/domain';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import type { ApprovalHttpStore } from '../../apps/api/src/approvals/approval-store.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { createFakeTaskApi, FIXED_TIME } from './support/task-api-fakes.js';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const PRINCIPAL_A = randomUUID();
const PRINCIPAL_B = randomUUID();
const TOKEN_A = `token-${randomUUID()}`;
const TOKEN_B = `token-${randomUUID()}`;
const TASK_ID = randomUUID();
const RUN_ID = randomUUID();
const APPROVAL_ID = randomUUID();
const REQUEST_ID = 'req-approval-http';

interface StoredApproval {
  readonly tenantId: Id;
  approvalId: Id;
  taskId: Id;
  runId: Id;
  leaseEpoch: number;
  actionDigest: string;
  status: ApprovalStatus;
  taskStatus: TaskStatus;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function createFakeApprovalStore() {
  const rows = new Map<Id, StoredApproval>();

  const seed = (overrides: Partial<StoredApproval> = {}): StoredApproval => {
    const row: StoredApproval = {
      tenantId: TENANT_A,
      approvalId: APPROVAL_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      leaseEpoch: 1,
      actionDigest: createHash('sha256').update('deploy:prod').digest('hex'),
      status: 'pending',
      taskStatus: 'waiting_approval',
      expiresAt: '2026-10-30T01:00:00.000Z',
      decidedAt: null,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      ...overrides,
    };
    rows.set(row.approvalId, row);
    return row;
  };

  const store: ApprovalHttpStore = {
    get(ctx: AuthContext, approvalId: Id): Promise<ApprovalView | null> {
      const row = rows.get(approvalId);
      if (row === undefined || row.tenantId !== ctx.tenantId) {
        return Promise.resolve(null);
      }

      return Promise.resolve({
        approvalId: row.approvalId,
        taskId: row.taskId,
        runId: row.runId,
        leaseEpoch: row.leaseEpoch,
        actionDigest: row.actionDigest,
        status: row.status,
        expiresAt: row.expiresAt,
        decidedAt: row.decidedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    },

    decide(
      ctx: AuthContext,
      approvalId: Id,
      decision: ApprovalDecision,
    ): Promise<ApprovalDecisionReceipt> {
      const row = rows.get(approvalId);
      if (row === undefined || row.tenantId !== ctx.tenantId) {
        return Promise.reject(new DomainError('NOT_FOUND', 'approval not found'));
      }

      const desired = targetStatusForDecision(decision);
      const desiredTask: TaskStatus = decision === 'approve' ? 'queued' : 'failed';

      if (row.status === 'approved' || row.status === 'denied') {
        if (row.status === desired) {
          return Promise.resolve({
            approvalId: row.approvalId,
            taskId: row.taskId,
            status: row.status,
            taskStatus: row.taskStatus,
            decidedAt: row.decidedAt ?? FIXED_TIME,
            replayed: true,
          });
        }

        return Promise.reject(
          new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `approval ${row.approvalId} was already ${row.status}`,
          ),
        );
      }

      if (row.status === 'expired') {
        return Promise.reject(new InvalidStateTransitionError('approval', 'expired', desired));
      }

      if (row.taskStatus !== 'waiting_approval') {
        row.status = 'expired';
        return Promise.reject(new InvalidStateTransitionError('task', row.taskStatus, desiredTask));
      }

      row.status = desired;
      row.taskStatus = desiredTask;
      row.decidedAt = FIXED_TIME;
      row.updatedAt = FIXED_TIME;

      return Promise.resolve({
        approvalId: row.approvalId,
        taskId: row.taskId,
        status: desired,
        taskStatus: desiredTask,
        decidedAt: FIXED_TIME,
        replayed: false,
      });
    },
  };

  return { store, seed };
}

function createHarness() {
  const tasks = createFakeTaskApi();
  const approvals = createFakeApprovalStore();
  approvals.seed();

  const app = createApp({
    authenticator: createDevTokenAuthenticator([
      { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 },
      { token: TOKEN_B, tenantId: TENANT_B, principalId: PRINCIPAL_B, policyVersion: 1 },
    ]),
    requestIdGenerator: () => REQUEST_ID,
    taskStore: tasks.store,
    approvalStore: approvals.store,
  });

  return { app, approvals };
}

describe('Approval HTTP API (/v1/approvals)', () => {
  it('rejects unauthenticated or invalid bearer tokens with 401 UNAUTHENTICATED', async () => {
    const { app } = createHarness();

    const missing = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHENTICATED', request_id: REQUEST_ID },
    });

    const invalid = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer unknown-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHENTICATED', request_id: REQUEST_ID },
    });
  });

  it('returns consistent 404 NOT_FOUND for missing or foreign-tenant approvals', async () => {
    const { app } = createHarness();

    const foreignGet = await app.request(`/v1/approvals/${APPROVAL_ID}`, {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    const missingGet = await app.request(`/v1/approvals/${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });

    expect(foreignGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    const foreignGetBody: unknown = await foreignGet.json();
    const missingGetBody: unknown = await missingGet.json();
    expect(foreignGetBody).toEqual(missingGetBody);

    const foreignDecision = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_B}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    const missingDecision = await app.request(`/v1/approvals/${randomUUID()}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(foreignDecision.status).toBe(404);
    expect(missingDecision.status).toBe(404);
    expect(await foreignDecision.json()).toEqual(await missingDecision.json());
  });

  it('validates approvalId UUID and strict decision payload schema (rejecting smuggled tenant_id)', async () => {
    const { app } = createHarness();

    const badId = await app.request('/v1/approvals/not-a-uuid/decision', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(badId.status).toBe(400);
    await expect(badId.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', request_id: REQUEST_ID },
    });

    const smuggledTenant = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve', tenant_id: TENANT_B }),
    });
    expect(smuggledTenant.status).toBe(400);
    await expect(smuggledTenant.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', request_id: REQUEST_ID },
    });

    const badDecision = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'force_approve' }),
    });
    expect(badDecision.status).toBe(400);
    await expect(badDecision.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', request_id: REQUEST_ID },
    });
  });

  it('approves a pending approval and replays repeated approve idempotently', async () => {
    const { app } = createHarness();

    const first = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      approval_id: APPROVAL_ID,
      task_id: TASK_ID,
      status: 'approved',
      task_status: 'queued',
      decided_at: FIXED_TIME,
      replayed: false,
    });

    const second = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      approval_id: APPROVAL_ID,
      task_id: TASK_ID,
      status: 'approved',
      task_status: 'queued',
      decided_at: FIXED_TIME,
      replayed: true,
    });
  });

  it('returns 409 IDEMPOTENCY_CONFLICT when approve is followed by deny or deny by approve', async () => {
    const { app, approvals } = createHarness();

    const approved = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(approved.status).toBe(200);

    const denyAfterApprove = await app.request(`/v1/approvals/${APPROVAL_ID}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(denyAfterApprove.status).toBe(409);
    await expect(denyAfterApprove.json()).resolves.toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT', request_id: REQUEST_ID },
    });

    const secondApprovalId = randomUUID();
    approvals.seed({ approvalId: secondApprovalId });

    const denied = await app.request(`/v1/approvals/${secondApprovalId}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(denied.status).toBe(200);
    await expect(denied.json()).resolves.toMatchObject({
      approval_id: secondApprovalId,
      status: 'denied',
      task_status: 'failed',
      replayed: false,
    });

    const approveAfterDeny = await app.request(`/v1/approvals/${secondApprovalId}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(approveAfterDeny.status).toBe(409);
    await expect(approveAfterDeny.json()).resolves.toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT', request_id: REQUEST_ID },
    });
  });

  it('returns 409 INVALID_STATE_TRANSITION when an approval is expired or its task was cancelled', async () => {
    const { app, approvals } = createHarness();
    const expiredId = randomUUID();
    approvals.seed({ approvalId: expiredId, status: 'expired', decidedAt: FIXED_TIME });

    const resExpired = await app.request(`/v1/approvals/${expiredId}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(resExpired.status).toBe(409);
    await expect(resExpired.json()).resolves.toMatchObject({
      error: { code: 'INVALID_STATE_TRANSITION', request_id: REQUEST_ID },
    });

    const cancelledId = randomUUID();
    approvals.seed({ approvalId: cancelledId, taskStatus: 'cancelled' });

    const resCancelled = await app.request(`/v1/approvals/${cancelledId}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(resCancelled.status).toBe(409);
    await expect(resCancelled.json()).resolves.toMatchObject({
      error: { code: 'INVALID_STATE_TRANSITION', request_id: REQUEST_ID },
    });
  });
});
