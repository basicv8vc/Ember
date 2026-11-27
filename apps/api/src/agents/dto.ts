import {
  IdSchema,
  IsoDateTimeSchema,
  type AgentView,
  type CreateAgentCommand,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { z } from 'zod';
import { AGENT_NAME_MAX_CHARS, AGENT_NAME_MIN_CHARS } from './constants.js';

/**
 * Wire DTOs and Zod schemas for `POST /v1/agents` and `GET /v1/agents/:agentId` (P0B-07d).
 *
 * Deliberate omissions from both request and response shapes:
 * - `tenant_id` / `tenantId` and `principal_id` / `principalId`: tenant and principal
 *   identities come exclusively from the verified `AuthContext` on the request path and are
 *   never accepted from or echoed back in the JSON body;
 * - `policy_version` on the request body: an agent's initial policy version comes from the
 *   verified `AuthContext`, never from a client-supplied field;
 * - internal storage references (`manifest_ref`, storage keys, filesystem paths).
 */

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint < 0x20 || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * Bounded, printable agent display name (`1..128` Unicode code points, not whitespace-only,
 * and free of ASCII control characters).
 */
export const AgentNameSchema = z
  .string()
  .min(AGENT_NAME_MIN_CHARS)
  .max(AGENT_NAME_MAX_CHARS)
  .refine((value) => value.trim().length > 0, 'must not be blank')
  .refine((value) => !hasControlCharacters(value), 'must not contain control characters');

/** Wire-level `POST /v1/agents` request body. */
export interface CreateAgentRequest {
  readonly name: string;
}

/**
 * Strict request schema: unknown fields such as `tenant_id`, `tenantId`, `principal_id`,
 * `principalId`, `policy_version` or `workspace_id` are rejected before persistence.
 */
export const CreateAgentRequestSchema: z.ZodType<CreateAgentRequest> = z.strictObject({
  name: AgentNameSchema,
});

/** Convert a validated wire request into a repository command without client-chosen policy. */
export function toCreateAgentCommand(request: CreateAgentRequest): CreateAgentCommand {
  return {
    name: request.name,
  };
}

/** Agent resource returned by `POST /v1/agents` (201) and `GET /v1/agents/:agentId` (200). */
export interface AgentDto {
  readonly agent_id: Id;
  readonly name: string;
  readonly policy_version: number;
  readonly workspace_id: Id;
  readonly workspace_version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export const AgentDtoSchema: z.ZodType<AgentDto> = z.strictObject({
  agent_id: IdSchema,
  name: AgentNameSchema,
  policy_version: z.number().int().nonnegative(),
  workspace_id: IdSchema,
  workspace_version: z.number().int().nonnegative(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});

/**
 * Explicit internal → wire conversion with runtime schema enforcement.
 *
 * The internal `AgentView` is never serialised directly: only the seven whitelisted fields
 * are copied, and the resulting DTO is validated with `AgentDtoSchema` so a malformed or
 * corrupted store record fails closed as `DB_UNAVAILABLE` (503) rather than leaking raw data.
 */
export function toAgentDto(view: AgentView): AgentDto {
  const candidate: AgentDto = {
    agent_id: view.agentId,
    name: view.name,
    policy_version: view.policyVersion,
    workspace_id: view.workspaceId,
    workspace_version: view.workspaceVersion,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
  const parsed = AgentDtoSchema.safeParse(candidate);

  if (!parsed.success) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted agent row failed response validation');
  }

  return parsed.data;
}
