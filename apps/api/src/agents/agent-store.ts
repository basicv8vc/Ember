import type { AgentView, CreateAgentCommand } from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';

/**
 * Persistence seam for the `/v1/agents` HTTP routes (P0B-07d).
 *
 * `PostgresAgentRepository` satisfies this interface directly. Keeping a narrow store
 * interface in `apps/api` lets unit tests exercise authentication, bounded body reading,
 * strict schema validation, status codes and error mapping without a live PostgreSQL pool,
 * while integration tests wire the real `PostgresAgentRepository`.
 */
export interface AgentStore {
  /**
   * Atomically persist a new agent and its initial version-0 workspace in `ctx.tenantId`.
   * Both `tenantId` and `principalId` come exclusively from the server-verified `AuthContext`.
   */
  create(ctx: AuthContext, command: CreateAgentCommand): Promise<AgentView>;

  /**
   * Read an agent in `ctx.tenantId`. Returns `null` when the agent does not exist *or*
   * belongs to another tenant, so the caller cannot distinguish the two.
   */
  get(ctx: AuthContext, agentId: Id): Promise<AgentView | null>;
}

/**
 * Default store used when `createApp()` is called without `agentStore` (for example in
 * `/healthz` unit tests). Every call fails closed with `DB_UNAVAILABLE` (HTTP 503).
 */
export function unconfiguredAgentStore(): AgentStore {
  const fail = (): Promise<never> =>
    Promise.reject(
      new DomainError('DB_UNAVAILABLE', 'agent store is not configured for this process'),
    );

  return {
    create: fail,
    get: fail,
  };
}
