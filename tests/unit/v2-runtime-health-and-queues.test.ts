import { describe, expect, it, vi } from 'vitest';
import type { D1DatabaseLike } from '@ember/runtime-v2';
import type { B1SessionRuntime } from '../../apps/api/src/auth/b1-auth-runtime.js';
import { createLocalV2EdgeWorker } from '../../apps/api/src/local-v2/edge-worker.js';
import {
  createD1RecoveryReadiness,
  parseAllowedSubjects,
  resolveV2AllowedHosts,
  resolveV2QueueTarget,
} from '../../apps/api/src/local-v2/runtime-config.js';

function minimalSessions(): B1SessionRuntime {
  return {
    service: {
      createSession: vi.fn(),
      refreshSession: vi.fn(),
      logout: vi.fn(),
      resolveActiveSession: vi.fn().mockResolvedValue(null),
    },
    appleVerifier: { provider: 'apple', verify: () => Promise.resolve(null) },
    devVerifier: { provider: 'dev', verify: () => Promise.resolve(null) },
    devProvider: { evaluate: () => ({ enabled: false, deniedBy: [] }) },
    me: { getMeForTenant: () => Promise.resolve(null) },
  };
}

describe('V2 edge worker /healthz and /readyz', () => {
  it('serves unauthenticated 200 /healthz on loopback and rejects non-loopback hosts', async () => {
    const fixedNow = () => new Date('2026-11-20T12:00:00.000Z');
    const worker = createLocalV2EdgeWorker({
      sessions: minimalSessions(),
      resolveAgentHead: () => Promise.resolve(null),
      now: fixedNow,
    });

    const ok = await worker.fetch(new Request('http://127.0.0.1/healthz'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      status: 'ok',
      service: 'ember-v2-edge',
      checkedAt: '2026-11-20T12:00:00.000Z',
    });

    const blocked = await worker.fetch(new Request('https://example.com/healthz'));
    expect(blocked.status).toBe(404);
  });

  it('serves 503 not_configured on /readyz when readiness probe is omitted', async () => {
    const worker = createLocalV2EdgeWorker({
      sessions: minimalSessions(),
      resolveAgentHead: () => Promise.resolve(null),
      now: () => new Date('2026-11-20T12:00:00.000Z'),
    });

    const res = await worker.fetch(new Request('http://127.0.0.1/readyz'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'unavailable',
      checks: { d1_recovery: { status: 'not_configured' } },
      checkedAt: '2026-11-20T12:00:00.000Z',
    });
  });

  it('serves 200 on /readyz when D1_RECOVERY probe succeeds and 503 when it fails', async () => {
    const okDb = {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ 1: 1 }),
      }),
    } as unknown as D1DatabaseLike;

    const okWorker = createLocalV2EdgeWorker({
      sessions: minimalSessions(),
      resolveAgentHead: () => Promise.resolve(null),
      readiness: createD1RecoveryReadiness(okDb),
    });
    const okRes = await okWorker.fetch(new Request('http://127.0.0.1/readyz'));
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as {
      status: string;
      checks: { d1_recovery: { status: string; latencyMs: number } };
    };
    expect(okBody.status).toBe('ready');
    expect(okBody.checks.d1_recovery.status).toBe('up');
    expect(typeof okBody.checks.d1_recovery.latencyMs).toBe('number');

    const failDb = {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockRejectedValue(new Error('secret internal D1 error')),
      }),
    } as unknown as D1DatabaseLike;

    const failWorker = createLocalV2EdgeWorker({
      sessions: minimalSessions(),
      resolveAgentHead: () => Promise.resolve(null),
      readiness: createD1RecoveryReadiness(failDb),
    });
    const failRes = await failWorker.fetch(new Request('http://127.0.0.1/readyz'));
    expect(failRes.status).toBe(503);
    const raw = await failRes.text();
    expect(raw).not.toContain('secret internal D1 error');
    const failBody = JSON.parse(raw) as {
      status: string;
      checks: { d1_recovery: { status: string } };
    };
    expect(failBody.status).toBe('unavailable');
    expect(failBody.checks.d1_recovery.status).toBe('down');
  });
});

describe('V2 queue name routing', () => {
  it('maps default local queue and DLQ names', () => {
    expect(resolveV2QueueTarget('durable_turn')).toEqual({
      kind: 'primary',
      logicalQueue: 'durable_turn',
    });
    expect(resolveV2QueueTarget('agent_task')).toEqual({
      kind: 'primary',
      logicalQueue: 'agent_task',
    });
    expect(resolveV2QueueTarget('durable_turn_dlq')).toEqual({
      kind: 'dlq',
      expectedQueueName: 'durable_turn',
    });
    expect(resolveV2QueueTarget('agent_task_dlq')).toEqual({
      kind: 'dlq',
      expectedQueueName: 'agent_task',
    });
    expect(resolveV2QueueTarget('unknown_queue')).toBeNull();
  });

  it('maps isolated V2 staging queue and DLQ names from env vars', () => {
    const stagingEnv = {
      EMBER_V2_DURABLE_TURN_QUEUE_NAME: 'ember-v2-staging-durable-turn',
      EMBER_V2_DURABLE_TURN_DLQ_NAME: 'ember-v2-staging-durable-turn-dlq',
      EMBER_V2_AGENT_TASK_QUEUE_NAME: 'ember-v2-staging-agent-task',
      EMBER_V2_AGENT_TASK_DLQ_NAME: 'ember-v2-staging-agent-task-dlq',
    };

    expect(resolveV2QueueTarget('ember-v2-staging-durable-turn', stagingEnv)).toEqual({
      kind: 'primary',
      logicalQueue: 'durable_turn',
    });
    expect(resolveV2QueueTarget('ember-v2-staging-agent-task', stagingEnv)).toEqual({
      kind: 'primary',
      logicalQueue: 'agent_task',
    });
    expect(resolveV2QueueTarget('ember-v2-staging-durable-turn-dlq', stagingEnv)).toEqual({
      kind: 'dlq',
      expectedQueueName: 'durable_turn',
    });
    expect(resolveV2QueueTarget('ember-v2-staging-agent-task-dlq', stagingEnv)).toEqual({
      kind: 'dlq',
      expectedQueueName: 'agent_task',
    });
    // Default local names are not accepted when overridden to staging names
    expect(resolveV2QueueTarget('durable_turn', stagingEnv)).toBeNull();
  });
});

describe('V2 staging host and subject allowlist', () => {
  it('resolves loopback for local envs and enforces bare hostname for v2-staging', () => {
    expect(resolveV2AllowedHosts({ EMBER_ENV: 'local' })).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
    ]);
    expect(
      resolveV2AllowedHosts({
        EMBER_ENV: 'v2-staging',
        EMBER_V2_ALLOWED_HOST: 'Ember-V2-Staging.SlowFast.dev',
      }),
    ).toEqual(['ember-v2-staging.slowfast.dev']);
    expect(() => resolveV2AllowedHosts({ EMBER_ENV: 'v2-staging' })).toThrow();
    expect(() =>
      resolveV2AllowedHosts({
        EMBER_ENV: 'v2-staging',
        EMBER_V2_ALLOWED_HOST: 'https://ember-v2-staging.slowfast.dev',
      }),
    ).toThrow();
    expect(() => resolveV2AllowedHosts({ EMBER_ENV: 'production' })).toThrow();
  });

  it('enforces custom allowedHosts on edge worker', async () => {
    const worker = createLocalV2EdgeWorker({
      sessions: minimalSessions(),
      resolveAgentHead: () => Promise.resolve(null),
      allowedHosts: ['ember-v2-staging.slowfast.dev'],
    });

    const allowed = await worker.fetch(
      new Request('https://ember-v2-staging.slowfast.dev/healthz'),
    );
    expect(allowed.status).toBe(200);
    const blocked = await worker.fetch(new Request('https://ember-api.slowfast.dev/healthz'));
    expect(blocked.status).toBe(404);
  });

  it('parses optional comma-separated Apple subject allowlist', () => {
    expect(parseAllowedSubjects(undefined)).toBeNull();
    expect(parseAllowedSubjects('   ')).toBeNull();
    expect(parseAllowedSubjects('sub-1, sub-2 , ')).toEqual(new Set(['sub-1', 'sub-2']));
  });
});
