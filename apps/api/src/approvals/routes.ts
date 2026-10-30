import {
  IdSchema,
  parseApprovalDecisionRequestDto,
  toApprovalDecisionReceiptDto,
  toApprovalViewDto,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import { Hono } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readJsonBody, type BodyRejectionReason } from '../http/bounded-body.js';
import { respondInvalidArgument, respondNotFound } from '../http/error-mapping.js';
import { MAX_TASK_BODY_BYTES } from '../tasks/constants.js';
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
}

function parseApprovalId(c: AppContext): Id | Response {
  const parsed = IdSchema.safeParse(c.req.param('approvalId'));

  if (!parsed.success) {
    return respondInvalidArgument(c, 'approvalId must be a UUID');
  }

  return parsed.data;
}

/** Build the tenant-authenticated Approval routes (`/v1/approvals`). */
export function createApprovalRoutes(deps: ApprovalRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.get('/:approvalId', async (c) => {
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

  routes.post('/:approvalId/decision', async (c) => {
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
