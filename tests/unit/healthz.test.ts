import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { loadApiConfig } from '../../apps/api/src/env.js';
import type { ReadinessCheck } from '../../apps/api/src/readiness.js';

const fixedNow = (): Date => new Date('2026-01-01T00:00:00.000Z');

const readyCheck: ReadinessCheck = () =>
  Promise.resolve({
    status: 'ready',
    checks: { database: { status: 'up', latencyMs: 1 } },
  });

const downCheck: ReadinessCheck = () =>
  Promise.resolve({
    status: 'unavailable',
    checks: { database: { status: 'down', latencyMs: 2 } },
  });

describe('GET /healthz (liveness)', () => {
  it('returns 200 with a minimal liveness payload', async () => {
    const app = createApp({
      readiness: readyCheck,
      serviceVersion: '0.0.0-test',
      now: fixedNow,
    });

    const response = await app.request('/healthz');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'ember-api',
      version: '0.0.0-test',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns 200 over a real loopback socket even when readiness is down', async () => {
    const app = createApp({ readiness: downCheck, now: fixedNow });
    const server = serve({
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: 0,
      overrideGlobalObjects: false,
    });

    if (!server.listening) {
      await once(server, 'listening');
    }

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address from the test server');
    }

    try {
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ status: 'ok', service: 'ember-api' });

      // Liveness and readiness must stay distinguishable.
      const readiness = await fetch(`http://127.0.0.1:${address.port}/readyz`);
      expect(readiness.status).toBe(503);
      await expect(readiness.json()).resolves.toMatchObject({
        status: 'unavailable',
        checks: { database: { status: 'down' } },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

describe('IPv6 loopback listener', () => {
  it('binds the normalised host returned by loadApiConfig', async (context) => {
    const config = loadApiConfig({ EMBER_HOST: '[::1]' });
    expect(config.host).toBe('::1');

    const app = createApp({ readiness: readyCheck, now: fixedNow });
    let server: ReturnType<typeof serve> | undefined;

    try {
      server = serve({
        fetch: app.fetch,
        hostname: config.host,
        port: 0,
        overrideGlobalObjects: false,
      });
      if (!server.listening) {
        await once(server, 'listening');
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
        context.skip(`IPv6 loopback is unavailable in this environment (${code})`);
        return;
      }
      throw error;
    }

    if (server === undefined) {
      throw new Error('expected the test server to start');
    }

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address from the test server');
    }

    try {
      const response = await fetch(`http://[::1]:${address.port}/healthz`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

describe('GET /readyz (readiness)', () => {
  it('returns 200 when the database probe succeeds', async () => {
    const app = createApp({ readiness: readyCheck, now: fixedNow });

    const response = await app.request('/readyz');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ready',
      checks: { database: { status: 'up', latencyMs: 1 } },
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns 503 when no probe is wired, without affecting /healthz', async () => {
    const app = createApp({ now: fixedNow });

    const response = await app.request('/readyz');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'not_configured' } },
    });

    expect((await app.request('/healthz')).status).toBe(200);
  });
});

describe('unknown routes', () => {
  it('returns a JSON 404 without internal details', async () => {
    const app = createApp({ readiness: readyCheck });
    const response = await app.request('/v1/tasks');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'not_found', message: 'Route not found' },
    });
  });
});
