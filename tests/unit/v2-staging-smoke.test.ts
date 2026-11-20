import { describe, expect, it } from 'vitest';
import { runV2StagingSmoke } from '../../infra/cloudflare/v2-staging-smoke.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('V2 staging smoke verifier', () => {
  it('passes when V2 staging and V1 non-regression endpoints are healthy', async () => {
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://v2.test/healthz') {
        return Promise.resolve(jsonResponse({ status: 'ok', service: 'ember-v2-edge' }, 200));
      }
      if (url === 'https://v2.test/readyz') {
        return Promise.resolve(
          jsonResponse(
            { status: 'ready', checks: { d1_recovery: { status: 'up', latencyMs: 12 } } },
            200,
          ),
        );
      }
      if (url === 'https://v2.test/v1/me') {
        return Promise.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401));
      }
      if (url === 'https://v2.test/v1/auth/session') {
        return Promise.resolve(jsonResponse({ error: { code: 'POLICY_DENIED' } }, 403));
      }
      if (url === 'https://v1.test/healthz') {
        return Promise.resolve(jsonResponse({ status: 'ok', service: 'ember-api' }, 200));
      }
      if (url === 'https://v1.test/readyz') {
        return Promise.resolve(
          jsonResponse(
            { status: 'ready', checks: { database: { status: 'up', latencyMs: 8 } } },
            200,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 500));
    };

    const result = await runV2StagingSmoke({
      v2BaseUrl: 'https://v2.test',
      v1BaseUrl: 'https://v1.test',
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks).toHaveLength(6);
  });

  it('fails closed when D1 readiness is down or dev login is unexpectedly accepted', async () => {
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://v2.test/healthz') {
        return Promise.resolve(jsonResponse({ status: 'ok' }, 200));
      }
      if (url === 'https://v2.test/readyz') {
        return Promise.resolve(
          jsonResponse({ status: 'unavailable', checks: { d1_recovery: { status: 'down' } } }, 503),
        );
      }
      if (url === 'https://v2.test/v1/me') {
        return Promise.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401));
      }
      if (url === 'https://v2.test/v1/auth/session') {
        return Promise.resolve(jsonResponse({ session: 'should-never-happen' }, 201));
      }
      return Promise.resolve(jsonResponse({}, 500));
    };

    const result = await runV2StagingSmoke({
      v2BaseUrl: 'https://v2.test',
      checkV1: false,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('/readyz'))).toBe(true);
    expect(result.errors.some((e) => e.includes('dev-denial'))).toBe(true);
  });
});
