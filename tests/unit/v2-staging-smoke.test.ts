import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseV2StagingSmokeArgs,
  runV2StagingSmoke,
  runV2StagingSmokeCli,
} from '../../infra/cloudflare/v2-staging-smoke.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('V2 staging smoke verifier', () => {
  it('passes when V2 staging (incl. /v2/memories and /v2/schedules 401) and V1 are healthy', async () => {
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
      if (
        url === 'https://v2.test/v1/me' ||
        url === 'https://v2.test/v2/memories' ||
        url === 'https://v2.test/v2/schedules'
      ) {
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
      checkV1: true,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks).toHaveLength(8);
  });

  it('fails closed when D1 readiness is down, routes drift (404), or dev login is accepted', async () => {
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
      if (url === 'https://v2.test/v2/memories' || url === 'https://v2.test/v2/schedules') {
        return Promise.resolve(jsonResponse({ error: { code: 'NOT_FOUND' } }, 404));
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
    expect(result.errors.some((e) => e.includes('/v2/memories'))).toBe(true);
    expect(result.errors.some((e) => e.includes('/v2/schedules'))).toBe(true);
    expect(result.errors.some((e) => e.includes('dev-denial'))).toBe(true);
  });

  it('defaults the CLI entrypoint to V2-only unless --check-v1 is explicitly passed', async () => {
    expect(parseV2StagingSmokeArgs([], {})).toMatchObject({ checkV1: false });
    expect(parseV2StagingSmokeArgs(['--skip-v1'], {})).toMatchObject({ checkV1: false });
    expect(parseV2StagingSmokeArgs(['--check-v1'], {})).toMatchObject({ checkV1: true });
    expect(parseV2StagingSmokeArgs(['--check-v1', '--skip-v1'], {})).toMatchObject({
      checkV1: false,
    });

    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(url);
      if (url.endsWith('/healthz')) {
        return Promise.resolve(jsonResponse({ status: 'ok' }, 200));
      }
      if (url.endsWith('/readyz')) {
        return Promise.resolve(
          jsonResponse({ status: 'ready', checks: { d1_recovery: { status: 'up' } } }, 200),
        );
      }
      if (url.endsWith('/v1/me') || url.endsWith('/v2/memories') || url.endsWith('/v2/schedules')) {
        return Promise.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401));
      }
      if (url.endsWith('/v1/auth/session')) {
        return Promise.resolve(jsonResponse({ error: { code: 'POLICY_DENIED' } }, 403));
      }
      return Promise.resolve(jsonResponse({}, 500));
    };

    const stdoutLines: string[] = [];
    const cliResult = await runV2StagingSmokeCli({
      args: [],
      env: { EMBER_V2_STAGING_URL: 'https://v2.test', EMBER_V1_API_URL: 'https://v1.test' },
      fetchImpl,
      stdout: (msg) => stdoutLines.push(msg),
      stderr: () => undefined,
    });

    expect(cliResult.exitCode).toBe(0);
    expect(cliResult.result.checks).toHaveLength(6);
    expect(requestedUrls.every((u) => u.startsWith('https://v2.test/'))).toBe(true);
    expect(stdoutLines.join('')).toContain('EMBER_V2_STAGING_SMOKE_OK');

    // Also execute the real CLI entrypoint in a child process against a local loopback server.
    const childRequestedPaths: string[] = [];
    const server = createServer((req, res) => {
      const reqPath = req.url ?? '/';
      childRequestedPaths.push(reqPath);
      res.setHeader('content-type', 'application/json');
      if (reqPath === '/healthz') {
        res.statusCode = 200;
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (reqPath === '/readyz') {
        res.statusCode = 200;
        res.end(JSON.stringify({ status: 'ready', checks: { d1_recovery: { status: 'up' } } }));
      } else if (
        reqPath === '/v1/me' ||
        reqPath === '/v2/memories' ||
        reqPath === '/v2/schedules'
      ) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }));
      } else if (reqPath === '/v1/auth/session') {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: { code: 'POLICY_DENIED' } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      }
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const scriptPath = resolve(
        import.meta.dirname,
        '../../infra/cloudflare/v2-staging-smoke.mjs',
      );
      const runChild = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolveChild, rejectChild) => {
          const child = spawn(process.execPath, [scriptPath], {
            env: {
              ...process.env,
              EMBER_V2_STAGING_URL: `http://127.0.0.1:${port}`,
              EMBER_V1_API_URL: 'http://127.0.0.1:1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          let err = '';
          child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
          child.stderr.setEncoding('utf8').on('data', (c) => (err += c));
          child.once('error', rejectChild);
          child.once('close', (code) => resolveChild({ code, stdout: out, stderr: err }));
        },
      );

      expect(runChild.code).toBe(0);
      expect(runChild.stdout).toContain('EMBER_V2_STAGING_SMOKE_OK');
      expect(childRequestedPaths).toEqual([
        '/healthz',
        '/readyz',
        '/v1/me',
        '/v2/memories',
        '/v2/schedules',
        '/v1/auth/session',
      ]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
