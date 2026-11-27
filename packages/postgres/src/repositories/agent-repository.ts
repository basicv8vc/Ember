import { randomUUID } from 'node:crypto';
import {
  AuthContextSchema,
  IdSchema,
  toInvalidArgumentError,
  type AgentRepository,
  type AgentView,
  type CreateAgentCommand,
} from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import { z } from 'zod';
import type pg from 'pg';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

export type { AgentRepository, AgentView, CreateAgentCommand };

const createAgentCommandSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .refine(
      (value) =>
        !Array.from(value).some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint < 0x20 || codePoint === 0x7f;
        }),
      'must not contain control characters',
    ),
  policyVersion: z.number().int().nonnegative().optional(),
});

interface AgentWorkspaceRow {
  agent_id: string;
  name: string;
  policy_version: number;
  workspace_id: string;
  workspace_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const INSERT_AGENT_SQL = `
INSERT INTO agents (id, tenant_id, name, policy_version)
VALUES ($1, $2, $3, $4)
RETURNING id, name, policy_version, created_at, updated_at
`;

const INSERT_WORKSPACE_SQL = `
INSERT INTO workspaces (id, tenant_id, agent_id, version)
VALUES ($1, $2, $3, 0)
RETURNING id, version
`;

const PRINCIPAL_EXISTS_SQL = `
SELECT 1
  FROM principals
 WHERE tenant_id = $1 AND id = $2
`;

const SELECT_AGENT_SQL = `
SELECT a.id   AS agent_id,
       a.name,
       a.policy_version,
       w.id   AS workspace_id,
       w.version AS workspace_version,
       a.created_at,
       a.updated_at
  FROM agents a
  JOIN workspaces w
    ON w.tenant_id = a.tenant_id AND w.agent_id = a.id
 WHERE a.tenant_id = $1 AND a.id = $2
`;

interface InsertedAgentRow {
  id: string;
  name: string;
  policy_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface InsertedWorkspaceRow {
  id: string;
  version: number;
}

function parseContext(ctx: AuthContext): AuthContext {
  const parsed = AuthContextSchema.safeParse(ctx);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function parseAgentId(agentId: Id): Id {
  const parsed = IdSchema.safeParse(agentId);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

function toAgentView(row: AgentWorkspaceRow): AgentView {
  return {
    agentId: row.agent_id,
    name: row.name,
    policyVersion: row.policy_version,
    workspaceId: row.workspace_id,
    workspaceVersion: row.workspace_version,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/**
 * PostgreSQL agent/workspace repository.
 *
 * A client never supplies a tenant: the tenant comes from the verified `AuthContext`.
 * An invalid or absent principal is rejected as `UNAUTHENTICATED`; another tenant's
 * principal is indistinguishable from a missing one.
 */
export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(ctx: AuthContext, command: CreateAgentCommand): Promise<AgentView> {
    const validatedContext = parseContext(ctx);
    const parsedCommand = createAgentCommandSchema.safeParse(command);

    if (!parsedCommand.success) {
      throw toInvalidArgumentError(parsedCommand.error);
    }

    const policyVersion = parsedCommand.data.policyVersion ?? validatedContext.policyVersion;
    const agentId = randomUUID();
    const workspaceId = randomUUID();

    try {
      return await withTransaction(this.pool, async (client) => {
        const principal = await client.query(PRINCIPAL_EXISTS_SQL, [
          validatedContext.tenantId,
          validatedContext.principalId,
        ]);

        if (principal.rowCount === 0) {
          throw new DomainError('UNAUTHENTICATED', 'principal is not provisioned in this tenant');
        }

        const insertedAgent = await client.query<InsertedAgentRow>(INSERT_AGENT_SQL, [
          agentId,
          validatedContext.tenantId,
          parsedCommand.data.name,
          policyVersion,
        ]);
        const agentRow = insertedAgent.rows[0];

        if (agentRow === undefined) {
          throw new DomainError('DB_UNAVAILABLE', 'agent insert did not return a row');
        }

        // Same transaction: a failure here rolls the agent back too.
        const insertedWorkspace = await client.query<InsertedWorkspaceRow>(INSERT_WORKSPACE_SQL, [
          workspaceId,
          validatedContext.tenantId,
          agentId,
        ]);
        const workspaceRow = insertedWorkspace.rows[0];

        if (workspaceRow === undefined) {
          throw new DomainError('DB_UNAVAILABLE', 'workspace insert did not return a row');
        }

        return {
          agentId: agentRow.id,
          name: agentRow.name,
          policyVersion: agentRow.policy_version,
          workspaceId: workspaceRow.id,
          workspaceVersion: workspaceRow.version,
          createdAt: toIsoTimestamp(agentRow.created_at),
          updatedAt: toIsoTimestamp(agentRow.updated_at),
        };
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async get(ctx: AuthContext, agentId: Id): Promise<AgentView | null> {
    const validatedContext = parseContext(ctx);
    const validatedAgentId = parseAgentId(agentId);

    try {
      const result = await this.pool.query<AgentWorkspaceRow>(SELECT_AGENT_SQL, [
        validatedContext.tenantId,
        validatedAgentId,
      ]);
      const row = result.rows[0];

      return row === undefined ? null : toAgentView(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
