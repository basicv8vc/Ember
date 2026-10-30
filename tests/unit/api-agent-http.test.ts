import { randomUUID } from 'node:crypto';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import type { AgentView, CreateAgentCommand } from '@ember/postgres';
import { describe, expect, it } from 'vitest';

import type { AgentStore } from '../../apps/api/src/agents/agent-store.js';
import {
  AGENT_NAME_MAX_CHARS,
  AGENTS_PATH,
  MAX_AGENT_BODY_BYTES,
} from '../../apps/api/src/agents/constants.js';
import { AgentDtoSchema } from '../../apps/api/src/agents/dto.js';
import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import type { Logger } from '../../apps/api/src/logger.js';
import { FIXED_TIME } from './support/task-api-fakes.js';

type RecordedLog = Record<string, unknown>;

/**
 * Unit tests for `POST /v1/agents` and `GET /v1/agents/:agentId` (P0B-07d).
 *
 * Covers authentication, server-derived `AuthContext` propagation, strict schema validation,
 * request size and field-length bounds, cross-tenant 404 indistinguishability, response
 * schema enforcement, and sanitized failure mapping without a database connection.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const PRINCIPAL_A = randomUUID();
const PRINCIPAL_B = randomUUID();
const TOKEN_A = `token-${randomUUID()}`;
const TOKEN_B = `token-${randomUUID()}`;
const REQUEST_ID = 'req-agent-http-01';

type App = ReturnType<typeof createApp>;

function buildAgentView(overrides: Partial<AgentView> = {}): AgentView {
  return {
    agentId: overrides.agentId ?? '00000000-0000-4000-8000-000000000011',
    name: overrides.name ?? 'primary research agent',
    policyVersion: overrides.policyVersion ?? 1,
    workspaceId: overrides.workspaceId ?? '00000000-0000-4000-8000-000000000022',
    workspaceVersion: overrides.workspaceVersion ?? 0,
    createdAt: overrides.createdAt ?? FIXED_TIME,
    updatedAt: overrides.updatedAt ?? FIXED_TIME,
  };
}

interface FakeAgentApi {
  readonly store: AgentStore;
  readonly creates: CreateAgentCommand[];
  readonly createContexts: AuthContext[];
  readonly gets: { readonly context: AuthContext; readonly agentId: Id }[];
  addAgent(tenantId: string, view: AgentView): void;
  setNextCreated(view: AgentView): void;
  setFailure(error: Error): void;
}

function createFakeAgentApi(): FakeAgentApi {
  const agents = new Map<string, AgentView>();
  const creates: CreateAgentCommand[] = [];
  const createContexts: AuthContext[] = [];
  const gets: { context: AuthContext; agentId: Id }[] = [];
  let nextCreated: AgentView | undefined;
  let failure: Error | undefined;

  const scope = (tenantId: string, agentId: Id): string => `${tenantId}:${agentId}`;

  return {
    creates,
    createContexts,
    gets,
    addAgent(tenantId, view) {
      agents.set(scope(tenantId, view.agentId), view);
    },
    setNextCreated(view) {
      nextCreated = view;
    },
    setFailure(error) {
      failure = error;
    },
    store: {
      create(context, command) {
        createContexts.push(context);
        creates.push(command);

        if (failure !== undefined) {
          return Promise.reject(failure);
        }

        const view =
          nextCreated ??
          buildAgentView({
            agentId: randomUUID(),
            workspaceId: randomUUID(),
            name: command.name,
            policyVersion: command.policyVersion ?? context.policyVersion,
            workspaceVersion: 0,
          });
        agents.set(scope(context.tenantId, view.agentId), view);
        return Promise.resolve(view);
      },
      get(context, agentId) {
        gets.push({ context, agentId });

        if (failure !== undefined) {
          return Promise.reject(failure);
        }

        return Promise.resolve(agents.get(scope(context.tenantId, agentId)) ?? null);
      },
    },
  };
}

interface Harness {
  readonly api: FakeAgentApi;
  readonly app: App;
  readonly logs: RecordedLog[];
}

function harness(): Harness {
  const api = createFakeAgentApi();
  const logs: RecordedLog[] = [];
  const logger: Logger = {
    debug: (message, fields) => logs.push({ level: 'debug', message, time: FIXED_TIME, ...fields }),
    info: (message, fields) => logs.push({ level: 'info', message, time: FIXED_TIME, ...fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, time: FIXED_TIME, ...fields }),
    error: (message, fields) => logs.push({ level: 'error', message, time: FIXED_TIME, ...fields }),
  };

  const app = createApp({
    authenticator: createDevTokenAuthenticator([
      { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 3 },
      { token: TOKEN_B, tenantId: TENANT_B, principalId: PRINCIPAL_B, policyVersion: 1 },
    ]),
    requestIdGenerator: () => REQUEST_ID,
    logger,
    agentStore: api.store,
  });

  return { api, app, logs };
}

async function postAgent(
  app: App,
  options: {
    body?: unknown;
    raw?: string;
    token?: string | null;
    contentType?: string | null;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN_A : options.token;
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;

  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  if (contentType !== null) {
    headers['content-type'] = contentType;
  }

  const body = options.raw ?? JSON.stringify(options.body ?? { name: 'Atlas' });
  return await app.request(AGENTS_PATH, { method: 'POST', headers, body });
}

async function getAgent(
  app: App,
  agentId: string,
  token: string | null = TOKEN_A,
): Promise<Response> {
  return await app.request(`${AGENTS_PATH}/${agentId}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('POST /v1/agents', () => {
  it('creates an agent with 201 Created, Location header and a schema-validated DTO', async () => {
    const { api, app } = harness();
    const agentId = randomUUID();
    const workspaceId = randomUUID();
    api.setNextCreated(
      buildAgentView({
        agentId,
        workspaceId,
        name: 'Atlas',
        policyVersion: 3,
        workspaceVersion: 0,
      }),
    );

    const response = await postAgent(app, { body: { name: 'Atlas' } });

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe(`/v1/agents/${agentId}`);
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);

    const payload: unknown = await response.json();
    expect(AgentDtoSchema.parse(payload)).toEqual({
      agent_id: agentId,
      name: 'Atlas',
      policy_version: 3,
      workspace_id: workspaceId,
      workspace_version: 0,
      created_at: FIXED_TIME,
      updated_at: FIXED_TIME,
    });
    expect(JSON.stringify(payload)).not.toContain('tenant_id');
    expect(JSON.stringify(payload)).not.toContain('tenantId');
    expect(JSON.stringify(payload)).not.toContain('principal_id');
    expect(JSON.stringify(payload)).not.toContain('manifest_ref');
  });

  it('derives tenantId, principalId and policyVersion exclusively from the verified AuthContext', async () => {
    const { api, app } = harness();

    const response = await postAgent(app, { body: { name: 'Tenant A Agent' } });

    expect(response.status).toBe(201);
    expect(api.createContexts).toEqual([
      { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 3 },
    ]);
    expect(api.creates).toEqual([{ name: 'Tenant A Agent' }]);
  });

  it('rejects missing, malformed or unknown bearer tokens with 401 before calling the store', async () => {
    const { api, app } = harness();

    const missing = await postAgent(app, { token: null });
    const malformed = await app.request(AGENTS_PATH, {
      method: 'POST',
      headers: { authorization: 'Basic dXNlcjpwYXNz', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Atlas' }),
    });
    const unknown = await postAgent(app, { token: `token-${randomUUID()}` });

    for (const response of [missing, malformed, unknown]) {
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
          request_id: REQUEST_ID,
        },
      });
    }

    expect(api.creates).toEqual([]);
  });

  it('rejects any attempt to specify or override tenant, principal, policy or workspace fields', async () => {
    const { api, app } = harness();

    const forbiddenBodies = [
      { name: 'Atlas', tenant_id: TENANT_B },
      { name: 'Atlas', tenantId: TENANT_B },
      { name: 'Atlas', principal_id: PRINCIPAL_B },
      { name: 'Atlas', principalId: PRINCIPAL_B },
      { name: 'Atlas', policy_version: 99 },
      { name: 'Atlas', policyVersion: 99 },
      { name: 'Atlas', agent_id: randomUUID() },
      { name: 'Atlas', workspace_id: randomUUID() },
      { name: 'Atlas', workspace_version: 5 },
      { name: 'Atlas', manifest_ref: '/etc/passwd' },
    ];

    for (const body of forbiddenBodies) {
      const response = await postAgent(app, { body });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Invalid request input',
          request_id: REQUEST_ID,
        },
      });
    }

    expect(api.creates).toEqual([]);
  });

  it('enforces name length bounds and rejects blank or control-character names without echoing input', async () => {
    const { api, app, logs } = harness();

    const minAccepted = await postAgent(app, { body: { name: 'A' } });
    expect(minAccepted.status).toBe(201);

    const maxName = 'n'.repeat(AGENT_NAME_MAX_CHARS);
    const maxAccepted = await postAgent(app, { body: { name: maxName } });
    expect(maxAccepted.status).toBe(201);

    const invalidNames: unknown[] = [
      '',
      '   ',
      'x'.repeat(AGENT_NAME_MAX_CHARS + 1),
      'bad\u0000name',
      'bad\nname',
      'bad\rname',
      'bad\tname',
      'bad\u001fname',
      'bad\u007fname',
      123,
      null,
      ['Atlas'],
    ];

    for (const candidate of invalidNames) {
      const response = await postAgent(app, { body: { name: candidate } });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Invalid request input',
          request_id: REQUEST_ID,
        },
      });
      if (typeof candidate === 'string' && candidate.trim().length > 2) {
        expect(text).not.toContain(candidate);
      }
    }

    expect(api.creates).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain('bad\u0000name');
  });

  it('enforces the 4 KiB request body cap before schema parsing or persistence', async () => {
    const { api, app } = harness();

    // Pad with JSON whitespace so the payload is syntactically valid and hits the exact byte cap.
    const base = JSON.stringify({ name: 'bound-check' });
    const exactPadding = ' '.repeat(MAX_AGENT_BODY_BYTES - Buffer.byteLength(base, 'utf8'));
    const atCap = `${base}${exactPadding}`;
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(MAX_AGENT_BODY_BYTES);

    const accepted = await postAgent(app, { raw: atCap });
    expect(accepted.status).toBe(201);
    expect(api.creates).toHaveLength(1);

    const overCap = `${atCap} `;
    expect(Buffer.byteLength(overCap, 'utf8')).toBe(MAX_AGENT_BODY_BYTES + 1);
    const rejected = await postAgent(app, { raw: overCap });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', request_id: REQUEST_ID },
    });
    expect(api.creates).toHaveLength(1);
  });

  it('rejects missing Content-Type, unsupported Content-Type, empty bodies and malformed JSON', async () => {
    const { api, app } = harness();

    expect((await postAgent(app, { contentType: null })).status).toBe(400);
    expect((await postAgent(app, { contentType: 'text/plain' })).status).toBe(400);
    expect((await postAgent(app, { raw: '' })).status).toBe(400);
    expect((await postAgent(app, { raw: '{"name":' })).status).toBe(400);
    expect(api.creates).toEqual([]);
  });

  it('maps store failures and corrupted store rows to sanitized 503 responses', async () => {
    const { api, app, logs } = harness();
    api.setFailure(
      new DomainError('DB_UNAVAILABLE', 'insert into agents failed on /var/lib/postgresql/data'),
    );

    const failed = await postAgent(app, { body: { name: 'Atlas' } });
    expect(failed.status).toBe(503);
    const failedText = await failed.text();
    expect(JSON.parse(failedText)).toEqual({
      error: {
        code: 'DB_UNAVAILABLE',
        message: 'Database is unavailable',
        request_id: REQUEST_ID,
      },
    });
    expect(failedText).not.toContain('/var/lib/postgresql');
    expect(JSON.stringify(logs)).not.toContain('/var/lib/postgresql');

    // Also verify fail-closed default when createApp() has no agentStore configured.
    const unconfigured = createApp({
      authenticator: createDevTokenAuthenticator([
        { token: TOKEN_A, tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 },
      ]),
      requestIdGenerator: () => REQUEST_ID,
    });
    expect((await postAgent(unconfigured, { body: { name: 'Atlas' } })).status).toBe(503);
  });
});

describe('GET /v1/agents/:agentId', () => {
  it('returns 200 with a schema-validated DTO for an agent owned by the caller tenant', async () => {
    const { api, app } = harness();
    const agentId = randomUUID();
    const workspaceId = randomUUID();
    const view = {
      ...buildAgentView({
        agentId,
        workspaceId,
        name: 'Owned Agent',
        policyVersion: 3,
        workspaceVersion: 2,
      }),
      // Simulate extra internal properties on the object to prove DTO conversion strips them.
      tenantId: TENANT_A,
      manifestRef: '/var/private/workspace/manifest.json',
    } as AgentView;
    api.addAgent(TENANT_A, view);

    const response = await getAgent(app, agentId, TOKEN_A);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    const body: unknown = await response.json();
    expect(AgentDtoSchema.parse(body)).toEqual({
      agent_id: agentId,
      name: 'Owned Agent',
      policy_version: 3,
      workspace_id: workspaceId,
      workspace_version: 2,
      created_at: FIXED_TIME,
      updated_at: FIXED_TIME,
    });
    expect(JSON.stringify(body)).not.toContain(TENANT_A);
    expect(JSON.stringify(body)).not.toContain('/var/private');
    expect(api.gets).toEqual([
      {
        context: { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 3 },
        agentId,
      },
    ]);
  });

  it('returns the exact same 404 response for a missing agent and a cross-tenant agent', async () => {
    const { api, app } = harness();
    const tenantAAgentId = randomUUID();
    const missingAgentId = randomUUID();
    api.addAgent(TENANT_A, buildAgentView({ agentId: tenantAAgentId, name: 'Secret Agent A' }));

    const crossTenant = await getAgent(app, tenantAAgentId, TOKEN_B);
    const missing = await getAgent(app, missingAgentId, TOKEN_B);

    expect(crossTenant.status).toBe(404);
    expect(missing.status).toBe(404);

    const crossBody = await crossTenant.json();
    const missingBody = await missing.json();
    expect(crossBody).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        request_id: REQUEST_ID,
      },
    });
    expect(crossBody).toEqual(missingBody);
    expect(JSON.stringify(crossBody)).not.toContain('Secret Agent A');
    expect(JSON.stringify(crossBody)).not.toContain(tenantAAgentId);
  });

  it('rejects a malformed agentId with 400 before touching persistence', async () => {
    const { api, app } = harness();

    for (const invalidId of ['not-a-uuid', '12345', '00000000-0000-0000-0000-00000000000Z']) {
      const response = await getAgent(app, invalidId, TOKEN_A);
      expect(response.status, invalidId).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Invalid request input',
          request_id: REQUEST_ID,
        },
      });
    }

    expect(api.gets).toEqual([]);
  });

  it('rejects unauthenticated or invalid tokens with 401 before touching persistence', async () => {
    const { api, app } = harness();
    const agentId = randomUUID();
    api.addAgent(TENANT_A, buildAgentView({ agentId }));

    expect((await getAgent(app, agentId, null)).status).toBe(401);
    expect((await getAgent(app, agentId, 'invalid-token')).status).toBe(401);
    expect(api.gets).toEqual([]);
  });

  it('fails closed with 503 if a persisted row fails response schema validation', async () => {
    const { api, app } = harness();
    const agentId = randomUUID();
    api.addAgent(
      TENANT_A,
      buildAgentView({
        agentId,
        workspaceId: 'corrupted-non-uuid-workspace-id',
      }),
    );

    const response = await getAgent(app, agentId, TOKEN_A);

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: {
        code: 'DB_UNAVAILABLE',
        message: 'Database is unavailable',
        request_id: REQUEST_ID,
      },
    });
    expect(text).not.toContain('corrupted-non-uuid-workspace-id');
  });
});
