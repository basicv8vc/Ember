import { IdSchema } from '@ember/contracts';
import type { Id } from '@ember/domain';
import { Hono } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readJsonBody, type BodyRejectionReason } from '../http/bounded-body.js';
import { respondInvalidArgument, respondNotFound } from '../http/error-mapping.js';
import type { AgentStore } from './agent-store.js';
import { AGENTS_PATH, MAX_AGENT_BODY_BYTES } from './constants.js';
import {
  CreateAgentRequestSchema,
  toAgentDto,
  toCreateAgentCommand,
  type AgentDto,
} from './dto.js';

/**
 * `/v1/agents` — the P0B-07d HTTP agent API.
 *
 * Endpoints (all tenant-scoped, all authenticated by the `/v1/agents` middleware):
 *
 * | method | path                  | success                    |
 * | ------ | --------------------- | -------------------------- |
 * | POST   | `/v1/agents`          | 201 created                |
 * | GET    | `/v1/agents/:agentId` | 200 agent detail / 404     |
 *
 * Rules enforced here, in this order:
 * 1. authentication runs in middleware before any handler executes;
 * 2. `tenantId`, `principalId` and `policyVersion` come from the verified `AuthContext`
 *    only — a request body that attempts to supply `tenant_id` / `tenantId` /
 *    `principal_id` / `policy_version` is rejected by `CreateAgentRequestSchema`;
 * 3. the request body is byte-bounded (`MAX_AGENT_BODY_BYTES`) and schema-validated before
 *    reaching `AgentStore`;
 * 4. `:agentId` is validated as a UUID before reaching SQL;
 * 5. "missing" and "belongs to another tenant" return the exact same 404 response.
 */

const BODY_REJECTION_MESSAGES: Readonly<Record<BodyRejectionReason, string>> = Object.freeze({
  missing_content_type: 'Content-Type must be application/json',
  unsupported_content_type: 'Content-Type must be application/json',
  empty_body: 'request body must be a JSON object',
  too_large: `request body must not exceed ${MAX_AGENT_BODY_BYTES} bytes`,
  invalid_encoding: 'request body must be UTF-8 encoded JSON',
  invalid_json: 'request body must be valid JSON',
});

function parseAgentId(c: AppContext): Id | Response {
  const parsed = IdSchema.safeParse(c.req.param('agentId'));

  if (!parsed.success) {
    return respondInvalidArgument(c, 'agentId must be a UUID');
  }

  return parsed.data;
}

export interface AgentRouteDependencies {
  readonly store: AgentStore;
}

/**
 * Build the tenant-authenticated agent routes.
 */
export function createAgentRoutes(deps: AgentRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.post('/', async (c) => {
    const auth = c.get('auth');
    const body = await readJsonBody(c.req.raw, MAX_AGENT_BODY_BYTES);

    if (!body.ok) {
      return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
    }

    const request = CreateAgentRequestSchema.safeParse(body.value);

    if (!request.success) {
      return respondInvalidArgument(c, 'request body does not match the agent schema');
    }

    const created = await deps.store.create(auth, toCreateAgentCommand(request.data));
    const dto: AgentDto = toAgentDto(created);

    c.header('Location', `${AGENTS_PATH}/${dto.agent_id}`);
    return c.json(dto, 201);
  });

  routes.get('/:agentId', async (c) => {
    const agentId = parseAgentId(c);

    if (agentId instanceof Response) {
      return agentId;
    }

    const view = await deps.store.get(c.get('auth'), agentId);

    if (view === null) {
      // Identical body for "does not exist" and "belongs to another tenant": a 403 or a
      // different message would disclose that the agent id exists.
      return respondNotFound(c, 'agent is not visible in this tenant');
    }

    const dto: AgentDto = toAgentDto(view);
    return c.json(dto, 200);
  });

  return routes;
}
