import type {
  DispatchTaskCommand,
  DispatchTaskReceipt,
  ExistingTaskDispatcher,
} from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import type pg from 'pg';
import { PostgresTaskRepository } from './task-repository.js';
import { asDomainError } from './support.js';

interface DispatchAuthorityRow {
  principal_id: string | null;
  policy_version: number | null;
}

/**
 * Resolve the tenant-owned authority a scheduler-dispatched Task runs under.
 *
 * The Worker has no end-user principal at execution time, so the only trustworthy identity is
 * the persisted one: the tenant's `owner` (or durable `service`) principal and the policy
 * version of the Agent that owns the Commitment. Nothing here comes from the Commitment row,
 * a Task payload or an environment fallback - a tenant without such a principal cannot dispatch
 * at all, which is the fail-closed behaviour we want.
 */
const RESOLVE_DISPATCH_AUTHORITY_SQL = `
SELECT p.id           AS principal_id,
       a.policy_version
  FROM principals p
  JOIN agents a
    ON a.tenant_id = p.tenant_id
 WHERE p.tenant_id = $1
   AND a.id = $2
   AND p.role IN ('owner', 'service')
 ORDER BY p.created_at ASC, p.id ASC
 LIMIT 1
`;

/**
 * PostgreSQL implementation of the Scheduler's `ExistingTaskDispatcher`.
 *
 * It deliberately contains no Task-creation logic of its own: every dispatch goes through
 * `PostgresTaskRepository.create()`, so the durable inbox's `(tenant_id, idempotency_key)`
 * uniqueness, canonical digest and `accepted` event remain the single idempotency mechanism.
 */
export class PostgresCommitmentTaskDispatcher implements ExistingTaskDispatcher {
  private readonly tasks: PostgresTaskRepository;

  constructor(
    private readonly pool: pg.Pool,
    tasks: PostgresTaskRepository = new PostgresTaskRepository(pool),
  ) {
    this.tasks = tasks;
  }

  async dispatchTask(cmd: DispatchTaskCommand): Promise<DispatchTaskReceipt> {
    const authority = await this.resolveAuthority(cmd.tenantId, cmd.agentId);

    const ctx: AuthContext = {
      tenantId: cmd.tenantId,
      principalId: authority.principalId,
      policyVersion: authority.policyVersion,
    };

    try {
      const receipt = await this.tasks.create(ctx, {
        agentId: cmd.agentId,
        kind: cmd.kind,
        input: { operation: cmd.input.operation, text: cmd.input.text },
        idempotencyKey: cmd.idempotencyKey,
        ...(cmd.deadlineAt === undefined ? {} : { deadlineAt: cmd.deadlineAt }),
      });

      return Object.freeze({ taskId: receipt.taskId, replayed: receipt.replayed });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  private async resolveAuthority(
    tenantId: Id,
    agentId: Id,
  ): Promise<{ readonly principalId: Id; readonly policyVersion: number }> {
    const result = await this.pool.query<DispatchAuthorityRow>(RESOLVE_DISPATCH_AUTHORITY_SQL, [
      tenantId,
      agentId,
    ]);

    const row = result.rows[0];

    if (row === undefined || row.principal_id === null || row.policy_version === null) {
      throw new DomainError(
        'NOT_FOUND',
        'tenant has no owner or service principal able to dispatch a commitment task',
      );
    }

    return { principalId: row.principal_id, policyVersion: row.policy_version };
  }
}
