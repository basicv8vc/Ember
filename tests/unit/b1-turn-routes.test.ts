import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { B1AssistantTurnDtoSchema, ErrorResponseSchema } from '@ember/contracts';
import type { Id } from '@ember/domain';
import type {
  B1AuthenticatedSession,
  B1ProvisionedSession,
  B1SessionRotationResult,
} from '@ember/postgres';
import { Hono } from 'hono';
import type { AppBindings } from '../../apps/api/src/http/app-context.js';
import { requestIdMiddleware } from '../../apps/api/src/http/app-context.js';
import {
  createSessionService,
  type B1SessionPorts,
} from '../../apps/api/src/auth/session-service.js';
import { generateSessionToken } from '../../apps/api/src/auth/session-token.js';
import { createB1TurnRoutes } from '../../apps/api/src/turns/turn-routes.js';
import type { B1TurnRouteDependencies } from '../../apps/api/src/turns/turn-routes.js';

const requestId = 'turn-route-test-request';
const tenantId = randomUUID();
const principalId = randomUUID();
const conversationId = randomUUID();
const turnId = randomUUID();
const sourceMessageId = randomUUID();
const token = generateSessionToken();

function sessionService() {
  const session = {
    sessionId: randomUUID(),
    consumerId: randomUUID(),
    tenantId,
    expiresAt: '2026-12-05T00:00:00.000Z',
    idleExpiresAt: '2026-11-19T00:00:00.000Z',
    revokedAt: null,
  } as const;
  const authenticated: B1AuthenticatedSession = {
    session,
    principalId,
    policyVersion: 1,
  };
  const ports: B1SessionPorts = {
    provisioning: {
      provisionIdentityAndCreateSession(): Promise<B1ProvisionedSession> {
        return Promise.reject(new Error('not used in Turn route test'));
      },
    },
    sessions: {
      findActiveSession(): Promise<B1AuthenticatedSession> {
        return Promise.resolve(authenticated);
      },
      rotateSession(): Promise<B1SessionRotationResult> {
        return Promise.resolve({ kind: 'inactive' });
      },
      revokeSession(): Promise<void> {
        return Promise.resolve();
      },
    },
    me: {
      getMeForTenant() {
        return Promise.resolve(null);
      },
    },
  };

  return createSessionService({ ports });
}

function runningTurn() {
  return B1AssistantTurnDtoSchema.parse({
    turn_id: turnId,
    conversation_id: conversationId,
    source_message_id: sourceMessageId,
    status: 'running',
    created_at: '2026-11-05T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:00.000Z',
    response_message_id: null,
    failure_reason: null,
  });
}

function buildApp(repository: B1TurnRouteDependencies['repository']): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use(
    '*',
    requestIdMiddleware(() => requestId),
  );
  app.onError((_error, c) =>
    c.json(
      {
        error: {
          code: 'internal_error',
          message: 'Internal server error',
          request_id: requestId,
        },
      },
      500,
    ),
  );
  app.route('/v1', createB1TurnRoutes({ repository, sessions: sessionService() }));
  return app;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('B1 Turn HTTP routes', () => {
  it('requires a verified Ember Session and scopes repository calls from its AuthContext', async () => {
    const calls: { tenantId: Id; conversationId: Id; turnId: Id }[] = [];
    const repository: B1TurnRouteDependencies['repository'] = {
      getTurn(command) {
        calls.push(command);
        return Promise.resolve(runningTurn());
      },
      cancelTurn(command) {
        calls.push(command);
        return Promise.resolve(runningTurn());
      },
    };
    const app = buildApp(repository);

    const unauthenticated = await app.request(
      `/v1/conversations/${conversationId}/turns/${turnId}`,
    );
    const authenticated = await app.request(`/v1/conversations/${conversationId}/turns/${turnId}`, {
      headers: authHeaders(),
    });

    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual(runningTurn());
    expect(calls).toEqual([{ tenantId, conversationId, turnId }]);
  });

  it('strictly validates both UUID path components and rejects caller-supplied scope', async () => {
    const calls: unknown[] = [];
    const app = buildApp({
      getTurn(command) {
        calls.push(command);
        return Promise.resolve(runningTurn());
      },
      cancelTurn(command) {
        calls.push(command);
        return Promise.resolve(runningTurn());
      },
    });

    const badConversation = await app.request(`/v1/conversations/not-a-uuid/turns/${turnId}`, {
      headers: authHeaders(),
    });
    const badTurn = await app.request(`/v1/conversations/${conversationId}/turns/not-a-uuid`, {
      headers: authHeaders(),
    });
    const smuggledHeader = await app.request(
      `/v1/conversations/${conversationId}/turns/${turnId}`,
      {
        headers: { ...Object.fromEntries(new Headers(authHeaders())), 'x-tenant-id': randomUUID() },
      },
    );
    const smuggledQuery = await app.request(
      `/v1/conversations/${conversationId}/turns/${turnId}?tenant_id=${randomUUID()}`,
      { headers: authHeaders() },
    );

    expect([
      badConversation.status,
      badTurn.status,
      smuggledHeader.status,
      smuggledQuery.status,
    ]).toEqual([400, 400, 400, 400]);
    expect(calls).toHaveLength(0);
  });

  it('masks unknown and foreign Turns identically as 404', async () => {
    const app = buildApp({
      getTurn() {
        return Promise.resolve(null);
      },
      cancelTurn() {
        return Promise.reject(new Error('route should not call cancellation for this test'));
      },
    });
    const headers = authHeaders();
    const foreign = await app.request(`/v1/conversations/${conversationId}/turns/${turnId}`, {
      headers,
    });
    const unknown = await app.request(`/v1/conversations/${conversationId}/turns/${randomUUID()}`, {
      headers,
    });
    const foreignBody = await foreign.json();
    const unknownBody = await unknown.json();

    expect(foreign.status).toBe(404);
    expect(foreignBody).toEqual(unknownBody);
    expect(ErrorResponseSchema.safeParse(foreignBody).success).toBe(true);
  });

  it('returns 200 with an already-terminal cancellation DTO and rejects a request body', async () => {
    const terminal = B1AssistantTurnDtoSchema.parse({
      ...runningTurn(),
      status: 'cancelled',
      updated_at: '2026-11-05T00:01:00.000Z',
    });
    let calls = 0;
    const app = buildApp({
      getTurn() {
        return Promise.resolve(terminal);
      },
      cancelTurn(command) {
        calls += 1;
        expect(command.tenantId).toBe(tenantId);
        return Promise.resolve(terminal);
      },
    });
    const path = `/v1/conversations/${conversationId}/turns/${turnId}/cancel`;
    const headers = authHeaders();

    const first = await app.request(path, { method: 'POST', headers });
    const second = await app.request(path, { method: 'POST', headers });
    const withBody = await app.request(path, {
      method: 'POST',
      headers: { ...Object.fromEntries(new Headers(headers)), 'content-type': 'application/json' },
      body: '{}',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(terminal);
    expect(await second.json()).toEqual(terminal);
    expect(withBody.status).toBe(400);
    expect(calls).toBe(2);
  });

  it('accepts a bodyless cancellation over the real Node HTTP adapter', async () => {
    const terminal = B1AssistantTurnDtoSchema.parse({
      ...runningTurn(),
      status: 'cancelled',
      updated_at: '2026-11-05T00:01:00.000Z',
    });
    let cancels = 0;
    const app = buildApp({
      getTurn() {
        return Promise.resolve(terminal);
      },
      cancelTurn() {
        cancels += 1;
        return Promise.resolve(terminal);
      },
    });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });

    try {
      if (!server.listening) {
        await once(server, 'listening');
      }
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a bound IPv4 loopback HTTP listener');
      }
      const url = `http://127.0.0.1:${address.port}/v1/conversations/${conversationId}/turns/${turnId}/cancel`;

      // Node's Hono adapter can materialize an empty stream for a POST with no request bytes.
      // A null-body check would incorrectly produce 400 here even though the wire body is empty.
      const valid = await fetch(url, { method: 'POST', headers: authHeaders() });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual(terminal);

      const nonEmpty = await fetch(url, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: '{}',
      });
      expect(nonEmpty.status).toBe(400);
      expect(cancels).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it('parses every successful repository result through the frozen strict Turn DTO schema', async () => {
    const app = buildApp({
      getTurn() {
        return Promise.resolve({ ...runningTurn(), tenant_id: tenantId } as never);
      },
      cancelTurn() {
        return Promise.resolve(runningTurn());
      },
    });
    const response = await app.request(`/v1/conversations/${conversationId}/turns/${turnId}`, {
      headers: authHeaders(),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).not.toHaveProperty('tenant_id');
    expect(JSON.stringify(body)).not.toContain(tenantId);
  });
});
