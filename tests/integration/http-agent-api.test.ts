import { randomUUID } from 'node:crypto';
import { PostgresAgentRepository } from '@ember/postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_NAME_MAX_CHARS,
  AGENTS_PATH,
  MAX_AGENT_BODY_BYTES,
} from '../../apps/api/src/agents/constants.js';
import { AgentDtoSchema, type AgentDto } from '../../apps/api/src/agents/dto.js';
import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { createTenantFixture, type TenantFixture } from './support/fixtures.js';

/**
 * Real PostgreSQL 17 integration tests for `POST /v1/agents` and `GET /v1/agents/:agentId`
 * (P0B-07d).
 *
 * Covers all 11 required scenarios against a live PostgreSQL schema:
 * 1. Tenant A creates an Agent (`201 Created`).
 * 2. Agent creation automatically initializes a version-0 Workspace.
 * 3. Agent and Workspace are committed atomically in the same database transaction.
 * 4. Tenant A queries its own Agent (`200 OK`).
 * 5. Tenant B querying Tenant A's Agent receives `404 Not Found`.
 * 6. Querying a non-existent Agent receives the exact same `404 Not Found`.
 * 7. Missing, malformed, unknown, or unprovisioned-principal tokens receive `401`.
 * 8. Request bodies forging `tenant_id` / `tenantId` are rejected with zero DB side effects.
 * 9. Invalid inputs (malformed JSON, oversized body, invalid name, non-UUID) have zero DB side effects.
 * 10. Concurrent creation across tenants preserves Tenant/Workspace 1-to-1 constraints.
 * 11. Database transaction failures (workspace insert failure or commit failure) leave zero partial rows.
 */

const EXPECTED_TEST_COUNT = 11;

let executedTests = 0;

let db: TestDatabase;
let app: ReturnType<typeof createApp>;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let tokenA: string;
let tokenB: string;
let unprovisionedToken: string;
let unprovisionedPrincipalId: string;

interface SendAgentOptions {
  readonly token?: string | null;
  readonly body?: unknown;
  readonly raw?: string;
  readonly contentType?: string | null;
}

async function postAgent(options: SendAgentOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? tokenA : options.token;
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;

  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  if (contentType !== null) {
    headers['content-type'] = contentType;
  }

  return await app.request(AGENTS_PATH, {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(options.body ?? { name: `agent-${randomUUID()}` }),
  });
}

async function getAgent(agentId: string, token: string | null = tokenA): Promise<Response> {
  return await app.request(`${AGENTS_PATH}/${agentId}`, {
    method: 'GET',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

async function countTenantAgents(tenantId: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM agents WHERE tenant_id = $1',
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function countTenantWorkspaces(tenantId: string): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM workspaces WHERE tenant_id = $1',
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function installWorkspaceFailureTrigger(): Promise<void> {
  await db.pool.query(`
    CREATE OR REPLACE FUNCTION p0b07d_reject_workspace()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected workspace insert failure';
    END;
    $$;
    CREATE TRIGGER p0b07d_reject_workspace_trg
      BEFORE INSERT ON workspaces
      FOR EACH ROW EXECUTE FUNCTION p0b07d_reject_workspace();
  `);
}

async function removeWorkspaceFailureTrigger(): Promise<void> {
  await db.pool.query(`
    DROP TRIGGER IF EXISTS p0b07d_reject_workspace_trg ON workspaces;
    DROP FUNCTION IF EXISTS p0b07d_reject_workspace();
  `);
}

async function installAgentCommitFailureTrigger(): Promise<void> {
  await db.pool.query(`
    CREATE OR REPLACE FUNCTION p0b07d_reject_agent_commit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected deferred agent commit failure';
    END;
    $$;
    CREATE CONSTRAINT TRIGGER p0b07d_reject_agent_commit_trg
      AFTER INSERT ON agents
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION p0b07d_reject_agent_commit();
  `);
}

async function removeAgentCommitFailureTrigger(): Promise<void> {
  await db.pool.query(`
    DROP TRIGGER IF EXISTS p0b07d_reject_agent_commit_trg ON agents;
    DROP FUNCTION IF EXISTS p0b07d_reject_agent_commit();
  `);
}

beforeAll(async () => {
  db = await createTestDatabase({ maxConnections: 12 });
  tenantA = await createTenantFixture(db.pool, 'agent HTTP tenant A');
  tenantB = await createTenantFixture(db.pool, 'agent HTTP tenant B');

  tokenA = `token-${randomUUID()}`;
  tokenB = `token-${randomUUID()}`;
  unprovisionedToken = `token-${randomUUID()}`;
  unprovisionedPrincipalId = randomUUID();
  let requests = 0;

  app = createApp({
    authenticator: createDevTokenAuthenticator([
      {
        token: tokenA,
        tenantId: tenantA.tenantId,
        principalId: tenantA.principalId,
        policyVersion: 2,
      },
      {
        token: tokenB,
        tenantId: tenantB.tenantId,
        principalId: tenantB.principalId,
        policyVersion: 1,
      },
      // Valid token format, mapped to tenantA, but principalId is not inserted into principals.
      {
        token: unprovisionedToken,
        tenantId: tenantA.tenantId,
        principalId: unprovisionedPrincipalId,
        policyVersion: 1,
      },
    ]),
    requestIdGenerator: () => `it-agent-req-${++requests}`,
    agentStore: new PostgresAgentRepository(db.pool),
  });
});

beforeEach(() => {
  executedTests += 1;
});

afterAll(async () => {
  await db?.close();
  expect(executedTests).toBe(EXPECTED_TEST_COUNT);
});

describe('POST /v1/agents and GET /v1/agents/:agentId (PostgreSQL)', () => {
  it('1. allows Tenant A to create an agent with 201 Created, Location header and strict DTO', async () => {
    const beforeAgents = await countTenantAgents(tenantA.tenantId);
    const name = `tenant-a-agent-${randomUUID()}`;

    const response = await postAgent({ token: tokenA, body: { name } });

    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    const created: AgentDto = AgentDtoSchema.parse(body);

    expect(Object.keys(created).sort()).toEqual([
      'agent_id',
      'created_at',
      'name',
      'policy_version',
      'updated_at',
      'workspace_id',
      'workspace_version',
    ]);
    expect(created.name).toBe(name);
    expect(created.policy_version).toBe(2);
    expect(created.workspace_version).toBe(0);
    expect(response.headers.get('location')).toBe(`/v1/agents/${created.agent_id}`);
    expect(response.headers.get('x-request-id')).toMatch(/^it-agent-req-\d+$/);
    expect(JSON.stringify(created)).not.toContain(tenantA.tenantId);
    expect(JSON.stringify(created)).not.toContain(tenantA.principalId);
    expect(await countTenantAgents(tenantA.tenantId)).toBe(beforeAgents + 1);
  });

  it('2. automatically initializes a single version-0 workspace when an agent is created', async () => {
    const name = `workspace-init-${randomUUID()}`;
    const response = await postAgent({ token: tokenA, body: { name } });
    expect(response.status).toBe(201);
    const created = AgentDtoSchema.parse(await response.json());

    const workspaceRows = await db.pool.query<{
      id: string;
      tenant_id: string;
      agent_id: string;
      version: number;
      manifest_ref: string | null;
    }>(
      `SELECT id, tenant_id, agent_id, version, manifest_ref
         FROM workspaces
        WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantA.tenantId, created.agent_id],
    );

    expect(workspaceRows.rows).toHaveLength(1);
    expect(workspaceRows.rows[0]).toEqual({
      id: created.workspace_id,
      tenant_id: tenantA.tenantId,
      agent_id: created.agent_id,
      version: 0,
      manifest_ref: null,
    });
  });

  it('3. commits agent and workspace in the same transaction and hides uncommitted rows', async () => {
    const name = `tx-atomic-${randomUUID()}`;
    const response = await postAgent({ token: tokenA, body: { name } });
    expect(response.status).toBe(201);
    const created = AgentDtoSchema.parse(await response.json());

    // Immediately visible on an independent database pool after 201 is returned.
    const observed = await db.observerPool.query<{
      agent_id: string;
      workspace_id: string;
      version: number;
    }>(
      `SELECT a.id AS agent_id, w.id AS workspace_id, w.version
         FROM agents a
         JOIN workspaces w ON w.tenant_id = a.tenant_id AND w.agent_id = a.id
        WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantA.tenantId, created.agent_id],
    );
    expect(observed.rows).toEqual([
      {
        agent_id: created.agent_id,
        workspace_id: created.workspace_id,
        version: 0,
      },
    ]);

    // An uncommitted agent + workspace in an open transaction must not be visible via GET.
    const uncommittedAgentId = randomUUID();
    const uncommittedWorkspaceId = randomUUID();
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
        [uncommittedAgentId, tenantA.tenantId, 'uncommitted-agent'],
      );
      await client.query(
        'INSERT INTO workspaces (id, tenant_id, agent_id, version) VALUES ($1, $2, $3, 0)',
        [uncommittedWorkspaceId, tenantA.tenantId, uncommittedAgentId],
      );

      const duringTx = await getAgent(uncommittedAgentId, tokenA);
      expect(duringTx.status).toBe(404);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('4. allows Tenant A to query its own agent and receive the exact persisted DTO', async () => {
    const name = `query-own-${randomUUID()}`;
    const createRes = await postAgent({ token: tokenA, body: { name } });
    expect(createRes.status).toBe(201);
    const created = AgentDtoSchema.parse(await createRes.json());

    const getRes = await getAgent(created.agent_id, tokenA);
    expect(getRes.status).toBe(200);
    const fetched = AgentDtoSchema.parse(await getRes.json());

    expect(fetched).toEqual(created);
    expect(JSON.stringify(fetched)).not.toContain(tenantA.tenantId);
    expect(JSON.stringify(fetched)).not.toContain(tenantA.principalId);
    expect(JSON.stringify(fetched)).not.toContain('manifest_ref');
  });

  it('5. returns 404 when Tenant B queries an agent owned by Tenant A', async () => {
    const createRes = await postAgent({
      token: tokenA,
      body: { name: `private-to-a-${randomUUID()}` },
    });
    expect(createRes.status).toBe(201);
    const created = AgentDtoSchema.parse(await createRes.json());

    const crossTenantRes = await getAgent(created.agent_id, tokenB);
    expect(crossTenantRes.status).toBe(404);
    const crossBody = (await crossTenantRes.json()) as {
      error: { code: string; message: string; request_id?: string };
    };
    expect(crossBody.error.code).toBe('NOT_FOUND');
    expect(crossBody.error.message).toBe('Resource not found');
    expect(JSON.stringify(crossBody)).not.toContain(created.name);
    expect(JSON.stringify(crossBody)).not.toContain(created.agent_id);
  });

  it('6. returns an indistinguishable 404 for a non-existent agent and a cross-tenant agent', async () => {
    const createRes = await postAgent({
      token: tokenA,
      body: { name: `indistinguishable-${randomUUID()}` },
    });
    expect(createRes.status).toBe(201);
    const created = AgentDtoSchema.parse(await createRes.json());

    const missingId = randomUUID();
    const [crossRes, missingForB, missingForA] = await Promise.all([
      getAgent(created.agent_id, tokenB),
      getAgent(missingId, tokenB),
      getAgent(missingId, tokenA),
    ]);

    expect(crossRes.status).toBe(404);
    expect(missingForB.status).toBe(404);
    expect(missingForA.status).toBe(404);

    interface ErrorEnvelope {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly request_id?: string;
      };
    }

    const [crossBody, missingBBody, missingABody] = await Promise.all([
      crossRes.json() as Promise<ErrorEnvelope>,
      missingForB.json() as Promise<ErrorEnvelope>,
      missingForA.json() as Promise<ErrorEnvelope>,
    ]);

    expect(crossBody.error.code).toBe('NOT_FOUND');
    expect(missingBBody.error.code).toBe(crossBody.error.code);
    expect(missingABody.error.code).toBe(crossBody.error.code);
    expect(missingBBody.error.message).toBe(crossBody.error.message);
    expect(missingABody.error.message).toBe(crossBody.error.message);
    expect(Object.keys(crossBody.error).sort()).toEqual(Object.keys(missingBBody.error).sort());
    expect(crossBody.error.request_id).not.toBe(missingBBody.error.request_id);
  });

  it('7. returns 401 for missing, malformed, unknown or unprovisioned-principal tokens with zero DB writes', async () => {
    const beforeAgentsA = await countTenantAgents(tenantA.tenantId);
    const beforeWorkspacesA = await countTenantWorkspaces(tenantA.tenantId);

    const postMissing = await postAgent({ token: null });
    const postUnknown = await postAgent({ token: `token-${randomUUID()}` });
    const postMalformed = await app.request(AGENTS_PATH, {
      method: 'POST',
      headers: {
        authorization: 'Bearer bad token with spaces',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'should-not-create' }),
    });
    const postUnprovisioned = await postAgent({
      token: unprovisionedToken,
      body: { name: 'unprovisioned-principal-agent' },
    });

    const getMissing = await getAgent(randomUUID(), null);
    const getUnknown = await getAgent(randomUUID(), `token-${randomUUID()}`);

    for (const response of [
      postMissing,
      postUnknown,
      postMalformed,
      postUnprovisioned,
      getMissing,
      getUnknown,
    ]) {
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.message).toBe('Authentication required');
      expect(JSON.stringify(body)).not.toContain(unprovisionedPrincipalId);
    }

    expect(await countTenantAgents(tenantA.tenantId)).toBe(beforeAgentsA);
    expect(await countTenantWorkspaces(tenantA.tenantId)).toBe(beforeWorkspacesA);
  });

  it('8. rejects request bodies that forge tenant_id or tenantId with 400 and zero DB writes', async () => {
    const beforeA = await countTenantAgents(tenantA.tenantId);
    const beforeB = await countTenantAgents(tenantB.tenantId);

    const forgedPayloads = [
      { name: 'forged-snake', tenant_id: tenantB.tenantId },
      { name: 'forged-camel', tenantId: tenantB.tenantId },
      { name: 'forged-same-tenant', tenant_id: tenantA.tenantId },
      { name: 'forged-principal-snake', principal_id: tenantB.principalId },
      { name: 'forged-principal-camel', principalId: tenantB.principalId },
      { name: 'forged-policy', policy_version: 999 },
    ];

    for (const body of forgedPayloads) {
      const response = await postAgent({ token: tokenA, body });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_ARGUMENT', message: 'Invalid request input' },
      });
    }

    expect(await countTenantAgents(tenantA.tenantId)).toBe(beforeA);
    expect(await countTenantAgents(tenantB.tenantId)).toBe(beforeB);
  });

  it('9. rejects invalid inputs with 400 and causes no database side effects', async () => {
    const beforeAgents = await countTenantAgents(tenantA.tenantId);
    const beforeWorkspaces = await countTenantWorkspaces(tenantA.tenantId);

    const invalidRequests: Array<Promise<Response>> = [
      postAgent({ body: {} }),
      postAgent({ body: { name: '' } }),
      postAgent({ body: { name: '    ' } }),
      postAgent({ body: { name: 'x'.repeat(AGENT_NAME_MAX_CHARS + 1) } }),
      postAgent({ body: { name: 'control-\u0000-char' } }),
      postAgent({ body: { name: 'line-\n-break' } }),
      postAgent({ raw: '{"name":' }),
      postAgent({ raw: '' }),
      postAgent({ contentType: 'text/plain', raw: JSON.stringify({ name: 'plain' }) }),
      postAgent({
        raw: JSON.stringify({ name: 'oversized' }) + ' '.repeat(MAX_AGENT_BODY_BYTES),
      }),
      getAgent('not-a-valid-uuid', tokenA),
    ];

    const responses = await Promise.all(invalidRequests);
    for (const response of responses) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_ARGUMENT', message: 'Invalid request input' },
      });
    }

    expect(await countTenantAgents(tenantA.tenantId)).toBe(beforeAgents);
    expect(await countTenantWorkspaces(tenantA.tenantId)).toBe(beforeWorkspaces);
  });

  it('10. preserves tenant and workspace invariants under 24 concurrent agent creations', async () => {
    const perTenant = 12;
    const beforeAgentsA = await countTenantAgents(tenantA.tenantId);
    const beforeAgentsB = await countTenantAgents(tenantB.tenantId);

    const requests = Array.from({ length: perTenant * 2 }, (_, index) => {
      const isTenantA = index % 2 === 0;
      return postAgent({
        token: isTenantA ? tokenA : tokenB,
        body: { name: `concurrent-${isTenantA ? 'A' : 'B'}-${index}-${randomUUID()}` },
      }).then(async (response) => ({
        isTenantA,
        status: response.status,
        dto: AgentDtoSchema.parse(await response.json()),
      }));
    });

    const results = await Promise.all(requests);
    expect(results.every((entry) => entry.status === 201)).toBe(true);

    const agentIds = new Set(results.map((entry) => entry.dto.agent_id));
    const workspaceIds = new Set(results.map((entry) => entry.dto.workspace_id));
    expect(agentIds.size).toBe(perTenant * 2);
    expect(workspaceIds.size).toBe(perTenant * 2);

    expect(await countTenantAgents(tenantA.tenantId)).toBe(beforeAgentsA + perTenant);
    expect(await countTenantWorkspaces(tenantA.tenantId)).toBe(beforeAgentsA + perTenant);
    expect(await countTenantAgents(tenantB.tenantId)).toBe(beforeAgentsB + perTenant);
    expect(await countTenantWorkspaces(tenantB.tenantId)).toBe(beforeAgentsB + perTenant);

    // Verify each created agent is visible only to its owning tenant and has a version-0 workspace.
    for (const entry of results) {
      const ownerToken = entry.isTenantA ? tokenA : tokenB;
      const otherToken = entry.isTenantA ? tokenB : tokenA;

      const ownerGet = await getAgent(entry.dto.agent_id, ownerToken);
      expect(ownerGet.status).toBe(200);
      expect(AgentDtoSchema.parse(await ownerGet.json())).toEqual(entry.dto);

      const otherGet = await getAgent(entry.dto.agent_id, otherToken);
      expect(otherGet.status).toBe(404);
    }
  });

  it('11. leaves zero partial agent or workspace rows when the creation transaction fails', async () => {
    const beforeAgents = await countTenantAgents(tenantA.tenantId);
    const beforeWorkspaces = await countTenantWorkspaces(tenantA.tenantId);
    const wsFailName = `ws-tx-fail-${randomUUID()}`;

    await installWorkspaceFailureTrigger();
    try {
      const response = await postAgent({ token: tokenA, body: { name: wsFailName } });
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        error: { code: 'DB_UNAVAILABLE', message: 'Database is unavailable' },
      });
      expect(text).not.toContain('injected workspace insert failure');
      expect(text).not.toContain('p0b07d_reject_workspace');
    } finally {
      await removeWorkspaceFailureTrigger();
    }

    const commitFailName = `commit-tx-fail-${randomUUID()}`;
    await installAgentCommitFailureTrigger();
    try {
      const response = await postAgent({ token: tokenA, body: { name: commitFailName } });
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        error: { code: 'DB_UNAVAILABLE', message: 'Database is unavailable' },
      });
      expect(text).not.toContain('injected deferred agent commit failure');
    } finally {
      await removeAgentCommitFailureTrigger();
    }

    expect(await countTenantAgents(tenantA.tenantId)).toBe(beforeAgents);
    expect(await countTenantWorkspaces(tenantA.tenantId)).toBe(beforeWorkspaces);

    const orphanedRows = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agents WHERE tenant_id = $1 AND name IN ($2, $3)',
      [tenantA.tenantId, wsFailName, commitFailName],
    );
    expect(orphanedRows.rows[0]?.count).toBe('0');
  });
});
