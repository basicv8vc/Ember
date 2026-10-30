import {
  IdSchema,
  parseApprovalDecisionRequestDto,
  toApprovalDecisionReceiptDto,
  toApprovalViewDto,
  toTaskApprovalsDto,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import { Hono } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readJsonBody, type BodyRejectionReason } from '../http/bounded-body.js';
import { respondInvalidArgument, respondNotFound } from '../http/error-mapping.js';
import { MAX_TASK_BODY_BYTES } from '../tasks/constants.js';
import type { TaskStore } from '../tasks/task-store.js';
import type { ApprovalHttpStore } from './approval-store.js';

export const APPROVALS_PATH = '/v1/approvals';

const BODY_REJECTION_MESSAGES: Readonly<Record<BodyRejectionReason, string>> = Object.freeze({
  missing_content_type: 'Content-Type must be application/json',
  unsupported_content_type: 'Content-Type must be application/json',
  empty_body: 'request body must be a JSON object',
  too_large: `request body must not exceed ${MAX_TASK_BODY_BYTES} bytes`,
  invalid_encoding: 'request body must be UTF-8 encoded JSON',
  invalid_json: 'request body must be valid JSON',
});

export interface ApprovalRouteDependencies {
  readonly approvals: ApprovalHttpStore;
  readonly tasks: TaskStore;
}

function parseRouteId(c: AppContext, parameter: string): Id | Response {
  const parsed = IdSchema.safeParse(c.req.param(parameter));

  if (!parsed.success) {
    return respondInvalidArgument(c, `${parameter} must be a UUID`);
  }

  return parsed.data;
}

function parseApprovalId(c: AppContext): Id | Response {
  return parseRouteId(c, 'approvalId');
}

/** Build the tenant-authenticated Approval routes. Mounted under `/v1`. */
export function createApprovalRoutes(deps: ApprovalRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.get('/tasks/:taskId/approvals', async (c) => {
    const taskId = parseRouteId(c, 'taskId');

    if (taskId instanceof Response) {
      return taskId;
    }

    const auth = c.get('auth');
    const task = await deps.tasks.get(auth, taskId);

    if (task === null) {
      return respondNotFound(c, 'task is not visible in this tenant');
    }

    const approvals = await deps.approvals.listByTask(auth, taskId);
    return c.json(toTaskApprovalsDto(taskId, approvals), 200);
  });

  routes.get('/approvals/:approvalId', async (c) => {
    const approvalId = parseApprovalId(c);

    if (approvalId instanceof Response) {
      return approvalId;
    }

    const auth = c.get('auth');
    const approval = await deps.approvals.get(auth, approvalId);

    if (approval === null) {
      return respondNotFound(c, 'approval is not visible in this tenant');
    }

    return c.json(toApprovalViewDto(approval), 200);
  });

  routes.post('/approvals/:approvalId/decision', async (c) => {
    const approvalId = parseApprovalId(c);

    if (approvalId instanceof Response) {
      return approvalId;
    }

    const body = await readJsonBody(c.req.raw, MAX_TASK_BODY_BYTES);

    if (!body.ok) {
      return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
    }

    const decision = parseApprovalDecisionRequestDto(body.value);
    const auth = c.get('auth');

    const receipt = await deps.approvals.decide(auth, approvalId, decision);

    return c.json(toApprovalDecisionReceiptDto(receipt), 200);
  });

  return routes;
}
