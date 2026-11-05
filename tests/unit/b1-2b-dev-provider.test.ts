import { randomUUID } from 'node:crypto';
import type { Id } from '@ember/domain';
import type { B1MeResponse } from '@ember/contracts';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createB1AuthRuntimeFromEnvironment } from '../../apps/api/src/auth/b1-auth-runtime.js';
import {
  assertDevProviderBootConfig,
  createDevProviderPolicy,
  isLoopbackOnlyListener,
  loadB1AuthEnvironment,
  type LoopbackListener,
} from '../../apps/api/src/auth/dev-provider-policy.js';
import { createDevIdentityVerifier } from '../../apps/api/src/auth/identity-verifier.js';
import {
  createSessionService,
  type B1MeProjectionReader,
  type B1SessionPorts,
} from '../../apps/api/src/auth/session-service.js';
import type { B1SessionRuntime } from '../../apps/api/src/auth/b1-auth-runtime.js';
import { ME_PATH, SESSION_PATH } from '../../apps/api/src/auth/session-routes.js';

/**
 * R-9 / Q-1: `provider: "dev"` is reachable only in an isolated local/test/CI run with an
 * explicit opt-in and an ACTUAL loopback-only listener. A refused path answers 404 exactly
 * like an unknown route, and a request's Host header never authorizes anything.
 */

const FIXED_NOW = new Date('2026-11-05T02:00:00.000Z');
const REQUEST_ID = 'req-b1-2b-dev';

type Env = Record<string, string | undefined>;

function eligibleEnv(overrides: Env = {}): Env {
  return {
    NODE_ENV: 'test',
    EMBER_ENV: 'test',
    EMBER_HOST: '127.0.0.1',
    EMBER_DEV_PROVIDER_ENABLED: 'true',
    EMBER_DEV_PROVIDER_ISOLATED: 'true',
    ...overrides,
  };
}

function loopbackListener(): LoopbackListener {
  return { address: '127.0.0.1', family: 'IPv4', port: 8787 };
}

function evaluate(env: Env, listener: () => LoopbackListener = loopbackListener) {
  return createDevProviderPolicy({
    environment: loadB1AuthEnvironment(env),
    actualListener: listener,
  }).evaluate();
}

/** Minimal in-memory ports used only by this test file. */
interface FakePorts extends B1SessionPorts {
  readonly subjects: string[];
  readonly consumers: Map<string, Id>;
}

function fakePorts(): FakePorts {
  const subjects: string[] = [];
  const consumers = new Map<string, Id>();
  const me: B1MeProjectionReader = {
    getMeForTenant: (): Promise<B1MeResponse | null> => Promise.resolve(null),
  };

  return {
    subjects,
    consumers,
    me,
    provisioning: {
      provisionIdentityAndCreateSession: (command) => {
        subjects.push(command.providerSubject);
        const consumerId = consumers.get(command.providerSubject) ?? randomUUID();
        consumers.set(command.providerSubject, consumerId);
        const tenantId = randomUUID();
        const sessionId = randomUUID();
        return Promise.resolve({
          identity: {
            consumerId,
            tenantId,
            principalId: randomUUID(),
            agentId: randomUUID(),
            conversationId: randomUUID(),
          },
          session: {
            sessionId,
            consumerId,
            tenantId,
            expiresAt: command.expiresAt,
            idleExpiresAt: command.idleExpiresAt,
            revokedAt: null,
          },
        });
      },
    },
    sessions: {
      findActiveSession: () => Promise.resolve(null),
      rotateSession: () => Promise.resolve({ kind: 'inactive' }),
      revokeSession: () => Promise.resolve(),
    },
  };
}

function runtimeFor(devEnabled: boolean, ports: B1SessionPorts = fakePorts()): B1SessionRuntime {
  return {
    service: createSessionService({ ports, now: () => FIXED_NOW }),
    appleVerifier: {
      provider: 'apple',
      verify: () => Promise.resolve({ provider: 'apple', providerSubject: 'apple-sub-fixture' }),
    },
    devVerifier: createDevIdentityVerifier(),
    devProvider: {
      evaluate: () => ({ enabled: devEnabled, deniedBy: [] }),
    },
    me: ports.me,
  };
}

function appFor(devEnabled: boolean, ports: B1SessionPorts = fakePorts()) {
  return createApp({
    b1Session: runtimeFor(devEnabled, ports),
    requestIdGenerator: () => REQUEST_ID,
  });
}

async function postDev(app: ReturnType<typeof createApp>, host?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (host !== undefined) {
    headers.host = host;
  }

  return await app.request(SESSION_PATH, {
    method: 'POST',
    headers,
    body: JSON.stringify({ provider: 'dev', identity_token: 'local-subject', nonce: 'ignored' }),
  });
}

describe('R-9 dev-provider configuration matrix', () => {
  it('enables the dev path only when all four independent conditions hold', () => {
    expect(evaluate(eligibleEnv())).toEqual({ enabled: true, deniedBy: [] });
  });

  it('denies production and staging NODE_ENV', () => {
    for (const nodeEnv of ['production', 'staging']) {
      const decision = evaluate(eligibleEnv({ NODE_ENV: nodeEnv }));
      expect(decision.enabled).toBe(false);
      expect(decision.deniedBy).toContain('production_environment');
    }
  });

  it('denies a missing explicit opt-in', () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      const decision = evaluate(eligibleEnv({ EMBER_DEV_PROVIDER_ENABLED: value }));
      expect(decision.enabled).toBe(false);
      expect(decision.deniedBy).toContain('opt_in_missing');
    }
  });

  it('denies a run that did not declare an isolated local/test/CI environment', () => {
    const missing = evaluate(eligibleEnv({ EMBER_DEV_PROVIDER_ISOLATED: undefined }));
    expect(missing.deniedBy).toContain('not_isolated_environment');

    for (const emberEnv of ['local', 'test', 'ci']) {
      expect(
        evaluate(eligibleEnv({ EMBER_ENV: emberEnv, EMBER_DEV_PROVIDER_ISOLATED: 'true' })).enabled,
      ).toBe(true);
    }
  });

  it('denies a non-loopback, unbound or unix-socket listener', () => {
    expect(isLoopbackOnlyListener({ address: '0.0.0.0', family: 'IPv4', port: 8787 })).toBe(false);
    expect(isLoopbackOnlyListener({ address: '::', family: 'IPv6', port: 8787 })).toBe(false);
    expect(isLoopbackOnlyListener({ address: '::1', family: 'IPv6', port: 8787 })).toBe(true);
    expect(isLoopbackOnlyListener(null)).toBe(false);
    expect(isLoopbackOnlyListener('/tmp/ember.sock')).toBe(false);

    for (const address of ['0.0.0.0', '192.168.1.10']) {
      const decision = evaluate(eligibleEnv(), () => ({
        address,
        family: 'IPv4',
        port: 8787,
      }));
      expect(decision.enabled).toBe(false);
      expect(decision.deniedBy).toContain('listener_not_loopback');
    }

    expect(evaluate(eligibleEnv(), () => null).deniedBy).toContain('listener_not_loopback');
  });

  it('denies any process that allowed a non-loopback bind', () => {
    const env = eligibleEnv({ EMBER_ALLOW_NON_LOOPBACK_BIND: 'true' });
    const decision = evaluate(env);

    expect(decision.enabled).toBe(false);
    expect(decision.deniedBy).toContain('listener_not_loopback');
  });
});

describe('R-9 boot-time refusals', () => {
  it('refuses to start in production with the dev provider enabled', () => {
    expect(() =>
      assertDevProviderBootConfig(loadB1AuthEnvironment(eligibleEnv({ NODE_ENV: 'production' }))),
    ).toThrow(/refusing to start/);
  });

  it('refuses a non-loopback bind with the dev provider enabled', () => {
    expect(() =>
      assertDevProviderBootConfig(
        loadB1AuthEnvironment(
          eligibleEnv({ EMBER_HOST: '0.0.0.0', EMBER_ALLOW_NON_LOOPBACK_BIND: 'true' }),
        ),
      ),
    ).toThrow(/loopback EMBER_HOST/);
    expect(() =>
      assertDevProviderBootConfig(
        loadB1AuthEnvironment(eligibleEnv({ EMBER_ALLOW_NON_LOOPBACK_BIND: 'true' })),
      ),
    ).toThrow(/EMBER_ALLOW_NON_LOOPBACK_BIND/);
  });

  it('allows a production boot with the dev provider disabled', () => {
    expect(() =>
      assertDevProviderBootConfig(
        loadB1AuthEnvironment(
          eligibleEnv({ NODE_ENV: 'production', EMBER_DEV_PROVIDER_ENABLED: 'false' }),
        ),
      ),
    ).not.toThrow();
  });

  it('fails closed when Apple verification configuration is absent or a placeholder', () => {
    expect(() =>
      createB1AuthRuntimeFromEnvironment({ env: eligibleEnv(), ports: fakePorts() }),
    ).toThrow(/EMBER_APPLE_BUNDLE_ID/);
    expect(() =>
      createB1AuthRuntimeFromEnvironment({
        env: { ...eligibleEnv(), EMBER_APPLE_BUNDLE_ID: 'com.example.ember' },
        ports: fakePorts(),
      }),
    ).toThrow(/bundle id/);
  });

  it('builds a runtime with real verification configuration and applies boot assertions', () => {
    const runtime = createB1AuthRuntimeFromEnvironment({
      env: { ...eligibleEnv(), EMBER_APPLE_BUNDLE_ID: 'com.ember.alpha.test' },
      ports: fakePorts(),
      actualListener: loopbackListener,
    });

    expect(runtime.devProvider.evaluate().enabled).toBe(true);
    expect(() =>
      createB1AuthRuntimeFromEnvironment({
        env: {
          ...eligibleEnv({ NODE_ENV: 'production' }),
          EMBER_APPLE_BUNDLE_ID: 'com.ember.alpha.test',
        },
        ports: fakePorts(),
      }),
    ).toThrow(/refusing to start/);
  });
});

describe('R-9 dev-provider HTTP behaviour', () => {
  it('returns 404 identical to an unknown route when the gate denies the dev path', async () => {
    const app = appFor(false);
    const refused = await postDev(app);
    const unknown = await app.request('/v1/no-such-route', { method: 'GET' });

    expect(refused.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await refused.json()).toEqual(await unknown.json());
  });

  it('returns 201 through the real provisioning path when the gate allows it', async () => {
    const ports = fakePorts();
    const response = await postDev(appFor(true, ports));

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.access_token).toMatch(/^ems_[A-Za-z0-9_-]+$/);
    expect(body).not.toHaveProperty('tenant_id');
    expect(body).not.toHaveProperty('principal_id');
    expect(body).not.toHaveProperty('policy_version');
    expect(ports.subjects).toHaveLength(1);
  });

  it('never authorizes dev authentication from the request Host header', async () => {
    const ports = fakePorts();
    const loopbackRuntime = createDevProviderPolicy({
      environment: loadB1AuthEnvironment(eligibleEnv()),
      actualListener: loopbackListener,
    });
    const nonLoopbackRuntime = createDevProviderPolicy({
      environment: loadB1AuthEnvironment(
        eligibleEnv({ EMBER_HOST: '0.0.0.0', EMBER_ALLOW_NON_LOOPBACK_BIND: 'true' }),
      ),
      actualListener: () => ({ address: '0.0.0.0', family: 'IPv4', port: 8787 }),
    });

    const loopbackApp = createApp({
      b1Session: { ...runtimeFor(true, ports), devProvider: loopbackRuntime },
      requestIdGenerator: () => REQUEST_ID,
    });
    const exposedApp = createApp({
      b1Session: { ...runtimeFor(true, ports), devProvider: nonLoopbackRuntime },
      requestIdGenerator: () => REQUEST_ID,
    });

    // An attacker-controlled Host cannot turn a non-loopback listener into a local one.
    expect((await postDev(exposedApp, 'localhost')).status).toBe(404);
    expect((await postDev(exposedApp, '127.0.0.1')).status).toBe(404);
    // And a forged external Host cannot disable a genuinely loopback-only listener.
    expect((await postDev(loopbackApp, 'attacker.example')).status).toBe(201);
    expect(ports.subjects).toHaveLength(1);
  });

  it('keeps the Apple path available when the dev path is refused', async () => {
    const app = appFor(false);
    const response = await app.request(SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'apple', identity_token: 'signed-jwt', nonce: 'nonce' }),
    });

    expect(response.status).toBe(201);
  });

  it('does not register any new endpoint when no runtime is injected', async () => {
    const app = createApp();

    for (const [path, method] of [
      [SESSION_PATH, 'POST'],
      [SESSION_PATH, 'DELETE'],
      ['/v1/auth/session/refresh', 'POST'],
      [ME_PATH, 'GET'],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(404);
    }
  });
});
