import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  G4_BLOCKED_MEDIA_TYPES,
  G4_DEFAULT_SANDBOX_OWNER,
  G4_SYNTHETIC_CSV_FIXTURE,
  assertCanaryExecutionAuthorized,
  isLoopbackUrl,
  runG4DaytonaCanary,
  validateDownloadedArtifact,
} from '../../infra/cloudflare/v2-g4-daytona-canary.mjs';
import { DaytonaSdkSandboxClient } from '../../packages/sandbox-daytona/src/sdk-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

function requestJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
}

describe('G4 Daytona canary validation helpers', () => {
  it('uses a pure synthetic < 1 KiB CSV fixture with verified SHA-256 and zero PII', () => {
    const encoded = new TextEncoder().encode(G4_SYNTHETIC_CSV_FIXTURE.content);
    expect(G4_SYNTHETIC_CSV_FIXTURE.sizeBytes).toBe(encoded.byteLength);
    expect(G4_SYNTHETIC_CSV_FIXTURE.sizeBytes).toBeLessThan(1024);
    expect(G4_SYNTHETIC_CSV_FIXTURE.sha256).toBe(sha256Hex(encoded));
    expect(G4_SYNTHETIC_CSV_FIXTURE.content).not.toMatch(/@|\b\d{3}-\d{2}-\d{4}\b/);
  });

  it('refuses non-loopback targets unless explicit Founder authorization is supplied', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8787')).toBe(true);
    expect(isLoopbackUrl('https://ember-v2-staging.workers.dev')).toBe(false);

    expect(() =>
      assertCanaryExecutionAuthorized({
        baseUrl: 'http://127.0.0.1:8787',
        confirmFounderAuthorization: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertCanaryExecutionAuthorized({
        baseUrl: 'https://ember-v2-staging.workers.dev',
        confirmFounderAuthorization: false,
      }),
    ).toThrow(/Founder authorization/i);

    expect(() =>
      assertCanaryExecutionAuthorized({
        baseUrl: 'https://ember-v2-staging.workers.dev',
        confirmFounderAuthorization: true,
      }),
    ).not.toThrow();
  });

  it('validates artifact SHA-256, safe ASCII filename, blocked web MIME, size, and security headers', () => {
    const payload = new TextEncoder().encode(JSON.stringify({ rows: 4, totalRevenue: 300 }));
    const sha256 = sha256Hex(payload);
    const artifact = {
      filename: 'summary.json',
      media_type: 'application/json',
      size: payload.byteLength,
      sha256,
    };

    const valid = validateDownloadedArtifact({
      artifact,
      bytes: payload,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(payload.byteLength),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      }),
    });
    expect(valid.ok).toBe(true);
    expect(valid.errors).toEqual([]);
    expect(valid.computedSha256).toBe(sha256);

    const htmlRejected = validateDownloadedArtifact({
      artifact: { ...artifact, filename: 'report.html', media_type: 'text/html' },
      bytes: payload,
      headers: {
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
    expect(htmlRejected.ok).toBe(false);
    expect(G4_BLOCKED_MEDIA_TYPES.has('text/html')).toBe(true);
    expect(
      htmlRejected.errors.some((e) => e.includes('blocked or missing output artifact media_type')),
    ).toBe(true);

    const traversalRejected = validateDownloadedArtifact({
      artifact: { ...artifact, filename: '../escape.json' },
      bytes: payload,
      headers: {
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
    expect(traversalRejected.ok).toBe(false);
    expect(
      traversalRejected.errors.some((e) => e.includes('unsafe output artifact filename')),
    ).toBe(true);

    const tamperedRejected = validateDownloadedArtifact({
      artifact: { ...artifact, sha256: '0'.repeat(64) },
      bytes: payload,
      headers: {
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
    expect(tamperedRejected.ok).toBe(false);
    expect(tamperedRejected.errors.some((e) => e.includes('sha256 mismatch'))).toBe(true);

    const missingHeadersRejected = validateDownloadedArtifact({
      artifact,
      bytes: payload,
      headers: {},
    });
    expect(missingHeadersRejected.ok).toBe(false);
    expect(missingHeadersRejected.errors.some((e) => e.includes('nosniff'))).toBe(true);
    expect(missingHeadersRejected.errors.some((e) => e.includes('no-store'))).toBe(true);

    const contentTypeMismatchRejected = validateDownloadedArtifact({
      artifact,
      bytes: payload,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(payload.byteLength),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
    expect(contentTypeMismatchRejected.ok).toBe(false);
    expect(
      contentTypeMismatchRejected.errors.some((e) => e.includes('blocked response Content-Type')),
    ).toBe(true);
  });
});

describe('runG4DaytonaCanary orchestration (mocked HTTP, zero real spend)', () => {
  it('verifies direct task replay, artifact integrity, NL delegation, cancellation, and orphan sweep', async () => {
    const outBytes = new TextEncoder().encode('region,revenue\neast,150\n');
    const outSha = sha256Hex(outBytes);
    let directPollCount = 0;
    let nlMessagePosted = false;
    let cancelPollCount = 0;

    const fakeFetch: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      const path = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (path === '/healthz') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
      if (path === '/readyz') return Promise.resolve(jsonResponse(200, { status: 'ready' }));
      if (path === '/v1/me') {
        return Promise.resolve(
          jsonResponse(200, {
            consumer_id: 'c_canary',
            agent: { agent_id: 'agent_canary', display_name: 'Canary' },
            conversation: {
              conversation_id: 'conv_canary',
              transcript_epoch: 1,
              created_at: '2026-11-21T00:00:00.000Z',
              updated_at: '2026-11-21T00:00:00.000Z',
            },
          }),
        );
      }
      if (path === '/v1/me/uploads' && method === 'POST') {
        return Promise.resolve(jsonResponse(201, { upload_id: 'up_csv_1' }));
      }
      if (path === '/v2/tasks/python' && method === 'POST') {
        const parsed = requestJsonBody(init) as { title?: string };
        if (parsed.title?.includes('Cancellation')) {
          return Promise.resolve(
            jsonResponse(201, {
              created: true,
              task: { task_id: 'task_cancel', status: 'queued' },
            }),
          );
        }
        const key = new Headers(init?.headers).get('idempotency-key') ?? '';
        // First call returns 201 created, second call returns 200 idempotent replay
        const isFirst = directPollCount === 0 && key.length > 0;
        if (isFirst) {
          directPollCount = 1;
          return Promise.resolve(
            jsonResponse(201, {
              created: true,
              task: { task_id: 'task_direct', status: 'queued' },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            created: false,
            task: { task_id: 'task_direct', status: 'queued' },
          }),
        );
      }
      if (path === '/v1/me/tasks/task_direct' && method === 'GET') {
        return Promise.resolve(
          jsonResponse(200, {
            task_id: 'task_direct',
            kind: 'python.agent',
            status: 'completed',
          }),
        );
      }
      if (path === '/v1/me/tasks/task_direct/result') {
        return Promise.resolve(
          jsonResponse(200, {
            result_state: 'available',
            result: {
              simulated: false,
              model_label: 'deepseek/deepseek-v4.1-flash-1017',
            },
          }),
        );
      }
      if (path === '/v1/me/tasks/task_direct/events') {
        return Promise.resolve(jsonResponse(200, { events: [{ kind: 'task.completed' }] }));
      }
      if (path === '/v1/me/tasks/task_direct/artifacts') {
        return Promise.resolve(
          jsonResponse(200, {
            artifacts: [
              {
                artifact_id: 'art_in_1',
                created_by: 'user',
                filename: G4_SYNTHETIC_CSV_FIXTURE.filename,
                media_type: 'text/csv',
                size: G4_SYNTHETIC_CSV_FIXTURE.sizeBytes,
                sha256: G4_SYNTHETIC_CSV_FIXTURE.sha256,
              },
              {
                artifact_id: 'art_out_1',
                created_by: 'run',
                filename: 'summary.csv',
                media_type: 'text/csv',
                size: outBytes.byteLength,
                sha256: outSha,
              },
            ],
          }),
        );
      }
      if (path === '/v1/conversations/conv_canary/messages' && method === 'POST') {
        nlMessagePosted = true;
        return Promise.resolve(jsonResponse(201, { accepted: true }));
      }
      if (path === '/v1/me/tasks' && method === 'GET') {
        return Promise.resolve(
          jsonResponse(200, {
            tasks: [
              { task_id: 'task_historical', kind: 'python.agent', status: 'completed' },
              { task_id: 'task_direct', kind: 'python.agent', status: 'completed' },
              ...(nlMessagePosted
                ? [{ task_id: 'task_nl', kind: 'python.agent', status: 'completed' }]
                : []),
            ],
          }),
        );
      }
      if (path === '/v1/conversations/conv_canary/messages' && method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? '0');
        if (after === 0) {
          return Promise.resolve(
            jsonResponse(200, {
              messages: [{ kind: 'user', text: 'older message' }],
              has_more: true,
              next_after: 50,
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            messages: [{ kind: 'task_reference', task_id: 'task_nl' }],
            has_more: false,
            next_after: 51,
          }),
        );
      }
      if (path === '/v1/me/tasks/task_nl/artifacts') {
        return Promise.resolve(
          jsonResponse(200, {
            artifacts: [
              {
                artifact_id: 'art_nl_in',
                created_by: 'user',
                filename: G4_SYNTHETIC_CSV_FIXTURE.filename,
                media_type: 'text/csv',
                size: G4_SYNTHETIC_CSV_FIXTURE.sizeBytes,
                sha256: G4_SYNTHETIC_CSV_FIXTURE.sha256,
              },
              {
                artifact_id: 'art_nl_out',
                created_by: 'run',
                filename: 'nl_summary.csv',
                media_type: 'text/csv',
                size: outBytes.byteLength,
                sha256: outSha,
              },
            ],
          }),
        );
      }
      if (path === '/v1/me/tasks/task_cancel' && method === 'GET') {
        cancelPollCount += 1;
        return Promise.resolve(
          jsonResponse(200, {
            task_id: 'task_cancel',
            kind: 'python.agent',
            status: cancelPollCount === 1 ? 'running' : 'cancelled',
          }),
        );
      }
      if (path === '/v1/me/tasks/task_cancel/cancel' && method === 'POST') {
        return Promise.resolve(
          jsonResponse(202, { task_id: 'task_cancel', cancel_requested: true, terminal: false }),
        );
      }
      if (path === '/v1/me/tasks/task_cancel/artifacts') {
        return Promise.resolve(jsonResponse(200, { artifacts: [] }));
      }
      if (path.startsWith('/v1/me/artifacts/')) {
        return Promise.resolve(
          new Response(outBytes, {
            status: 200,
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-length': String(outBytes.byteLength),
              'x-content-type-options': 'nosniff',
              'cache-control': 'no-store',
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { error: `Unhandled ${method} ${path}` }));
    };

    const sweepOrphans = vi.fn(() =>
      Promise.resolve({
        liveCount: 0,
        destroyed: [],
        failed: [],
      }),
    );

    const report = await runG4DaytonaCanary({
      baseUrl: 'http://127.0.0.1:8787',
      bearerToken: 'test-token',
      includeNlChat: true,
      includeCancellation: true,
      pollIntervalMs: 5,
      cancelWaitForRunningMs: 500,
      fetchImpl: fakeFetch,
      sweepOrphans,
    });

    expect(report.ok).toBe(true);
    expect(report.directTask.taskId).toBe('task_direct');
    expect(report.directTask.simulated).toBe(false);
    expect(report.directTask.outputs).toHaveLength(1);
    expect(report.nlDelegation?.taskId).toBe('task_nl');
    expect(report.cancellation).toEqual({
      taskId: 'task_cancel',
      statusBeforeCancel: 'running',
      terminalStatus: 'cancelled',
      committedRunArtifacts: 0,
    });
    expect(report.cleanup).toEqual({
      checked: true,
      liveCount: 0,
      destroyed: [],
      failed: [],
    });
    expect(sweepOrphans).toHaveBeenCalledWith({ owner: G4_DEFAULT_SANDBOX_OWNER });
  });

  it('refuses simulated results by default and fails if cancelled task leaks outputs or orphans remain', async () => {
    const baseFetch = (opts: {
      simulated?: boolean;
      duplicateOutput?: boolean;
      leakedCancelOutput?: boolean;
    }): typeof fetch => {
      const outBytes = new TextEncoder().encode('ok\n');
      const outSha = sha256Hex(outBytes);
      let directPosted = false;
      return (input, init) => {
        const path = requestUrl(input).pathname;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (path === '/healthz') return Promise.resolve(jsonResponse(200, { status: 'ok' }));
        if (path === '/readyz') return Promise.resolve(jsonResponse(200, { status: 'ready' }));
        if (path === '/v1/me') {
          return Promise.resolve(
            jsonResponse(200, {
              agent: { agent_id: 'a1' },
              conversation: { conversation_id: 'c1', transcript_epoch: 1 },
            }),
          );
        }
        if (path === '/v1/me/uploads') {
          return Promise.resolve(jsonResponse(201, { upload_id: 'up1' }));
        }
        if (path === '/v2/tasks/python') {
          const parsed = requestJsonBody(init) as { title?: string };
          if (parsed.title?.includes('Cancellation')) {
            return Promise.resolve(
              jsonResponse(201, {
                created: true,
                task: { task_id: 't_cancel', status: 'running' },
              }),
            );
          }
          if (!directPosted) {
            directPosted = true;
            return Promise.resolve(
              jsonResponse(201, { created: true, task: { task_id: 't1', status: 'queued' } }),
            );
          }
          return Promise.resolve(
            jsonResponse(200, { created: false, task: { task_id: 't1', status: 'queued' } }),
          );
        }
        if (path === '/v1/me/tasks/t1') {
          return Promise.resolve(jsonResponse(200, { task_id: 't1', status: 'completed' }));
        }
        if (path === '/v1/me/tasks/t1/result') {
          return Promise.resolve(
            jsonResponse(200, {
              result_state: 'available',
              result: {
                simulated: opts.simulated ?? false,
                model_label: 'deepseek/deepseek-v4.1-flash-1017',
              },
            }),
          );
        }
        if (path === '/v1/me/tasks/t1/events') {
          return Promise.resolve(jsonResponse(200, { events: [] }));
        }
        if (path === '/v1/me/tasks/t1/artifacts') {
          const outputs = opts.duplicateOutput
            ? [
                {
                  artifact_id: 'o1',
                  created_by: 'run',
                  filename: 'dup.txt',
                  media_type: 'text/plain',
                  size: outBytes.byteLength,
                  sha256: outSha,
                },
                {
                  artifact_id: 'o2',
                  created_by: 'run',
                  filename: 'dup.txt',
                  media_type: 'text/plain',
                  size: outBytes.byteLength,
                  sha256: outSha,
                },
              ]
            : [
                {
                  artifact_id: 'o1',
                  created_by: 'run',
                  filename: 'out.txt',
                  media_type: 'text/plain',
                  size: outBytes.byteLength,
                  sha256: outSha,
                },
              ];
          return Promise.resolve(
            jsonResponse(200, {
              artifacts: [
                {
                  artifact_id: 'i1',
                  created_by: 'user',
                  filename: G4_SYNTHETIC_CSV_FIXTURE.filename,
                  media_type: 'text/csv',
                  size: G4_SYNTHETIC_CSV_FIXTURE.sizeBytes,
                  sha256: G4_SYNTHETIC_CSV_FIXTURE.sha256,
                },
                ...outputs,
              ],
            }),
          );
        }
        if (path.startsWith('/v1/me/artifacts/')) {
          return Promise.resolve(
            new Response(outBytes, {
              status: 200,
              headers: {
                'content-type': 'text/plain; charset=utf-8',
                'content-length': String(outBytes.byteLength),
                'x-content-type-options': 'nosniff',
                'cache-control': 'no-store',
              },
            }),
          );
        }
        if (path === '/v1/me/tasks/t_cancel/cancel' && method === 'POST') {
          return Promise.resolve(
            jsonResponse(200, { task_id: 't_cancel', cancel_requested: true }),
          );
        }
        if (path === '/v1/me/tasks/t_cancel') {
          return Promise.resolve(jsonResponse(200, { task_id: 't_cancel', status: 'cancelled' }));
        }
        if (path === '/v1/me/tasks/t_cancel/artifacts') {
          return Promise.resolve(
            jsonResponse(200, {
              artifacts: opts.leakedCancelOutput
                ? [{ artifact_id: 'bad', created_by: 'run', filename: 'leak.txt' }]
                : [],
            }),
          );
        }
        return Promise.resolve(jsonResponse(404, {}));
      };
    };

    await expect(
      runG4DaytonaCanary({
        baseUrl: 'http://127.0.0.1:8787',
        bearerToken: 't',
        pollIntervalMs: 5,
        fetchImpl: baseFetch({ simulated: true }),
      }),
    ).rejects.toThrow(/Refusing simulated result/i);

    await expect(
      runG4DaytonaCanary({
        baseUrl: 'http://127.0.0.1:8787',
        bearerToken: 't',
        pollIntervalMs: 5,
        fetchImpl: baseFetch({ duplicateOutput: true }),
      }),
    ).rejects.toThrow(/Duplicate output artifact/i);

    await expect(
      runG4DaytonaCanary({
        baseUrl: 'http://127.0.0.1:8787',
        bearerToken: 't',
        pollIntervalMs: 5,
        fetchImpl: baseFetch({ leakedCancelOutput: true }),
      }),
    ).rejects.toThrow(/committed output artifact/i);

    await expect(
      runG4DaytonaCanary({
        baseUrl: 'http://127.0.0.1:8787',
        bearerToken: 't',
        pollIntervalMs: 5,
        includeCancellation: false,
        fetchImpl: baseFetch({}),
        sweepOrphans: () =>
          Promise.resolve({
            liveCount: 1,
            destroyed: ['sbx_leaked'],
            failed: [],
          }),
      }),
    ).rejects.toThrow(/Daytona cleanup check failed/i);
  });
});

describe('DaytonaSdkSandboxClient create timeout leak cleanup', () => {
  it('deletes a partially created sandbox if SDK create() rejects with a sandboxId error', async () => {
    const deleteSandbox = vi.fn(() => Promise.resolve(undefined));
    let getCalls = 0;
    const fakeSdk = {
      get: vi.fn((id: string) => {
        getCalls += 1;
        return Promise.resolve({
          id,
          state: getCalls === 1 ? 'creating' : 'destroyed',
          delete: deleteSandbox,
        });
      }),
      create: vi.fn(() => {
        const err = new Error('Daytona timeout waiting for start') as Error & {
          sandboxId?: string;
        };
        err.sandboxId = 'sbx_leaked_timeout';
        return Promise.reject(err);
      }),
      [Symbol.asyncDispose]: vi.fn(() => Promise.resolve(undefined)),
    };

    const client = new DaytonaSdkSandboxClient({
      apiKey: 'test-key',
      sdk: fakeSdk as unknown as NonNullable<
        ConstructorParameters<typeof DaytonaSdkSandboxClient>[0]['sdk']
      >,
    });

    await expect(
      client.create({
        snapshot: 'daytona-small',
        labels: { 'ember.owner': G4_DEFAULT_SANDBOX_OWNER },
        ttlMinutes: 2,
        autoStopIntervalMinutes: 2,
        autoDeleteIntervalMinutes: 0,
        ephemeral: true,
        networkBlockAll: true,
        fetchTimeoutSec: 30,
      }),
    ).rejects.toThrow(/timeout/i);
    expect(fakeSdk.get).toHaveBeenCalledWith('sbx_leaked_timeout');
    expect(deleteSandbox).toHaveBeenCalledTimes(1);
  });
});
