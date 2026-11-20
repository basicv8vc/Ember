import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { B1ConversationPageSchema, B1SessionResponseSchema } from '@ember/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2LocalRuntimeHarness } from '../../apps/benchmark/src/v2-m1/index.js';
import type {
  ProactiveScheduleDetail,
  ProactiveScheduleList,
  ProactiveScheduleSnapshot,
} from '../../packages/runtime-v2/src/contracts/proactive-schedules.js';

const configPath = fileURLToPath(
  new URL('../../apps/api/wrangler.local-v2.jsonc', import.meta.url),
);

async function json<T>(response: Response, expectedStatus: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expectedStatus);
  return JSON.parse(body) as T;
}

describe('Agent E — V2 proactive schedules in local workerd', () => {
  let harness: V2LocalRuntimeHarness;
  let token: string;
  let conversationId: string;

  beforeEach(async () => {
    harness = await V2LocalRuntimeHarness.start({ target: { kind: 'ab_runtime', configPath } });
    const sessionRes = await harness.fetchOverHttp('/v1/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'dev', identity_token: randomUUID(), nonce: randomUUID() }),
    });
    const session = B1SessionResponseSchema.parse(await json(sessionRes, 201));
    token = session.access_token;

    const meRes = await harness.fetchOverHttp('/v1/me', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const me = await json<{ conversation: { conversation_id: string } }>(meRes, 200);
    conversationId = me.conversation.conversation_id;
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  function api(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; authToken?: string } = {},
  ) {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    return harness.fetchOverHttp(path, {
      method,
      headers: {
        authorization: `Bearer ${options.authToken ?? token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  it('executes a one-time follow-up reminder durably and delivers a visible message to the conversation', async () => {
    const fireAt = new Date(Date.now() + 250).toISOString();
    const payload = {
      idempotencyKey: `followup-${randomUUID()}`,
      kind: 'reminder',
      title: 'Follow up on design review',
      prompt: 'Check if the architecture doc comments are resolved.',
      trigger: { type: 'once', fireAt },
      timezone: 'America/Los_Angeles',
    };

    const created = await json<ProactiveScheduleSnapshot>(
      await api('/v2/schedules', { body: payload }),
      201,
    );
    expect(created.status).toBe('active');
    expect(created.replayed).toBe(false);
    expect(created.deliveryMode).toBe('direct_reminder');

    // Idempotent replay -> 200
    const replayed = await json<ProactiveScheduleSnapshot>(
      await api('/v2/schedules', { body: payload }),
      200,
    );
    expect(replayed.scheduleId).toBe(created.scheduleId);
    expect(replayed.replayed).toBe(true);

    // Wait for DO alarm + durable queue execution to complete
    await expect
      .poll(
        async () => {
          const detail = await json<ProactiveScheduleDetail>(
            await api(`/v2/schedules/${created.scheduleId}`),
            200,
          );
          return detail.latestRun?.status;
        },
        { timeout: 15_000, interval: 150 },
      )
      .toBe('completed');

    const finalDetail = await json<ProactiveScheduleDetail>(
      await api(`/v2/schedules/${created.scheduleId}`),
      200,
    );
    expect(finalDetail.status).toBe('completed');
    expect(finalDetail.occurrenceCount).toBe(1);
    expect(finalDetail.latestRun?.resultMessageId).toBeTruthy();

    // Visible result appears in main conversation without app sending any new turn
    const convPage = B1ConversationPageSchema.parse(
      await json(await api(`/v1/conversations/${conversationId}/messages`), 200),
    );
    const delivered = convPage.messages.find(
      (m) => m.message_id === finalDetail.latestRun?.resultMessageId,
    );
    expect(delivered?.kind).toBe('ember');
    if (delivered?.kind === 'ember') {
      expect(delivered.text).toContain('Reminder: Follow up on design review');
      expect(delivered.text).toContain('Check if the architecture doc comments are resolved.');
    }
  });

  it('executes a recurring model_brief schedule, produces a visible brief, and supports pause/resume/cancel', async () => {
    const firstFireAt = new Date(Date.now() + 250).toISOString();
    const brief = await json<ProactiveScheduleSnapshot>(
      await api('/v2/schedules', {
        body: {
          idempotencyKey: `brief-${randomUUID()}`,
          kind: 'brief',
          title: 'Morning Brief',
          prompt: 'Prepare a concise morning brief of today priorities.',
          trigger: {
            type: 'interval',
            intervalSeconds: 3600,
            firstFireAt,
          },
          timezone: 'America/Los_Angeles',
          deliveryMode: 'model_brief',
        },
      }),
      201,
    );
    expect(brief.deliveryMode).toBe('model_brief');
    expect(brief.status).toBe('active');

    // Wait for durable model-backed brief execution
    await expect
      .poll(
        async () => {
          const detail = await json<ProactiveScheduleDetail>(
            await api(`/v2/schedules/${brief.scheduleId}`),
            200,
          );
          return detail.latestRun?.status;
        },
        { timeout: 15_000, interval: 150 },
      )
      .toBe('completed');

    const afterRun = await json<ProactiveScheduleDetail>(
      await api(`/v2/schedules/${brief.scheduleId}`),
      200,
    );
    expect(afterRun.status).toBe('active'); // recurring stays active
    expect(afterRun.occurrenceCount).toBe(1);
    expect(afterRun.nextFireAt).not.toBeNull();
    expect(afterRun.latestRun?.resultMessageId).toBeTruthy();

    // Conversation contains the visible Morning Brief message
    const convPage = B1ConversationPageSchema.parse(
      await json(await api(`/v1/conversations/${conversationId}/messages`), 200),
    );
    const briefMsg = convPage.messages.find(
      (m) => m.message_id === afterRun.latestRun?.resultMessageId,
    );
    expect(briefMsg?.kind).toBe('ember');
    if (briefMsg?.kind === 'ember') {
      expect(briefMsg.text).toContain('**Morning Brief**');
    }

    // Create a cron_tz schedule as well and exercise list + pause + resume + cancel
    const cronBrief = await json<ProactiveScheduleSnapshot>(
      await api('/v2/schedules', {
        body: {
          idempotencyKey: `cron-brief-${randomUUID()}`,
          kind: 'brief',
          title: 'Daily 8AM Brief',
          prompt: 'Daily summary at 8:00 AM Pacific.',
          trigger: {
            type: 'cron',
            cronExpr: '0 8 * * *',
            timezone: 'America/Los_Angeles',
          },
        },
      }),
      201,
    );
    expect(cronBrief.scheduleKind).toBe('cron_tz');
    expect(cronBrief.timezone).toBe('America/Los_Angeles');

    const listed = await json<ProactiveScheduleList>(await api('/v2/schedules'), 200);
    expect(listed.schedules.map((s) => s.scheduleId)).toEqual(
      expect.arrayContaining([brief.scheduleId, cronBrief.scheduleId]),
    );

    const paused = await json<ProactiveScheduleSnapshot>(
      await api(`/v2/schedules/${cronBrief.scheduleId}/pause`, { method: 'POST' }),
      200,
    );
    expect(paused.status).toBe('paused');
    expect(paused.nextFireAt).toBeNull();

    const resumed = await json<ProactiveScheduleSnapshot>(
      await api(`/v2/schedules/${cronBrief.scheduleId}/resume`, { method: 'POST' }),
      200,
    );
    expect(resumed.status).toBe('active');
    expect(resumed.nextFireAt).not.toBeNull();

    const cancelled = await json<ProactiveScheduleSnapshot>(
      await api(`/v2/schedules/${cronBrief.scheduleId}/cancel`, { method: 'POST' }),
      200,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.nextFireAt).toBeNull();

    // Pausing a cancelled schedule returns 409 CONFLICT
    const conflictRes = await api(`/v2/schedules/${cronBrief.scheduleId}/pause`, {
      method: 'POST',
    });
    expect(conflictRes.status).toBe(409);
  });

  it('creates proactive schedules atomically from natural-language turns on both Fast Path and Durable Path while gating scheduled tasks', async () => {
    const fastFireAt = new Date(Date.now() + 60_000).toISOString();
    const durableFireAt = new Date(Date.now() + 120_000).toISOString();

    // 1. Fast Path (SSE stream): scripted createProactiveSchedule tool output
    harness.fakeGateway.enqueueRules({
      mode: 'fast_ok',
      replyText: 'Model ack placeholder',
      createProactiveSchedule: {
        kind: 'reminder',
        title: 'Fast Path Reminder',
        prompt: 'Call Alex about Q4 invoice',
        triggerType: 'once',
        fireAt: fastFireAt,
      },
    });

    const streamRes = await api(`/v2/conversations/${conversationId}/messages/stream`, {
      method: 'POST',
      body: {
        client_submission_id: randomUUID(),
        text: 'Remind me in 1 minute to call Alex about the Q4 invoice.',
        transcript_epoch: 0,
      },
    });
    expect(streamRes.status).toBe(201);
    const sseBody = await streamRes.text();
    expect(sseBody).toContain('event: turn.committed');

    // 2. Durable Path (POST /v1/conversations/:id/messages -> DURABLE_TURN_QUEUE)
    harness.fakeGateway.enqueueRules({
      mode: 'fast_ok',
      replyText: 'Durable ack placeholder',
      createProactiveSchedule: {
        kind: 'brief',
        title: 'Durable Morning Brief',
        prompt: 'Summarize my daily priorities',
        triggerType: 'cron',
        cronExpr: '0 8 * * *',
        timezone: 'America/Los_Angeles',
      },
    });

    const durableRes = await api(`/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: {
        client_submission_id: randomUUID(),
        text: 'Prepare my morning brief every day at 8am America/Los_Angeles.',
        transcript_epoch: 0,
      },
    });
    expect(durableRes.status).toBe(201);

    // Wait for durable turn to complete and persist the second schedule.
    let schedules: ProactiveScheduleList = { schedules: [] };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      schedules = await json<ProactiveScheduleList>(await api('/v2/schedules'), 200);
      if (schedules.schedules.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(schedules.schedules.map((s) => s.title).sort()).toEqual([
      'Durable Morning Brief',
      'Fast Path Reminder',
    ]);

    // Verify server-owned confirmation messages were committed in the conversation.
    const page = B1ConversationPageSchema.parse(
      await json(await api(`/v1/conversations/${conversationId}/messages?after=0&limit=20`), 200),
    );
    const emberTexts = page.messages.filter((m) => m.kind === 'ember').map((m) => m.text);
    expect(emberTexts.some((t) => t.includes('Scheduled "Fast Path Reminder"'))).toBe(true);
    expect(emberTexts.some((t) => t.includes('Scheduled "Durable Morning Brief"'))).toBe(true);

    // Verify capability gate: user conversation turns advertise enableProactiveScheduleTool + currentTimeIso.
    const audit = harness.fakeGateway.getAuditSnapshot();
    const userTurnCalls = audit.calls.filter((c) => c.enableProactiveScheduleTool === true);
    expect(userTurnCalls.length).toBeGreaterThanOrEqual(2);
    expect(userTurnCalls.every((c) => typeof c.currentTimeIso === 'string')).toBe(true);

    // 3. Scheduled model_brief task MUST NOT advertise enableProactiveScheduleTool.
    const briefFireAt = new Date(Date.now() + 250).toISOString();
    const briefSched = await json<ProactiveScheduleSnapshot>(
      await api('/v2/schedules', {
        body: {
          idempotencyKey: `non-turn-gate-${randomUUID()}`,
          kind: 'brief',
          title: 'Gated Brief Check',
          prompt: 'Summarize today without calling side-effect tools',
          trigger: { type: 'once', fireAt: briefFireAt },
          deliveryMode: 'model_brief',
        },
      }),
      201,
    );
    expect(briefSched.deliveryMode).toBe('model_brief');

    const briefDeadline = Date.now() + 10_000;
    while (Date.now() < briefDeadline) {
      const detail = await json<ProactiveScheduleDetail>(
        await api(`/v2/schedules/${briefSched.scheduleId}`),
        200,
      );
      if (detail.latestRun?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const postBriefAudit = harness.fakeGateway.getAuditSnapshot();
    const lastCall = postBriefAudit.calls.at(-1);
    expect(lastCall?.enableProactiveScheduleTool).toBeUndefined();
    expect(lastCall?.enablePersonalMemorySaveTool).toBeUndefined();
    expect(durableFireAt).toBeTruthy();
  });
});
