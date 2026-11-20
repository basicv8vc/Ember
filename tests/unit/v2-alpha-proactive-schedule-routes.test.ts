import { DomainError } from '@ember/domain';
import {
  type ProactiveScheduleCommand,
  type ProactiveScheduleDetail,
  type ProactiveScheduleSnapshot,
  type ProactiveScheduleTaskPayload,
} from '@ember/runtime-v2';
import { describe, expect, it, vi } from 'vitest';
import type { B1SessionRuntime } from '../../apps/api/src/auth/b1-auth-runtime.js';
import { generateSessionToken } from '../../apps/api/src/auth/session-token.js';
import {
  createLocalV2EdgeWorker,
  type LocalV2EdgeDependencies,
} from '../../apps/api/src/local-v2/edge-worker.js';
import {
  MAX_BRIEF_ACTIVE_SCHEDULES,
  MAX_BRIEF_ITEM_CHARS,
  MAX_BRIEF_PROMPT_CHARS,
  MAX_BRIEF_RECENT_MESSAGES,
  buildProactiveBriefPrompt,
  loadRecentBriefMessages,
} from '../../apps/api/src/local-v2/proactive-brief-context.js';
import type { EdgeAgentHeadRpc } from '../../apps/api/src/local-v2/rpc.js';

const tenantId = crypto.randomUUID();
const principalId = crypto.randomUUID();
const agentId = crypto.randomUUID();
const conversationId = crypto.randomUUID();
const token = generateSessionToken();
const authHeaders = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

function makeSnapshot(
  overrides: Partial<ProactiveScheduleSnapshot> = {},
): ProactiveScheduleSnapshot {
  const now = '2026-11-20T08:00:00.000Z';
  return {
    scheduleId: crypto.randomUUID(),
    kind: 'brief',
    title: 'Morning Brief',
    prompt: 'Summarize my priorities for today.',
    deliveryMode: 'model_brief',
    status: 'active',
    scheduleKind: 'cron_tz',
    intervalSeconds: null,
    cronExpr: '0 8 * * *',
    timezone: 'America/Los_Angeles',
    misfirePolicy: 'skip_missed',
    nextFireAt: '2026-11-21T16:00:00.000Z',
    lastFiredAt: null,
    occurrenceCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    latestRun: null,
    replayed: false,
    ...overrides,
  };
}

function createScheduleWorkerFixture(
  proactiveScheduleHandler: (cmd: ProactiveScheduleCommand) => Promise<unknown>,
) {
  const proactiveSchedule = vi.fn(proactiveScheduleHandler);
  const rpc: Partial<EdgeAgentHeadRpc> & {
    proactiveSchedule: typeof proactiveSchedule;
  } = {
    proactiveSchedule,
  };

  const sessions: B1SessionRuntime = {
    service: {
      createSession: vi.fn(),
      refreshSession: vi.fn(),
      logout: vi.fn(),
      resolveActiveSession: vi.fn((rawToken: string) =>
        Promise.resolve(
          rawToken === token
            ? {
                auth: { tenantId, principalId, policyVersion: 1 },
                session: {
                  sessionId: crypto.randomUUID(),
                  consumerId: crypto.randomUUID(),
                  tenantId,
                  expiresAt: '2026-12-01T00:00:00.000Z',
                  idleExpiresAt: '2026-12-01T00:00:00.000Z',
                  revokedAt: null,
                },
              }
            : null,
        ),
      ),
    },
    appleVerifier: { provider: 'apple', verify: vi.fn() },
    devVerifier: { provider: 'dev', verify: vi.fn() },
    devProvider: { evaluate: vi.fn() },
    me: { getMeForTenant: vi.fn() },
  };

  const deps: LocalV2EdgeDependencies = {
    sessions,
    resolveAgentHead: () =>
      Promise.resolve({
        agentId,
        conversationId,
        rpc: rpc as unknown as EdgeAgentHeadRpc,
      }),
  };

  const worker = createLocalV2EdgeWorker(deps);
  return { worker, proactiveSchedule };
}

describe('Agent E — proactive brief context builder', () => {
  const basePayload: ProactiveScheduleTaskPayload = {
    scheduleId: 'sched-self',
    occurrenceSeq: 1,
    principalId,
    kind: 'brief',
    title: 'Morning Brief',
    prompt: 'Summarize priorities and open follow-ups.',
    deliveryMode: 'model_brief',
    timezone: 'America/Los_Angeles',
    scheduledForMs: Date.parse('2026-11-20T16:00:00.000Z'),
  };

  it('builds base prompt when no context is supplied', () => {
    const prompt = buildProactiveBriefPrompt(basePayload);
    expect(prompt).toBe(
      '[Proactive brief | Morning Brief | America/Los_Angeles]\nSummarize priorities and open follow-ups.',
    );
  });

  it('includes only other active schedules and bounded recent conversation turns', () => {
    const schedules: ProactiveScheduleSnapshot[] = [
      makeSnapshot({ scheduleId: 'sched-self', title: 'Morning Brief', status: 'active' }),
      makeSnapshot({ scheduleId: 'sched-paused', title: 'Paused one', status: 'paused' }),
      makeSnapshot({ scheduleId: 'sched-cancelled', title: 'Cancelled one', status: 'cancelled' }),
      ...Array.from({ length: MAX_BRIEF_ACTIVE_SCHEDULES + 3 }, (_, idx) =>
        makeSnapshot({
          scheduleId: `sched-${idx}`,
          kind: 'follow_up',
          title: `Follow up #${idx}`,
          status: 'active',
        }),
      ),
    ];

    const messages = Array.from({ length: MAX_BRIEF_RECENT_MESSAGES + 4 }, (_, idx) => ({
      kind: idx % 2 === 0 ? ('user' as const) : ('ember' as const),
      text: `Message ${idx}: ${'x'.repeat(MAX_BRIEF_ITEM_CHARS + 50)}`,
    }));

    const prompt = buildProactiveBriefPrompt(basePayload, {
      activeSchedules: schedules,
      recentMessages: messages,
    });

    expect(prompt).not.toContain('Paused one');
    expect(prompt).not.toContain('Cancelled one');
    expect(prompt).toContain('Follow up #0');
    expect(prompt).not.toContain(`Follow up #${MAX_BRIEF_ACTIVE_SCHEDULES}`);
    expect(prompt).toContain(`Message ${MAX_BRIEF_RECENT_MESSAGES + 3}:`);
    expect(prompt).not.toContain('Message 0:');
    expect(prompt.length).toBeLessThanOrEqual(MAX_BRIEF_PROMPT_CHARS);
  });

  it('paginates ascending conversation history to retain the latest tail messages', async () => {
    const allMessages = Array.from({ length: 120 }, (_, idx) => ({
      seq: idx + 1,
      kind: idx % 3 === 0 ? 'activity' : idx % 2 === 0 ? 'user' : 'ember',
      text: `turn-${idx + 1}`,
    }));

    const calls: Array<{ after: number; limit: number }> = [];
    const recent = await loadRecentBriefMessages((after, limit) => {
      calls.push({ after, limit });
      const slice = allMessages.filter((m) => m.seq > after).slice(0, limit);
      const last = slice.at(-1);
      const hasMore = last !== undefined && last.seq < allMessages.length;
      return Promise.resolve({
        messages: slice.map(({ kind, text }) => ({ kind, text })),
        has_more: hasMore,
        next_after: last?.seq ?? null,
      });
    }, 4);

    expect(calls.length).toBe(3);
    expect(recent.map((m) => m.text)).toEqual(['turn-116', 'turn-117', 'turn-119', 'turn-120']);
  });
});

describe('Agent E — /schedules HTTP route contracts', () => {
  it('rejects unauthenticated requests with 401 and invalid requests with 400', async () => {
    const { worker } = createScheduleWorkerFixture(() => Promise.resolve({ schedules: [] }));

    const unauth = await worker.fetch(new Request('http://localhost/v2/schedules'));
    expect(unauth.status).toBe(401);

    const badQuery = await worker.fetch(
      new Request('http://localhost/v2/schedules?extra=1', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(badQuery.status).toBe(400);

    const badId = await worker.fetch(
      new Request('http://localhost/v2/schedules/not-a-uuid', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(badId.status).toBe(400);

    const badBody = await worker.fetch(
      new Request('http://localhost/v2/schedules', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ kind: 'brief' }),
      }),
    );
    expect(badBody.status).toBe(400);

    const nonEmptyPauseBody = await worker.fetch(
      new Request(`http://localhost/v2/schedules/${crypto.randomUUID()}/pause`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ unexpected: true }),
      }),
    );
    expect(nonEmptyPauseBody.status).toBe(400);
  });

  it('returns 201 on create, 200 on idempotent replay, 409 on conflict, and 404 on missing schedule', async () => {
    const created = makeSnapshot({ replayed: false });
    const detail: ProactiveScheduleDetail = { ...created, recentRuns: [] };
    let seenCreate = false;

    const { worker, proactiveSchedule } = createScheduleWorkerFixture((cmd) => {
      if (cmd.kind === 'create') {
        if (cmd.input.idempotencyKey === 'conflict-key') {
          return Promise.reject(
            new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency key conflicts'),
          );
        }
        const replayed = seenCreate;
        seenCreate = true;
        return Promise.resolve({ ...created, replayed });
      }
      if (cmd.kind === 'list') return Promise.resolve({ schedules: [created] });
      if (cmd.kind === 'get') {
        if (cmd.scheduleId !== created.scheduleId) {
          return Promise.reject(new DomainError('NOT_FOUND', 'schedule not found'));
        }
        return Promise.resolve(detail);
      }
      if (cmd.kind === 'pause') return Promise.resolve({ ...created, status: 'paused' });
      if (cmd.kind === 'resume') return Promise.resolve({ ...created, status: 'active' });
      return Promise.resolve({ ...created, status: 'cancelled' });
    });

    const createPayload = {
      idempotencyKey: 'morning-brief-1',
      kind: 'brief',
      title: 'Morning Brief',
      prompt: 'Summarize my priorities for today.',
      trigger: { type: 'cron', cronExpr: '0 8 * * *', timezone: 'America/Los_Angeles' },
    };

    const res1 = await worker.fetch(
      new Request('http://localhost/v2/schedules', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(createPayload),
      }),
    );
    expect(res1.status).toBe(201);

    const res2 = await worker.fetch(
      new Request('http://localhost/v2/schedules', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(createPayload),
      }),
    );
    expect(res2.status).toBe(200);

    const conflict = await worker.fetch(
      new Request('http://localhost/v2/schedules', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ...createPayload, idempotencyKey: 'conflict-key' }),
      }),
    );
    expect(conflict.status).toBe(409);

    const missing = await worker.fetch(
      new Request(`http://localhost/v2/schedules/${crypto.randomUUID()}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(missing.status).toBe(404);

    const listRes = await worker.fetch(
      new Request('http://localhost/v2/schedules', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(listRes.status).toBe(200);

    const pauseRes = await worker.fetch(
      new Request(`http://localhost/v2/schedules/${created.scheduleId}/pause`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(pauseRes.status).toBe(200);
    expect(((await pauseRes.json()) as ProactiveScheduleSnapshot).status).toBe('paused');

    const resumeRes = await worker.fetch(
      new Request(`http://localhost/v2/schedules/${created.scheduleId}/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(resumeRes.status).toBe(200);
    expect(((await resumeRes.json()) as ProactiveScheduleSnapshot).status).toBe('active');

    const cancelRes = await worker.fetch(
      new Request(`http://localhost/v2/schedules/${created.scheduleId}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as ProactiveScheduleSnapshot).status).toBe('cancelled');
    expect(proactiveSchedule).toHaveBeenCalledTimes(8);
  });
});
