import { randomUUID } from 'node:crypto';
import type { TaskCommand } from '@ember/domain';
import type { TestPool } from './database.js';

export interface TenantFixture {
  readonly tenantId: string;
  readonly principalId: string;
}

/**
 * Explicit local fixture for tests and future local tooling. Tenant provisioning is not a
 * P0B-03 client feature; task commands can never choose their own tenant.
 */
export async function createTenantFixture(
  pool: TestPool,
  name = 'P0B-03 test tenant',
): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, name]);
    await client.query('INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, $3)', [
      principalId,
      tenantId,
      'owner',
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { tenantId, principalId };
}

export function chatCommand(
  agentId: string,
  idempotencyKey: string,
  prompt = 'deterministic mock prompt',
  deadlineAt?: string,
): TaskCommand {
  return deadlineAt === undefined
    ? { agentId, idempotencyKey, kind: 'mock.chat', input: { prompt } }
    : { agentId, idempotencyKey, kind: 'mock.chat', input: { prompt }, deadlineAt };
}

export function computeCommand(agentId: string, idempotencyKey: string): TaskCommand {
  return {
    agentId,
    idempotencyKey,
    kind: 'mock.compute',
    input: { operation: 'sha256', text: 'durable inbox' },
  };
}

export function approvalCommand(
  agentId: string,
  idempotencyKey: string,
  action = 'deploy:production',
  reason = 'routine release',
  deadlineAt?: string,
): TaskCommand {
  return deadlineAt === undefined
    ? { agentId, idempotencyKey, kind: 'mock.approval', input: { action, reason } }
    : { agentId, idempotencyKey, kind: 'mock.approval', input: { action, reason }, deadlineAt };
}
