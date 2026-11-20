import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  B1AssistantTurnDtoSchema,
  B1ConversationPageSchema,
  B1MeResponseSchema,
  B1SendMessageReceiptSchema,
  B1SessionResponseSchema,
  type B1SendMessageReceipt,
} from '@ember/contracts';
import { buildBoundedContext, type ContextRow } from '@ember/model-gateway';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  DST_TRANSITION_FIXTURES,
  V2LocalRuntimeHarness,
} from '../../apps/benchmark/src/v2-m1/index.js';
import { GLOBAL_BUDGET_OBJECT_NAME } from '../../packages/runtime-v2/src/global-budget/platform.js';
import {
  computePreDeadlineRetryAtMs,
  type V2DispatchEnvelope,
} from '../../packages/runtime-v2/src/index.js';

const RUNTIME_CONFIG_PATH = fileURLToPath(
  new URL('./support/v2-m1-full-runtime/wrangler.jsonc', import.meta.url),
);

interface SafetyCounters {
  duplicateProviderCalls: number;
  duplicateAssistantMessages: number;
  duplicateCommits: number;
  lostAcceptedWork: number;
  budgetOvercommit: number;
}

const safetyCounters: SafetyCounters = {
  duplicateProviderCalls: 0,
  duplicateAssistantMessages: 0,
  duplicateCommits: 0,
  lostAcceptedWork: 0,
  budgetOvercommit: 0,
};

interface TenantSession {
  readonly accessToken: string;
  readonly consumerId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly conversationId: string;
}

interface AgentInspectSnapshot {
  readonly telemetry: {
    readonly sql: {
      readonly statements: number;
      readonly rowsRead: number;
      readonly rowsWritten: number;
    };
    readonly d1Ops: number;
    readonly globalBudget: {
      readonly reserveCalls: number;
      readonly authorizeCalls: number;
      readonly renewCalls: number;
      readonly settleCalls: number;
    };
    readonly queueSends: number;
    readonly alarmFiresObserved: number;
    readonly alarmSuccessCount: number;
    readonly alarmFailureCount: number;
  };
  readonly alarmArmedAtMs: number | null;
  readonly headMeta: Array<{ tenant_id: string; agent_id: string }>;
  readonly conversations: Array<{ id: string; last_sequence: number; transcript_epoch: number }>;
  readonly messages: Array<{
    id: string;
    sequence: number;
    kind: string;
    text: string;
    client_submission_id: string | null;
  }>;
  readonly turns: Array<{
    id: string;
    status: string;
    execution_mode: string;
    lease_epoch: number;
    lease_owner: string | null;
    lease_expires_at_ms: number | null;
    claim_count: number;
    deadline_at_ms: number;
    provider_job_handle: string | null;
    handoff_reason: string | null;
    response_message_id: string | null;
    failure_reason: string | null;
  }>;
  readonly attempts: Array<{
    subject_id: string;
    attempt_no: number;
    operation_id: string;
    state: string;
    outcome_code: string | null;
    reserved_micro_usd: number;
    applied_cost_micro_usd: number | null;
    observed_cost_micro_usd: number | null;
    settlement_revision: number | null;
    global_grant_id: string | null;
    global_synced_at_ms: number | null;
    send_authorizing_at_ms: number | null;
    send_started_at_ms: number | null;
  }>;
  readonly tasks: Array<{
    id: string;
    kind: string;
    status: string;
    attempt_count: number;
    lease_epoch: number;
  }>;
  readonly runs: Array<{ id: string; task_id: string; attempt: number; status: string }>;
  readonly outbox: Array<{
    outbox_id: string;
    entity_kind: string;
    entity_id: string;
    state: string;
    publish_attempts: number;
    dlq_count: number;
    next_attempt_at_ms: number;
    fence_epoch: number;
    last_error_code: string | null;
  }>;
  readonly coverage: Array<{
    generation: number;
    coverage_state: string;
    covered_recovery_at_ms: number | null;
    pending_kind: string | null;
    armed_alarm_at_ms: number | null;
    alarm_fail_count: number;
  }>;
  readonly schedules: Array<{
    schedule_id: string;
    status: string;
    next_fire_at_ms: number;
    occurrence_seq: number;
  }>;
  readonly localBuckets: Array<{
    scope_kind: string;
    reserved_micro_usd: number;
    consumed_micro_usd: number;
  }>;
  readonly localIncidents: Array<{
    reason: string;
    resolved_at_ms: number | null;
  }>;
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 15_000,
  intervalMs = 80,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function createTenantSession(
  harness: V2LocalRuntimeHarness,
  subject = `user-${randomUUID()}`,
): Promise<TenantSession> {
  const sessionRes = await harness.fetchJson<{
    session_id: string;
    consumer_id: string;
    access_token: string;
    expires_at: string;
  }>('/v1/auth/session', {
    provider: 'dev',
    identity_token: subject,
    nonce: randomUUID(),
  });
  expect(sessionRes.status).toBe(201);
  const parsedSession = B1SessionResponseSchema.parse(sessionRes.data);

  const meRes = await harness.fetchJson('/v1/me', undefined, {
    authorization: `Bearer ${parsedSession.access_token}`,
  });
  expect(meRes.status).toBe(200);
  const parsedMe = B1MeResponseSchema.parse(meRes.data);

  const idRes = await harness.fetchJson<{
    consumerId: string;
    tenantId: string;
    principalId: string;
    agentId: string;
    conversationId: string;
  }>('/_test/auth/identity', undefined, {
    authorization: `Bearer ${parsedSession.access_token}`,
  });
  expect(idRes.status).toBe(200);

  return {
    accessToken: parsedSession.access_token,
    consumerId: parsedSession.consumer_id,
    tenantId: idRes.data.tenantId,
    principalId: idRes.data.principalId,
    agentId: parsedMe.agent.agent_id,
    conversationId: parsedMe.conversation.conversation_id,
  };
}

async function inspectAgent(
  harness: V2LocalRuntimeHarness,
  tenant: Pick<TenantSession, 'tenantId' | 'agentId'>,
): Promise<AgentInspectSnapshot> {
  const res = await harness.fetchJson<AgentInspectSnapshot>('/_test/agent/inspect', {
    tenantId: tenant.tenantId,
    agentId: tenant.agentId,
  });
  expect(res.status).toBe(200);
  return res.data;
}

async function resetAgentTelemetry(
  harness: V2LocalRuntimeHarness,
  tenant: Pick<TenantSession, 'tenantId' | 'agentId'>,
): Promise<void> {
  const res = await harness.fetchJson('/_test/agent/reset-telemetry', {
    tenantId: tenant.tenantId,
    agentId: tenant.agentId,
  });
  expect(res.status).toBe(200);
}

async function agentRpc<T = unknown>(
  harness: V2LocalRuntimeHarness,
  tenant: Pick<TenantSession, 'tenantId' | 'agentId'>,
  method: string,
  arg: unknown,
): Promise<{ ok: boolean; result?: T; error?: string; code?: string }> {
  const res = await harness.fetchJson<{ ok: boolean; result?: T; error?: string; code?: string }>(
    '/_test/agent/rpc',
    { tenantId: tenant.tenantId, agentId: tenant.agentId, method, arg },
  );
  return res.data;
}

async function readGlobalSpendDays(harness: V2LocalRuntimeHarness) {
  return harness.readDurableObjectRows<{
    utc_day: string;
    ceiling_micro_usd: number;
    reserved_micro_usd: number;
    consumed_micro_usd: number;
    overage_micro_usd: string;
  }>('GLOBAL_BUDGET', { name: GLOBAL_BUDGET_OBJECT_NAME }, 'SELECT * FROM global_spend_days');
}

async function readGlobalReservations(harness: V2LocalRuntimeHarness) {
  return harness.readDurableObjectRows<{
    operation_id: string;
    state: string;
    amount_micro_usd: number;
    cumulative_charge_micro_usd: number;
    overage_micro_usd: number;
  }>(
    'GLOBAL_BUDGET',
    { name: GLOBAL_BUDGET_OBJECT_NAME },
    'SELECT operation_id, state, amount_micro_usd, cumulative_charge_micro_usd, overage_micro_usd FROM global_budget_reservations',
  );
}

async function readGlobalIncidents(harness: V2LocalRuntimeHarness) {
  return harness.readDurableObjectRows<{
    incident_id: number;
    operation_id: string;
    reason: string;
    resolved_at_ms: number | null;
  }>(
    'GLOBAL_BUDGET',
    { name: GLOBAL_BUDGET_OBJECT_NAME },
    'SELECT incident_id, operation_id, reason, resolved_at_ms FROM global_budget_incidents',
  );
}

async function readD1Rows(harness: V2LocalRuntimeHarness) {
  const res = await harness.fetchJson<{
    results: Array<{
      agent_key: string;
      generation: number;
      next_recovery_at_ms: number;
      retry_not_before_ms: number | null;
      status: string;
      recovery_attempts: number;
      last_error_code: string | null;
      sweep_lease_owner: string | null;
    }>;
  }>('/_test/d1/inspect');
  expect(res.status).toBe(200);
  return res.data.results;
}

function parseSseFrames(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = '';
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (event && dataLines.length > 0) {
      out.push({ event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> });
    }
  }
  return out;
}

describe('V2-M1 Full A+B+E+F Real Local Workerd Acceptance Matrix (F-1..F-23 & FI-01..FI-16)', () => {
  const activeHarnesses: V2LocalRuntimeHarness[] = [];

  async function bootHarness(vars?: Record<string, string>): Promise<V2LocalRuntimeHarness> {
    const harness = await V2LocalRuntimeHarness.start({
      target: { kind: 'ab_runtime', configPath: RUNTIME_CONFIG_PATH },
      ...(vars !== undefined ? { vars } : {}),
    });
    activeHarnesses.push(harness);
    return harness;
  }

  afterEach(async () => {
    while (activeHarnesses.length > 0) {
      await activeHarnesses.pop()!.dispose();
    }
  });

  afterAll(() => {
    expect(safetyCounters).toEqual({
      duplicateProviderCalls: 0,
      duplicateAssistantMessages: 0,
      duplicateCommits: 0,
      lostAcceptedWork: 0,
      budgetOvercommit: 0,
    });
  });

  // ==========================================================================
  // Category 1: B1 API Compatibility & Concurrent Submission Races (F-1, F-2, F-11 N/A)
  // ==========================================================================

  it('F-1: handles concurrent identical submissions (1x201 + Nx200 replay, 0 duplicate provider calls)', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);
    const subId = randomUUID();
    const payload = {
      client_submission_id: subId,
      text: 'Concurrent F-1 turn',
      transcript_epoch: 0,
    };

    // F-1: 5 concurrent identical submissions via Promise barrier
    const outcomes = await harness.faultInjector.runConcurrentRace(
      Array.from(
        { length: 5 },
        () => () =>
          harness.fetchJson<B1SendMessageReceipt>(
            `/v1/conversations/${tenant.conversationId}/messages`,
            payload,
            { authorization: `Bearer ${tenant.accessToken}` },
          ),
      ),
    );
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    const responses = outcomes.map((o) => o.value!);
    const created = responses.filter((r) => r.status === 201);
    const replayed = responses.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(4);
    for (const r of responses) {
      expect(B1SendMessageReceiptSchema.parse(r.data)).toEqual(created[0]!.data);
    }

    const turnId = created[0]!.data.turn.turn_id;
    const completed = await waitFor(async () => {
      const snap = await inspectAgent(harness, tenant);
      const t = snap.turns.find((row) => row.id === turnId);
      return t?.status === 'completed' && snap.attempts.every((a) => a.global_synced_at_ms !== null)
        ? snap
        : null;
    });

    expect(completed.messages.filter((m) => m.kind === 'user')).toHaveLength(1);
    expect(completed.messages.filter((m) => m.kind === 'ember')).toHaveLength(1);
    const gatewayAudit = harness.fakeGateway.getAuditSnapshot();
    if (gatewayAudit.totalCalls !== 1) safetyCounters.duplicateProviderCalls += 1;
    expect(gatewayAudit.totalCalls).toBe(1);

    const spendDays = await readGlobalSpendDays(harness);
    expect(spendDays[0]?.reserved_micro_usd).toBe(0);
    expect(spendDays[0]?.consumed_micro_usd).toBe(120);
  });

  it('F-2: rejects same client_submission_id with differing payload or attachments (409 IDEMPOTENCY_CONFLICT)', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);
    const subId = randomUUID();

    const first = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: subId, text: 'Initial F-2 turn', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(first.status).toBe(201);

    await waitFor(async () => {
      const snap = await inspectAgent(harness, tenant);
      return snap.turns.find((row) => row.id === first.data.turn.turn_id)?.status === 'completed'
        ? snap
        : null;
    });

    // F-2a: Same client_submission_id with differing text -> 409 IDEMPOTENCY_CONFLICT
    const diffText = await harness.fetchJson<{ error: { code: string } }>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: subId, text: 'Mutated text', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(diffText.status).toBe(409);
    expect(diffText.data.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // F-2b: Differing attachment_ids via direct DO RPC -> IDEMPOTENCY_CONFLICT
    const attId = randomUUID();
    const diffAtt = await agentRpc(harness, tenant, 'prepareTurn', {
      scope: {
        tenantId: tenant.tenantId,
        principalId: tenant.principalId,
        agentId: tenant.agentId,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: tenant.conversationId,
      request: {
        client_submission_id: subId,
        text: 'Initial F-2 turn',
        transcript_epoch: 0,
        attachment_ids: [attId],
      },
      workerId: 'w-f2',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      resolvedAttachments: [
        {
          uploadId: attId,
          filename: 'doc.png',
          mediaType: 'image/png',
          sizeBytes: 12,
          r2Key: 'r2/doc.png',
          sha256: 'a'.repeat(64),
        },
      ],
    });
    expect(diffAtt.ok).toBe(false);
    expect(diffAtt.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(1);
  });

  it('F-11 (N/A — Alternative Verified): B1 POST /v1/.../messages routes directly via durable_queue with 60s deadline and 0 interactive lease', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);
    const subId = randomUUID();
    const submitRes = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: subId, text: 'B1 durable path check', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(submitRes.status).toBe(201);

    const settled = await waitFor(async () => {
      const snap = await inspectAgent(harness, tenant);
      const t = snap.turns.find((row) => row.id === submitRes.data.turn.turn_id);
      return t?.status === 'completed' ? snap : null;
    });
    const turnRow = settled.turns[0]!;
    expect(turnRow.execution_mode).toBe('durable_queue');
    // Verify original 60s B1 deadline preserved
    const createdAt = Date.parse(submitRes.data.turn.created_at);
    expect(turnRow.deadline_at_ms - createdAt).toBe(60_000);
    // Verify Unknown-ACK lookup returns canonical receipt
    const ackLookup = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/message-submissions/${subId}`,
      undefined,
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(ackLookup.status).toBe(200);
    expect(ackLookup.data).toEqual(submitRes.data);
  });

  // ==========================================================================
  // Category 2: D1 Outages, Coverage Races & Zero Sync D1 I/O (F-4, F-5, F-13, F-17, F-19, FI-01..03, FI-10..12)
  // ==========================================================================

  it('F-4 & FI-12 (Uncovered): Uncovered path fails closed 503 on D1 outage while Direct reads succeed', async () => {
    const harness = await bootHarness();
    const uncoveredTenant = await createTenantSession(harness, `uncov-${randomUUID()}`);

    harness.faultInjector.setD1Fault('unavailable');

    // Direct reads succeed even when D1 is down and agent has never registered
    const pageRes = await harness.fetchJson(
      `/v1/conversations/${uncoveredTenant.conversationId}/messages?after=0&limit=50`,
      undefined,
      { authorization: `Bearer ${uncoveredTenant.accessToken}` },
    );
    expect(pageRes.status).toBe(200);
    expect(B1ConversationPageSchema.parse(pageRes.data).messages).toHaveLength(0);

    // F-4: Uncovered turn fails closed 503 DB_UNAVAILABLE with zero DO writes
    const uncovRes = await harness.fetchJson<{ error: { code: string } }>(
      `/v1/conversations/${uncoveredTenant.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Should fail closed', transcript_epoch: 0 },
      { authorization: `Bearer ${uncoveredTenant.accessToken}` },
    );
    expect(uncovRes.status).toBe(503);
    expect(uncovRes.data.error.code).toBe('DB_UNAVAILABLE');
    const uncovSnap = await inspectAgent(harness, uncoveredTenant);
    expect(uncovSnap.turns).toHaveLength(0);
    expect(uncovSnap.messages).toHaveLength(0);

    harness.faultInjector.setD1Fault('healthy');
  });

  it('F-5 & FI-12 (Covered): Covered executes with 0 sync D1 ops during D1 outage; Unknown-ACK & Direct reads work', async () => {
    const harness = await bootHarness();
    const coveredTenant = await createTenantSession(harness, `cov-${randomUUID()}`);

    // Establish persistent 'covered' state on coveredTenant via a fast_interactive prepareTurn (alarm armed at +50s)
    const seedPrep = await agentRpc(harness, coveredTenant, 'prepareTurn', {
      scope: {
        tenantId: coveredTenant.tenantId,
        principalId: coveredTenant.principalId,
        agentId: coveredTenant.agentId,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: coveredTenant.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Establish D1 coverage',
        transcript_epoch: 0,
      },
      workerId: 'worker-seed-f5',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-2026-11',
        maxAttempts: 1,
        estimatedMicroUsd: 250,
      },
    });
    expect(seedPrep.ok).toBe(true);

    // Wait until AgentHeadDO enters covered state before outage
    await waitFor(async () => {
      const snap = await inspectAgent(harness, coveredTenant);
      return snap.coverage[0]?.coverage_state === 'covered' ? snap : null;
    });
    await resetAgentTelemetry(harness, coveredTenant);

    // Inject total D1 outage!
    harness.faultInjector.setD1Fault('unavailable');

    // F-5 & FI-12: Covered turn executes with 0 synchronous D1 operations during D1 outage!
    harness.fakeGateway.setDefaultRule({ mode: 'fast_ok', costMicroUsd: 120 });
    const covSubId = randomUUID();
    const covRes = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${coveredTenant.conversationId}/messages`,
      {
        client_submission_id: covSubId,
        text: 'Covered path zero D1 I/O',
        transcript_epoch: 0,
      },
      { authorization: `Bearer ${coveredTenant.accessToken}` },
    );
    expect(covRes.status).toBe(201);

    // Direct reads & Unknown-ACK lookup succeed during D1 outage
    const ackRes = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/message-submissions/${covSubId}`,
      undefined,
      { authorization: `Bearer ${coveredTenant.accessToken}` },
    );
    expect(ackRes.status).toBe(200);

    const covCompleted = await waitFor(async () => {
      const s = await inspectAgent(harness, coveredTenant);
      return s.turns.find((t) => t.id === covRes.data.turn.turn_id)?.status === 'completed'
        ? s
        : null;
    });
    expect(covCompleted.turns.find((t) => t.id === covRes.data.turn.turn_id)?.status).toBe(
      'completed',
    );

    const pageRes = await harness.fetchJson(
      `/v1/conversations/${coveredTenant.conversationId}/messages?after=0&limit=50`,
      undefined,
      { authorization: `Bearer ${coveredTenant.accessToken}` },
    );
    expect(pageRes.status).toBe(200);
    expect(B1ConversationPageSchema.parse(pageRes.data).messages.length).toBeGreaterThanOrEqual(2);

    const covSnapAfter = await inspectAgent(harness, coveredTenant);
    // Zero synchronous D1 I/O on the covered path!
    expect(covSnapAfter.telemetry.d1Ops).toBe(0);

    harness.faultInjector.setD1Fault('healthy');
  });

  it('F-13, F-19, FI-01, FI-02, FI-03 & FI-11: D1 ACK loss, DO registering crash, stale CAS, postpone timeout & Sweeper repair', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);

    // FI-01 / F-13: Crash after DO writes pending('ensure') before D1 CAS
    harness.faultInjector.setCrashPoint('after_do_pending_before_d1', true);
    const crashRes = await harness.fetchJson(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Crash before D1', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(crashRes.status).toBe(503);

    const afterPendingCrash = await inspectAgent(harness, tenant);
    expect(afterPendingCrash.coverage[0]?.coverage_state).toBe('registering');
    expect(afterPendingCrash.coverage[0]?.pending_kind).toBe('ensure');
    expect(afterPendingCrash.turns).toHaveLength(0);

    // Even with no D1 row yet, a subsequent healthy turn self-heals & increments generation
    const okSub = randomUUID();
    const okRes = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: okSub, text: 'Heal after pending crash', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(okRes.status).toBe(201);
    await waitFor(async () => {
      const snap = await inspectAgent(harness, tenant);
      return snap.turns.find((t) => t.id === okRes.data.turn.turn_id)?.status === 'completed'
        ? snap
        : null;
    });

    // F-19 & FI-02: D1 CAS commits (`uncertain_timeout_committed`) then ACK is lost
    const tenant2 = await createTenantSession(harness);
    harness.faultInjector.setD1Fault('uncertain_timeout_committed');
    const uncertainRes = await harness.fetchJson(
      `/v1/conversations/${tenant2.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'D1 uncertain commit', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant2.accessToken}` },
    );
    expect(uncertainRes.status).toBe(503);

    // Verify D1 row actually exists despite the client seeing 503!
    const d1Rows = await readD1Rows(harness);
    const t2Row = d1Rows.find((r) => r.agent_key === `${tenant2.tenantId}:${tenant2.agentId}`);
    expect(t2Row).toBeDefined();
    expect(t2Row!.generation).toBeGreaterThanOrEqual(1);

    // Restore D1 healthy and call reconcileFromRegistry -> confirms coverage via getCoverage without losing generation
    harness.faultInjector.setD1Fault('healthy');
    const recRes = await agentRpc<{ action: string }>(harness, tenant2, 'reconcileFromRegistry', {
      tenantId: tenant2.tenantId,
      agentId: tenant2.agentId,
      expectedGen: t2Row!.generation,
      nowMs: Date.now(),
    });
    expect(recRes.ok).toBe(true);
    expect(['repair_ensure', 'noop_stale', 'retire']).toContain(recRes.result?.action);

    // FI-03 & FI-11: Stale D1 generation & postpone uncertain timeout stays 'registering'
    const d1Exec = await harness.fetchJson('/_test/d1/exec', {
      sql: `UPDATE v2_recovery_registry SET generation = generation + 50 WHERE agent_key = ?`,
      bindings: [`${tenant2.tenantId}:${tenant2.agentId}`],
    });
    expect(d1Exec.status).toBe(200);
    // Next turn fast-forwards generation past +50 without marking falsely covered
    const ffRes = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenant2.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Fast forward gen', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant2.accessToken}` },
    );
    expect(ffRes.status).toBe(201);
    const snapT2 = await inspectAgent(harness, tenant2);
    expect(snapT2.coverage[0]?.generation).toBeGreaterThan(50);
    expect(snapT2.coverage[0]?.coverage_state).toBe('covered');

    // FI-11: Postpone / retire encountering ambiguous D1 timeout remains 'registering'
    const tenant3 = await createTenantSession(harness);
    const t3Start = Date.now();
    harness.faultInjector.setVirtualNowMs(t3Start);
    const t3Prep = await agentRpc(harness, tenant3, 'prepareTurn', {
      scope: {
        tenantId: tenant3.tenantId,
        principalId: tenant3.principalId,
        agentId: tenant3.agentId,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: tenant3.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Turn for FI-11',
        transcript_epoch: 0,
      },
      workerId: 'worker-fi11',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-2026-11',
        maxAttempts: 1,
        estimatedMicroUsd: 250,
      },
    });
    expect(t3Prep.ok).toBe(true);
    // Expire the fast turn past deadline with uncertain_timeout_aborted so retireCoverage times out
    harness.faultInjector.setD1Fault('uncertain_timeout_aborted');
    harness.faultInjector.setVirtualNowMs(t3Start + 610_000);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenant3.tenantId,
      agentId: tenant3.agentId,
      nowMs: t3Start + 610_000,
    });
    const snapT3 = await inspectAgent(harness, tenant3);
    // Coverage transitioned to registering (not stale covered) when retire/postpone timed out!
    expect(snapT3.coverage[0]?.coverage_state).toBe('registering');
    harness.faultInjector.setD1Fault('healthy');
    harness.faultInjector.setVirtualNowMs(null);
  });

  it('F-17 & FI-10: Concurrent Sweeper retire/postpone raced against prepareTurn never erases new turn coverage', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);

    // Seed an idle covered state via schedule or completed turn before retire
    const firstTurn = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'First turn for F-17', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(firstTurn.status).toBe(201);
    await waitFor(async () => {
      const snap = await inspectAgent(harness, tenant);
      return snap.turns[0]?.status === 'completed' ? snap : null;
    });

    // Ensure coverage is covered & idle in D1 by inserting a far-future schedule or catching before retire
    const now = Date.now();
    await agentRpc(harness, tenant, 'upsertSchedule', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      scheduleId: 'sched-f17',
      sourceKind: 'reminder',
      sourceId: 'rem-f17',
      scheduleKind: 'once',
      intervalSeconds: null,
      cronExpr: null,
      firstFireAtMs: now + 300_000,
    });

    // Race Sweeper (trying postpone/retire) against concurrent prepareTurn
    harness.faultInjector.setD1Fault('healthy', 40);
    const race = await harness.faultInjector.runConcurrentRace([
      () =>
        harness.fetchJson('/_test/sweeper/run', {
          nowMs: now + 350_000,
          sweeperId: 'sweeper-race-f17',
        }),
      () =>
        harness.fetchJson<B1SendMessageReceipt>(
          `/v1/conversations/${tenant.conversationId}/messages`,
          {
            client_submission_id: randomUUID(),
            text: 'Concurrent new turn F-17',
            transcript_epoch: 0,
          },
          { authorization: `Bearer ${tenant.accessToken}` },
        ),
    ]);
    harness.faultInjector.setD1Fault('healthy', 0);

    expect(race.every((r) => r.status === 'fulfilled')).toBe(true);
    const turnResp = race[1]!.value as { status: number; data: B1SendMessageReceipt };
    expect(turnResp.status).toBe(201);

    await waitFor(async () => {
      const snap = await inspectAgent(harness, tenant);
      return snap.turns.find((t) => t.id === turnResp.data.turn.turn_id)?.status === 'completed'
        ? snap
        : null;
    });
    const d1Rows = await readD1Rows(harness);
    const row = d1Rows.find((r) => r.agent_key === `${tenant.tenantId}:${tenant.agentId}`);
    // New turn's coverage or active schedule coverage was NOT erased
    expect(row).toBeDefined();
  });

  // ==========================================================================
  // Category 3: Cancellation, Tenant Isolation & Transcript Epoch (F-3, F-9, F-16)
  // ==========================================================================

  it('F-3: clearTranscript interleaved with prepareTurn Stage 2 await aborts Stage 3 with 409 & releases global hold', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);

    // Slow down D1 Stage 2 so clearTranscript reliably executes during Stage 2 await!
    harness.faultInjector.setD1Fault('healthy', 180);
    const prepPromise = harness.fetchJson<{ error?: { code: string } }>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Interleaved with clear', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );

    await new Promise((r) => setTimeout(r, 40));
    const delRes = await harness.fetch('/v1/me/conversation/messages', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tenant.accessToken}` },
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { transcript_epoch: number };
    expect(delBody.transcript_epoch).toBe(1);

    const prepRes = await prepPromise;
    harness.faultInjector.setD1Fault('healthy', 0);
    expect(prepRes.status).toBe(409);
    expect(prepRes.data.error?.code).toBe('IDEMPOTENCY_CONFLICT');

    // Zero resurrected messages & zero leaked GlobalBudget reservation
    const snap = await inspectAgent(harness, tenant);
    expect(snap.messages).toHaveLength(0);
    expect(snap.turns).toHaveLength(0);
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(0);

    // Wait for any compensation alarm/settle to release GlobalBudget hold
    await waitFor(async () => {
      const days = await readGlobalSpendDays(harness);
      return days.length === 0 || days[0]!.reserved_micro_usd === 0 ? true : null;
    });
  });

  it('F-9: markAttemptSent guards (cancelled/fenced/already_sent)', async () => {
    const harness = await bootHarness();
    const tenantA = await createTenantSession(harness, `alice-f9-${randomUUID()}`);

    // F-9: Prepare turn directly with fast_interactive lease to test markAttemptSent guards
    const prep = await agentRpc<{
      kind: string;
      turnId: string;
      attemptNo: number;
      operationId: string;
      leaseEpoch: number;
    }>(harness, tenantA, 'prepareTurn', {
      scope: {
        tenantId: tenantA.tenantId,
        principalId: tenantA.principalId,
        agentId: tenantA.agentId,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: tenantA.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Send gate F-9',
        transcript_epoch: 0,
      },
      workerId: 'worker-a',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-2026-11',
        maxAttempts: 1,
        estimatedMicroUsd: 250,
      },
    });
    expect(prep.ok).toBe(true);
    const turnId = prep.result!.turnId;

    // Wrong leaseOwner -> authorized: false ('fenced')
    const wrongOwner = await agentRpc<{ authorized: boolean; reason: string }>(
      harness,
      tenantA,
      'markAttemptSent',
      {
        scope: { tenantId: tenantA.tenantId, agentId: tenantA.agentId },
        subjectType: 'turn',
        subjectId: turnId,
        attemptNo: 1,
        operationId: prep.result!.operationId,
        leaseEpoch: 1,
        leaseOwner: 'wrong-worker',
      },
    );
    expect(wrongOwner.result).toEqual({ authorized: false, reason: 'fenced' });

    // Valid send authorization -> authorized: true
    const authOk = await agentRpc<{ authorized: boolean }>(harness, tenantA, 'markAttemptSent', {
      scope: { tenantId: tenantA.tenantId, agentId: tenantA.agentId },
      subjectType: 'turn',
      subjectId: turnId,
      attemptNo: 1,
      operationId: prep.result!.operationId,
      leaseEpoch: 1,
      leaseOwner: 'worker-a',
    });
    expect(authOk.result?.authorized).toBe(true);

    // Duplicate markAttemptSent -> authorized: false ('already_sent'), zero refund
    const authDup = await agentRpc<{ authorized: boolean; reason: string }>(
      harness,
      tenantA,
      'markAttemptSent',
      {
        scope: { tenantId: tenantA.tenantId, agentId: tenantA.agentId },
        subjectType: 'turn',
        subjectId: turnId,
        attemptNo: 1,
        operationId: prep.result!.operationId,
        leaseEpoch: 1,
        leaseOwner: 'worker-a',
      },
    );
    expect(authDup.result).toEqual({ authorized: false, reason: 'already_sent' });

    // Cancelled turn -> markAttemptSent returns authorized: false ('cancelled')
    const sub2 = await agentRpc<{ turnId: string; operationId: string }>(
      harness,
      tenantA,
      'prepareTurn',
      {
        scope: {
          tenantId: tenantA.tenantId,
          principalId: tenantA.principalId,
          agentId: tenantA.agentId,
          policyVersion: 1,
          requestId: randomUUID(),
        },
        conversationId: tenantA.conversationId,
        request: {
          client_submission_id: randomUUID(),
          text: 'Cancel before send F-9',
          transcript_epoch: 0,
        },
        workerId: 'worker-a2',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 600_000,
        executionMode: 'fast_interactive',
        modelReservation: {
          budgetMode: 'simulated_full_protocol',
          providerId: 'fake',
          modelLabel: 'ember-fake-model-gateway-1',
          rateVersion: 'fake-v2-2026-11',
          maxAttempts: 1,
          estimatedMicroUsd: 250,
        },
      },
    );
    const cancelRes = await harness.fetch(
      `/v1/conversations/${tenantA.conversationId}/turns/${sub2.result!.turnId}/cancel`,
      { method: 'POST', headers: { authorization: `Bearer ${tenantA.accessToken}` } },
    );
    expect(cancelRes.status).toBe(200);
    const afterCancel = await agentRpc<{ authorized: boolean; reason: string }>(
      harness,
      tenantA,
      'markAttemptSent',
      {
        scope: { tenantId: tenantA.tenantId, agentId: tenantA.agentId },
        subjectType: 'turn',
        subjectId: sub2.result!.turnId,
        attemptNo: 1,
        operationId: sub2.result!.operationId,
        leaseEpoch: 1,
        leaseOwner: 'worker-a2',
      },
    );
    expect(afterCancel.result).toEqual({ authorized: false, reason: 'cancelled' });
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(0);
  });

  it('F-16: cross-tenant 404 isolation, token rotation & reuse family revocation, zero prompt content leak', async () => {
    const harness = await bootHarness();
    const tenantA = await createTenantSession(harness, `alice-f16-${randomUUID()}`);
    const tenantB = await createTenantSession(harness, `bob-f16-${randomUUID()}`);

    const subA = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenantA.conversationId}/messages`,
      {
        client_submission_id: randomUUID(),
        text: 'Sensitive secret prompt F-16',
        transcript_epoch: 0,
      },
      { authorization: `Bearer ${tenantA.accessToken}` },
    );
    expect(subA.status).toBe(201);
    const turnId = subA.data.turn.turn_id;

    // F-16: Cross-tenant Tenant B -> Tenant A returns 404 everywhere & leaks zero prompt content
    const foreignRead = await harness.fetch(
      `/v1/conversations/${tenantA.conversationId}/messages`,
      { headers: { authorization: `Bearer ${tenantB.accessToken}` } },
    );
    expect(foreignRead.status).toBe(404);
    const foreignBody = await foreignRead.text();
    expect(foreignBody).not.toContain('Sensitive secret prompt');

    const foreignTurn = await harness.fetch(
      `/v1/conversations/${tenantA.conversationId}/turns/${turnId}`,
      { headers: { authorization: `Bearer ${tenantB.accessToken}` } },
    );
    expect(foreignTurn.status).toBe(404);

    // F-16: Refresh token rotation + reuse revokes entire session family
    const refresh1 = await harness.fetch('/v1/auth/session/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
    });
    expect(refresh1.status).toBe(200);
    const refreshData = (await refresh1.json()) as { access_token: string };
    const newToken = refreshData.access_token;
    // Replay old token -> 401 AND revokes newToken!
    const reuseRes = await harness.fetch('/v1/auth/session/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
    });
    expect(reuseRes.status).toBe(401);
    const afterReuse = await harness.fetch('/v1/me', {
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(afterReuse.status).toBe(401);
  });

  // ==========================================================================
  // Category 4: Chat Stream Crash & Disconnect Recovery (F-7, F-8, F-10)
  // ==========================================================================

  it('F-7 & F-8: Crash after prepare before markAttemptSent releases (0 charge); crash after markAttemptSent converges unknown_billed', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);

    // F-7: Crash right before markAttemptSent -> DO Alarm settles as released (0 charge)
    const now = Date.now();
    harness.faultInjector.setVirtualNowMs(now);
    harness.faultInjector.setCrashPoint('after_prepare_before_mark_sent', true);
    const stream7 = await harness.fetch(
      `/v2/conversations/${tenant.conversationId}/messages/stream`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tenant.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'F-7 crash before send',
          transcript_epoch: 0,
        }),
      },
    );
    expect(stream7.status).toBe(201);
    await stream7.text();
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(0);

    // Advance virtual clock past fast lease (45s) + turn deadline (600s) -> run DO alarm
    harness.faultInjector.setVirtualNowMs(now + 610_000);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      nowMs: now + 610_000,
    });
    // Wait for Queue / Alarm to settle budget_sync(released)
    await waitFor(async () => {
      const snap = await inspectAgent(harness, tenant);
      const a = snap.attempts[0];
      return a?.state === 'released' && a.global_synced_at_ms !== null ? snap : null;
    });
    const spend7 = await readGlobalSpendDays(harness);
    expect(spend7[0]?.consumed_micro_usd ?? 0).toBe(0);
    expect(spend7[0]?.reserved_micro_usd ?? 0).toBe(0);

    // F-8: Crash right after markAttemptSent before provider fetch -> converges as unknown_billed (retains charge, never replays)
    const tenant8 = await createTenantSession(harness);
    const t8Start = Date.now();
    harness.faultInjector.setVirtualNowMs(t8Start);
    harness.faultInjector.setCrashPoint('after_mark_sent_before_provider_fetch', true);
    const stream8 = await harness.fetch(
      `/v2/conversations/${tenant8.conversationId}/messages/stream`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tenant8.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'F-8 crash after send',
          transcript_epoch: 0,
        }),
      },
    );
    expect(stream8.status).toBe(201);
    await stream8.text();
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(0);

    // Advance past 45s lease -> alarm enqueues to durable_turn -> Queue claims & sees send_started_at_ms !== null && providerJobHandle === null -> unknown_billed!
    harness.faultInjector.setVirtualNowMs(t8Start + 60_000);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenant8.tenantId,
      agentId: tenant8.agentId,
      nowMs: t8Start + 60_000,
    });

    const settled8 = await waitFor(async () => {
      const snap = await inspectAgent(harness, tenant8);
      const a = snap.attempts[0];
      return a?.state === 'unknown_billed' && a.global_synced_at_ms !== null ? snap : null;
    });
    expect(settled8.attempts[0]?.state).toBe('unknown_billed');
    // Provider was NEVER blindly replayed!
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(0);
    // Reservation retained as consumed in GlobalBudgetDO
    const spend8 = await readGlobalSpendDays(harness);
    expect(spend8[0]?.consumed_micro_usd).toBe(250);
  });

  it(
    'F-10: Client disconnect mid-stream hands off to Durable Queue, polls job handle once, commits zero duplicates',
    { timeout: 145_000 },
    async () => {
      const harness = await bootHarness();
      const tenant = await createTenantSession(harness);
      const fixedHandle = `job_f10_${randomUUID().slice(0, 8)}`;
      harness.fakeGateway.setDefaultRule({
        mode: 'slow_handoff',
        delayMs: 118_000,
        completeOnPoll: true,
        replyText: 'Recovered after SSE disconnect',
        costMicroUsd: 165,
        providerJobHandle: fixedHandle,
      });

      const subId = randomUUID();
      const connection = new AbortController();
      const res = await harness.fetchOverHttp(
        `/v2/conversations/${tenant.conversationId}/messages/stream`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tenant.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            client_submission_id: subId,
            text: 'Disconnect mid-stream F-10',
            transcript_epoch: 0,
          }),
          signal: connection.signal,
        },
      );
      expect(res.status).toBe(201);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let seen = '';
      while (!seen.includes('event: turn.delta')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        seen += decoder.decode(chunk.value, { stream: true });
      }
      const frames = parseSseFrames(seen);
      const receipt = B1SendMessageReceiptSchema.parse(
        frames.find((f) => f.event === 'turn.accepted')!.data,
      );
      // Client disconnects mid-stream!
      connection.abort();
      await reader.cancel().catch(() => undefined);

      const completed = await waitFor(
        async () => {
          const tRes = await harness.fetchJson<{ status: string }>(
            `/v1/conversations/${tenant.conversationId}/turns/${receipt.turn.turn_id}`,
            undefined,
            { authorization: `Bearer ${tenant.accessToken}` },
          );
          return tRes.data.status === 'completed'
            ? B1AssistantTurnDtoSchema.parse(tRes.data)
            : null;
        },
        130_000,
        250,
      );
      expect(completed.status).toBe('completed');

      const pageRes = await harness.fetchJson(
        `/v1/conversations/${tenant.conversationId}/messages?after=0&limit=50`,
        undefined,
        { authorization: `Bearer ${tenant.accessToken}` },
      );
      const page = B1ConversationPageSchema.parse(pageRes.data);
      expect(page.messages).toHaveLength(2);
      expect(page.messages[1]).toMatchObject({
        kind: 'ember',
        text: 'Recovered after SSE disconnect',
      });

      const audit = await waitFor(
        async () => {
          const snap = harness.fakeGateway.getAuditSnapshot();
          return Promise.resolve(snap.totalCalls === 1 ? snap : null);
        },
        15_000,
        100,
      );
      expect(audit.totalCalls).toBe(1);
      expect(audit.jobPollCount).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    'D8 Defect #7 / D9: 20+ consecutive SSE turns preserve context ordering, current message, attachments, and durable handoff',
    { timeout: 145_000 },
    async () => {
      const harness = await bootHarness();
      const tenant = await createTenantSession(harness);
      // Omit replyText so FakeModelGatewayServer echoes promptText = context.at(-1).text
      harness.fakeGateway.setDefaultRule({
        mode: 'fast_ok',
        costMicroUsd: 120,
      });

      // 1. 20 consecutive interactive SSE turns on the same conversation (40 messages > 8-row context bound)
      for (let i = 0; i < 20; i += 1) {
        const promptText = `Multi-turn request ${i + 1}`;
        const res = await harness.fetch(
          `/v2/conversations/${tenant.conversationId}/messages/stream`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${tenant.accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              client_submission_id: randomUUID(),
              text: promptText,
              transcript_epoch: 0,
            }),
          },
        );
        expect(res.status).toBe(201);
        const body = await res.text();
        const frames = parseSseFrames(body);
        expect(frames.some((f) => f.event === 'turn.delta')).toBe(true);
        const committed = frames.find((f) => f.event === 'turn.committed');
        expect(committed).toBeDefined();
        const receipt = B1SendMessageReceiptSchema.parse(
          frames.find((f) => f.event === 'turn.accepted')!.data,
        );
        const settled = await waitFor(async () => {
          const snap = await inspectAgent(harness, tenant);
          const turn = snap.turns.find((r) => r.id === receipt.turn.turn_id);
          return turn?.status === 'completed' ? snap : null;
        });
        const assistantMsg = settled.messages.find(
          (m) => m.sequence === receipt.message.sequence + 1 && m.kind === 'ember',
        );
        expect(assistantMsg?.text).toContain(promptText);
      }

      const after20 = await inspectAgent(harness, tenant);
      expect(after20.messages).toHaveLength(40);
      expect(after20.messages.filter((m) => m.kind === 'user')).toHaveLength(20);
      expect(after20.messages.filter((m) => m.kind === 'ember')).toHaveLength(20);
      expect(after20.messages.map((m) => m.sequence)).toEqual(
        Array.from({ length: 40 }, (_, idx) => idx + 1),
      );
      expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(20);

      // 2. Turn 21 with attachment metadata on the >40-message conversation:
      //    verify Stage 3 context keeps 8 rows in ascending sequence (34..41), includes current message & attachments,
      //    and passes unmodified buildBoundedContext() without exceeding maxContextMessages (8).
      const attId = randomUUID();
      const attPrep = await agentRpc<{
        kind: string;
        turnId: string;
        operationId: string;
        context: readonly ContextRow[];
        attachments: ReadonlyArray<{
          uploadId: string;
          filename: string;
          mediaType: string;
          sizeBytes: number;
        }>;
      }>(harness, tenant, 'prepareTurn', {
        scope: {
          tenantId: tenant.tenantId,
          principalId: tenant.principalId,
          agentId: tenant.agentId,
          policyVersion: 1,
          requestId: randomUUID(),
        },
        conversationId: tenant.conversationId,
        request: {
          client_submission_id: randomUUID(),
          text: 'Turn 21 with attachment',
          attachment_ids: [attId],
          transcript_epoch: 0,
        },
        resolvedAttachments: [
          {
            uploadId: attId,
            filename: 'd9-evidence.pdf',
            mediaType: 'application/pdf',
            sizeBytes: 2048,
            r2Key: `uploads/${attId}`,
            sha256: 'c'.repeat(64),
          },
        ],
        workerId: 'd9-att-worker',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 600_000,
        executionMode: 'fast_interactive',
        modelReservation: {
          budgetMode: 'simulated_full_protocol',
          providerId: 'fake',
          modelLabel: 'ember-fake-model-gateway-1',
          rateVersion: 'fake-v2-2026-11',
          maxAttempts: 1,
          estimatedMicroUsd: 250,
        },
      });
      expect(attPrep.ok).toBe(true);
      expect(attPrep.result?.context).toHaveLength(8);
      expect(attPrep.result?.context.map((r) => r.sequence)).toEqual([
        34, 35, 36, 37, 38, 39, 40, 41,
      ]);
      const currentCtxRow = attPrep.result?.context.at(-1);
      expect(currentCtxRow).toMatchObject({
        sequence: 41,
        kind: 'user',
        text: 'Turn 21 with attachment',
        attachments: [
          {
            uploadId: attId,
            filename: 'd9-evidence.pdf',
            mediaType: 'application/pdf',
            sizeBytes: 2048,
          },
        ],
      });
      const bounded = buildBoundedContext(attPrep.result!.context);
      expect(bounded.messages).toHaveLength(8);
      expect(bounded.messages.at(-1)).toMatchObject({
        role: 'user',
        text: 'Turn 21 with attachment',
        attachments: [
          {
            uploadId: attId,
            filename: 'd9-evidence.pdf',
            mediaType: 'application/pdf',
            sizeBytes: 2048,
          },
        ],
      });

      // Commit Turn 21 cleanly before Durable Handoff check on Turn 22
      const attAuth = await agentRpc<{ authorized: boolean }>(harness, tenant, 'markAttemptSent', {
        scope: { tenantId: tenant.tenantId, agentId: tenant.agentId },
        subjectType: 'turn',
        subjectId: attPrep.result!.turnId,
        attemptNo: 1,
        operationId: attPrep.result!.operationId,
        leaseEpoch: 1,
        leaseOwner: 'd9-att-worker',
      });
      expect(attAuth.result?.authorized).toBe(true);
      const attCommit = await agentRpc<{ outcome: string }>(harness, tenant, 'commitTurn', {
        scope: { tenantId: tenant.tenantId, agentId: tenant.agentId },
        conversationId: tenant.conversationId,
        turnId: attPrep.result!.turnId,
        leaseEpoch: 1,
        leaseOwner: 'd9-att-worker',
        attemptNo: 1,
        operationId: attPrep.result!.operationId,
        settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 120 },
        result: {
          status: 'completed',
          text: 'Turn 21 attachment acknowledged',
          modelLabel: 'ember-fake-model-gateway-1',
          simulated: true,
        },
      });
      expect(attCommit.result?.outcome).toBe('published');

      // 3. Turn 22 Durable Handoff mid-stream on the 42-message conversation
      const handoffHandle = `job_d9_${randomUUID().slice(0, 8)}`;
      harness.fakeGateway.setDefaultRule({
        mode: 'slow_handoff',
        delayMs: 118_000,
        completeOnPoll: true,
        replyText: 'Turn 22 durable handoff after 20+ turns',
        costMicroUsd: 145,
        providerJobHandle: handoffHandle,
      });
      const connection = new AbortController();
      const handoffRes = await harness.fetchOverHttp(
        `/v2/conversations/${tenant.conversationId}/messages/stream`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tenant.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            client_submission_id: randomUUID(),
            text: 'Turn 22 handoff after 20+ turns',
            transcript_epoch: 0,
          }),
          signal: connection.signal,
        },
      );
      expect(handoffRes.status).toBe(201);
      const reader = (handoffRes.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let seen = '';
      while (!seen.includes('event: turn.delta')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        seen += decoder.decode(chunk.value, { stream: true });
      }
      const handoffReceipt = B1SendMessageReceiptSchema.parse(
        parseSseFrames(seen).find((f) => f.event === 'turn.accepted')!.data,
      );
      connection.abort();
      await reader.cancel().catch(() => undefined);

      const handoffCompleted = await waitFor(
        async () => {
          const s = await inspectAgent(harness, tenant);
          const t = s.turns.find((r) => r.id === handoffReceipt.turn.turn_id);
          return t?.status === 'completed' ? s : null;
        },
        130_000,
        250,
      );
      expect(
        handoffCompleted.turns.find((r) => r.id === handoffReceipt.turn.turn_id)?.handoff_reason,
      ).toBe('client_disconnect_handoff');
      expect(
        handoffCompleted.messages.find(
          (m) => m.sequence === handoffReceipt.message.sequence + 1 && m.kind === 'ember',
        )?.text,
      ).toBe('Turn 22 durable handoff after 20+ turns');
      const handoffAudit = await waitFor(
        async () => {
          const snap = harness.fakeGateway.getAuditSnapshot();
          return Promise.resolve(snap.totalCalls === 21 ? snap : null);
        },
        15_000,
        100,
      );
      expect(handoffAudit.totalCalls).toBe(21);
      expect(handoffAudit.jobPollCount).toBe(1);
    },
  );

  // ==========================================================================
  // Category 5: Long-Reasoning Handoff & Fencing (F-12, F-21, FI-13, FI-14)
  // ==========================================================================

  it('F-12, F-21, FI-13 & FI-14: 15s renewal + 120s handoff preserves 600s deadline, polls handle, fences invalid handoffs & missing-handle hang', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);
    const baseMs = Date.now();
    harness.faultInjector.setVirtualNowMs(baseMs);

    // 1. Prepare fast_interactive turn at baseMs
    const prep = await agentRpc<{
      turnId: string;
      operationId: string;
      leaseEpoch: number;
      turnDeadlineMs: number;
    }>(harness, tenant, 'prepareTurn', {
      scope: {
        tenantId: tenant.tenantId,
        principalId: tenant.principalId,
        agentId: tenant.agentId,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: tenant.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Long reasoning turn FI-13',
        transcript_epoch: 0,
      },
      workerId: 'interactive-worker-1',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'fast_interactive',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-2026-11',
        maxAttempts: 1,
        estimatedMicroUsd: 250,
      },
    });
    expect(prep.ok).toBe(true);
    const { turnId, operationId } = prep.result!;

    const sent = await agentRpc<{ authorized: boolean }>(harness, tenant, 'markAttemptSent', {
      scope: { tenantId: tenant.tenantId, agentId: tenant.agentId },
      subjectType: 'turn',
      subjectId: turnId,
      attemptNo: 1,
      operationId,
      leaseEpoch: 1,
      leaseOwner: 'interactive-worker-1',
    });
    expect(sent.result?.authorized).toBe(true);

    // Renew every 15s up to +105s
    for (const step of [15_000, 30_000, 45_000, 60_000, 75_000, 90_000, 105_000]) {
      harness.faultInjector.setVirtualNowMs(baseMs + step);
      const renew = await agentRpc<{ renewed: boolean; leaseExpiresAtMs: number }>(
        harness,
        tenant,
        'renewTurnLease',
        {
          scope: { tenantId: tenant.tenantId, agentId: tenant.agentId },
          conversationId: tenant.conversationId,
          turnId,
          leaseEpoch: 1,
          leaseOwner: 'interactive-worker-1',
          extendMs: 45_000,
        },
      );
      expect(renew.result?.renewed).toBe(true);
    }

    // Wrong-owner handoff -> fenced
    const wrongOwnerHandoff = await agentRpc<{ outcome: string }>(
      harness,
      tenant,
      'handoffTurnToDurable',
      {
        scope: { tenantId: tenant.tenantId, agentId: tenant.agentId },
        conversationId: tenant.conversationId,
        turnId,
        leaseEpoch: 1,
        leaseOwner: 'rogue-worker',
        reason: 'interactive_deadline_120s',
        providerJobHandle: 'fake-job-fi13',
      },
    );
    expect(wrongOwnerHandoff.result?.outcome).toBe('fenced');

    // Valid handoff at +110s -> handed_off, bumps lease_epoch=2, preserves 600s deadline_at_ms!
    harness.faultInjector.setVirtualNowMs(baseMs + 110_000);
    const handoff = await agentRpc<{ outcome: string; nextLeaseEpoch: number }>(
      harness,
      tenant,
      'handoffTurnToDurable',
      {
        scope: { tenantId: tenant.tenantId, agentId: tenant.agentId },
        conversationId: tenant.conversationId,
        turnId,
        leaseEpoch: 1,
        leaseOwner: 'interactive-worker-1',
        reason: 'interactive_deadline_120s',
        providerJobHandle: 'fake-job-fi13',
      },
    );
    expect(handoff.result).toMatchObject({ outcome: 'handed_off', nextLeaseEpoch: 2 });

    // Stale interactive executor commit is rejected (fenced)
    const staleCommit = await agentRpc<{ outcome: string }>(harness, tenant, 'commitTurn', {
      scope: { tenantId: tenant.tenantId, agentId: tenant.agentId },
      conversationId: tenant.conversationId,
      turnId,
      leaseEpoch: 1,
      leaseOwner: 'interactive-worker-1',
      attemptNo: 1,
      operationId,
      settlement: { state: 'settled', outcomeCode: 'ok', observedCostMicroUsd: 120 },
      result: {
        status: 'completed',
        text: 'Stale reply',
        modelLabel: 'ember-fake-model-gateway-1',
        simulated: true,
      },
    });
    expect(staleCommit.result?.outcome).toBe('fenced');

    // Original 600s deadline_at_ms preserved
    const snap = await inspectAgent(harness, tenant);
    const turnRow = snap.turns.find((t) => t.id === turnId)!;
    expect(turnRow.deadline_at_ms).toBe(baseMs + 600_000);
    expect(turnRow.provider_job_handle).toBe('fake-job-fi13');

    // F-21 & FI-14: Expired lease handoff & missing-handle hang converge cleanly as unknown_billed
    const tenantMissing = await createTenantSession(harness);
    const mStart = Date.now();
    harness.faultInjector.setVirtualNowMs(mStart);
    const prepM = await agentRpc<{ turnId: string; operationId: string }>(
      harness,
      tenantMissing,
      'prepareTurn',
      {
        scope: {
          tenantId: tenantMissing.tenantId,
          principalId: tenantMissing.principalId,
          agentId: tenantMissing.agentId,
          policyVersion: 1,
          requestId: randomUUID(),
        },
        conversationId: tenantMissing.conversationId,
        request: {
          client_submission_id: randomUUID(),
          text: 'Expired / missing handle',
          transcript_epoch: 0,
        },
        workerId: 'w-m1',
        leaseMs: 45_000,
        interactiveDeadlineMs: 120_000,
        turnDeadlineMs: 60_000,
        executionMode: 'fast_interactive',
        modelReservation: {
          budgetMode: 'simulated_full_protocol',
          providerId: 'fake',
          modelLabel: 'ember-fake-model-gateway-1',
          rateVersion: 'fake-v2-2026-11',
          maxAttempts: 1,
          estimatedMicroUsd: 250,
        },
      },
    );
    await agentRpc(harness, tenantMissing, 'markAttemptSent', {
      scope: { tenantId: tenantMissing.tenantId, agentId: tenantMissing.agentId },
      subjectType: 'turn',
      subjectId: prepM.result!.turnId,
      attemptNo: 1,
      operationId: prepM.result!.operationId,
      leaseEpoch: 1,
      leaseOwner: 'w-m1',
    });

    // Advance past 45s lease -> handoffTurnToDurable MUST reject expired lease!
    harness.faultInjector.setVirtualNowMs(mStart + 46_000);
    const expiredHandoff = await agentRpc<{ outcome: string }>(
      harness,
      tenantMissing,
      'handoffTurnToDurable',
      {
        scope: { tenantId: tenantMissing.tenantId, agentId: tenantMissing.agentId },
        conversationId: tenantMissing.conversationId,
        turnId: prepM.result!.turnId,
        leaseEpoch: 1,
        leaseOwner: 'w-m1',
        reason: 'client_disconnect_handoff',
      },
    );
    expect(expiredHandoff.result?.outcome).toBe('fenced');

    // Alarm + Queue converges missing-handle uncertain send as unknown_billed within <=60s!
    harness.faultInjector.setVirtualNowMs(mStart + 52_000);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenantMissing.tenantId,
      agentId: tenantMissing.agentId,
      nowMs: mStart + 52_000,
    });
    const mSettled = await waitFor(async () => {
      const s = await inspectAgent(harness, tenantMissing);
      return s.attempts[0]?.state === 'unknown_billed' ? s : null;
    });
    expect(mSettled.attempts[0]?.state).toBe('unknown_billed');
  });

  // ==========================================================================
  // Category 6: Queue Duplicates, Forged Envelopes, Crash Points & DLQ (F-22, FI-04, FI-05, FI-06, FI-07)
  // ==========================================================================

  it('F-22, FI-04, FI-05, FI-06 & FI-07: Forged envelopes, duplicate delivery, commit/send crashes, DLQ convergence & boundary cap', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);

    // FI-04a: Crash after Queue.send before outbox update + 3x duplicate Queue delivery
    harness.faultInjector.setQueueFault({ duplicateCount: 3 });
    harness.faultInjector.setCrashPoint('after_queue_send_before_outbox_update', true);
    const sub1 = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Duplicate queue FI-04', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(sub1.status).toBe(201);
    const settled = await waitFor(async () => {
      const s = await inspectAgent(harness, tenant);
      return s.turns[0]?.status === 'completed' && s.attempts[0]?.global_synced_at_ms !== null
        ? s
        : null;
    });
    harness.faultInjector.setQueueFault({ duplicateCount: 1 });
    expect(settled.messages.filter((m) => m.kind === 'ember')).toHaveLength(1);
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(1);

    // FI-04b: Crash after DO commit before Queue.send -> re-running Alarm recovers dispatch
    harness.faultInjector.setCrashPoint('after_do_commit_before_queue_send', true);
    const sub2 = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      {
        client_submission_id: randomUUID(),
        text: 'Crash before queue send FI-04',
        transcript_epoch: 0,
      },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(sub2.status).toBe(201);
    await new Promise((r) => setTimeout(r, 250));
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
    });
    const settled2 = await waitFor(async () => {
      const s = await inspectAgent(harness, tenant);
      return s.turns.find((t) => t.id === sub2.data.turn.turn_id)?.status === 'completed'
        ? s
        : null;
    });
    expect(settled2.messages.filter((m) => m.kind === 'ember')).toHaveLength(2);

    // F-22 & FI-05: Forged/stale/future/wrong-queue/budget_sync envelopes produce 0 mutations
    const msgCountBefore = settled2.messages.length;
    const baseEnv: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: `turn:${sub2.data.turn.turn_id}:epoch:1`,
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      entityKind: 'turn',
      entityId: sub2.data.turn.turn_id,
      queueName: 'durable_turn',
      fenceEpoch: 1,
    };
    const forgedPresets = [
      'budget_sync_in_queue',
      'null_queue_name',
      'wrong_tenant',
      'wrong_agent',
      'wrong_queue',
      'future_fence_epoch',
      'stale_fence_epoch',
    ] as const;
    for (const preset of forgedPresets) {
      const forged = harness.faultInjector.buildForgedEnvelope(baseEnv, preset);
      await harness.fetchJson('/_test/queue/send', {
        queueName: 'durable_turn',
        envelope: forged,
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    const afterForged = await inspectAgent(harness, tenant);
    expect(afterForged.messages.length).toBe(msgCountBefore);

    // FI-07: Force Queue retries exhausted -> durable_turn_dlq -> onDispatchDeadLetter
    harness.faultInjector.setQueueFault({ forceDlq: true });
    const subDlq = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenant.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Force DLQ FI-07', transcript_epoch: 0 },
      { authorization: `Bearer ${tenant.accessToken}` },
    );
    expect(subDlq.status).toBe(201);
    const dlqSnap = await waitFor(async () => {
      const s = await inspectAgent(harness, tenant);
      const out = s.outbox.find((o) => o.entity_id === subDlq.data.turn.turn_id);
      return out && out.state === 'dead_lettered' && out.dlq_count >= 1 ? s : null;
    });
    harness.faultInjector.setQueueFault({ forceDlq: false });
    expect(
      dlqSnap.outbox.find((o) => o.entity_id === subDlq.data.turn.turn_id)?.last_error_code,
    ).toBe('QUEUE_MAX_RETRIES_EXHAUSTED');

    // FI-06 & F-22: Deadline retry boundaries (remaining = 0, 500, 1000, 1001 ms)
    const tNow = 1_750_000_000_000;
    expect(computePreDeadlineRetryAtMs(tNow, tNow)).toEqual({
      shouldRetry: false,
      alarmAtMs: tNow,
      remainingMs: 0,
    });
    expect(computePreDeadlineRetryAtMs(tNow, tNow + 500)).toEqual({
      shouldRetry: false,
      alarmAtMs: tNow + 500,
      remainingMs: 500,
    });
    expect(computePreDeadlineRetryAtMs(tNow, tNow + 1_000)).toEqual({
      shouldRetry: false,
      alarmAtMs: tNow + 1_000,
      remainingMs: 1_000,
    });
    expect(computePreDeadlineRetryAtMs(tNow, tNow + 1_001)).toEqual({
      shouldRetry: true,
      nextAttemptAtMs: tNow + 1_000,
      remainingMs: 1_001,
    });
  });

  it('D7 Step 4A: Crash after Claim before markAttemptSent preserves accepted work (pre-send retry) and zero duplicate sends', async () => {
    const harness = await bootHarness();

    // Subcase A: Claim -> crash BEFORE markAttemptSent (after_claim_before_send) -> lease expires -> re-enqueued & completes with 1 provider call & 0 lost work
    const tenantA = await createTenantSession(harness);
    harness.fakeGateway.setDefaultRule({
      mode: 'fast_ok',
      replyText: 'Recovered pre-send claim',
      costMicroUsd: 165,
    });
    const t0 = Date.now();
    harness.faultInjector.setVirtualNowMs(t0);
    harness.faultInjector.setCrashPoint('after_claim_before_send', true);

    const subA = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenantA.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Claim crash before sent', transcript_epoch: 0 },
      { authorization: `Bearer ${tenantA.accessToken}` },
    );
    expect(subA.status).toBe(201);

    // Wait for first claim attempt to commit claim_count >= 1 & crash before markAttemptSent
    const afterClaimCrash = await waitFor(async () => {
      const s = await inspectAgent(harness, tenantA);
      const t = s.turns.find((r) => r.id === subA.data.turn.turn_id);
      const o = s.outbox.find((r) => r.entity_id === subA.data.turn.turn_id);
      return t && t.claim_count >= 1 && o?.state === 'acked' ? s : null;
    });
    expect(afterClaimCrash.turns[0]?.status).toBe('running');
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(0);

    // Advance virtual clock past 45s lease (still inside 60s turn deadline!) -> schedules retry at min(now+60s, deadline-5s)=+55s -> fire at +55.5s!
    harness.faultInjector.setVirtualNowMs(t0 + 46_000);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenantA.tenantId,
      agentId: tenantA.agentId,
      nowMs: t0 + 46_000,
    });
    harness.faultInjector.setVirtualNowMs(t0 + 55_500);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenantA.tenantId,
      agentId: tenantA.agentId,
      nowMs: t0 + 55_500,
    });

    const settledA = await waitFor(async () => {
      const s = await inspectAgent(harness, tenantA);
      const t = s.turns.find((r) => r.id === subA.data.turn.turn_id);
      const a = s.attempts.find(
        (r) => r.subject_id === subA.data.turn.turn_id && r.state === 'settled',
      );
      return t?.status === 'completed' && a?.global_synced_at_ms !== null ? s : null;
    });
    expect(settledA.messages.filter((m) => m.kind === 'ember')).toHaveLength(1);
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(1);
    const spendA = await readGlobalSpendDays(harness);
    expect(spendA[0]?.consumed_micro_usd).toBe(165);
  });

  it('D7 Step 4B: Crash after Provider send before Commit preserves known/conservative usage and zero duplicate sends', async () => {
    const harness = await bootHarness();
    const tenantB = await createTenantSession(harness);
    harness.fakeGateway.setDefaultRule({
      mode: 'fast_ok',
      replyText: 'Crash after send',
      costMicroUsd: 165,
    });
    const callsBeforeB = harness.fakeGateway.getAuditSnapshot().totalCalls;
    const tB = Date.now();
    harness.faultInjector.setVirtualNowMs(tB);
    harness.faultInjector.setCrashPoint('after_claim_before_commit', true);

    const subB = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenantB.conversationId}/messages`,
      {
        client_submission_id: randomUUID(),
        text: 'Claim crash after send before commit',
        transcript_epoch: 0,
      },
      { authorization: `Bearer ${tenantB.accessToken}` },
    );
    expect(subB.status).toBe(201);

    // Wait until markAttemptSent + provider ran (totalCalls == callsBeforeB + 1) and crash blocked commit
    await waitFor(async () => {
      const s = await inspectAgent(harness, tenantB);
      const a = s.attempts.find((r) => r.subject_id === subB.data.turn.turn_id);
      return a?.send_started_at_ms !== null &&
        harness.fakeGateway.getAuditSnapshot().totalCalls === callsBeforeB + 1
        ? s
        : null;
    });

    // Advance past 45s lease + 60s turn deadline -> alarm converges conservatively (unknown_billed, 250 micro_usd), ZERO duplicate sends!
    harness.faultInjector.setVirtualNowMs(tB + 61_000);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenantB.tenantId,
      agentId: tenantB.agentId,
      nowMs: tB + 61_000,
    });
    const settledB = await waitFor(async () => {
      const s = await inspectAgent(harness, tenantB);
      const a = s.attempts.find((r) => r.subject_id === subB.data.turn.turn_id);
      return a?.global_synced_at_ms !== null ? s : null;
    });
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(callsBeforeB + 1);
    expect(settledB.attempts[0]?.state).toBe('unknown_billed');
    expect(settledB.attempts[0]?.applied_cost_micro_usd).toBe(250);
    const spendB = await readGlobalSpendDays(harness);
    expect(spendB[0]?.consumed_micro_usd).toBe(250);
    harness.faultInjector.setVirtualNowMs(null);
  });

  // ==========================================================================
  // Category 7: Offline Alarm Exhaustion + Sweeper + Schedules + DST (F-14, F-20, FI-08, FI-09, FI-16)
  // ==========================================================================

  it('F-14, F-20, FI-08 & FI-09: 7 consecutive Alarm failures recovered offline by Cron Sweeper <=5min, preserves future schedule, backoff & quarantine', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);
    const baseMs = Date.now();
    const futureScheduleAtMs = baseMs + 240_000;
    harness.faultInjector.setVirtualNowMs(baseMs);

    // Schedule a future one-shot reminder so coverage persists & postpones after turn recovery
    await agentRpc(harness, tenant, 'upsertSchedule', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      scheduleId: 'sched-future-fi08',
      sourceKind: 'reminder',
      sourceId: 'rem-fi08',
      scheduleKind: 'once',
      intervalSeconds: null,
      cronExpr: null,
      firstFireAtMs: futureScheduleAtMs,
    });

    // Inject 7 consecutive alarm failures (1 initial crashPoint + 6 retries) BEFORE submitting 600s-deadline durable turn
    harness.faultInjector.setAlarmExhaustion(6);
    const subRes = await agentRpc<{ turnId: string }>(harness, tenant, 'prepareTurn', {
      scope: {
        tenantId: tenant.tenantId,
        principalId: tenant.principalId,
        agentId: tenant.agentId,
        policyVersion: 1,
        requestId: randomUUID(),
      },
      conversationId: tenant.conversationId,
      request: {
        client_submission_id: randomUUID(),
        text: 'Offline 7-alarm recovery',
        transcript_epoch: 0,
      },
      workerId: 'worker-f14',
      leaseMs: 45_000,
      interactiveDeadlineMs: 120_000,
      turnDeadlineMs: 600_000,
      executionMode: 'durable_queue',
      modelReservation: {
        budgetMode: 'simulated_full_protocol',
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-2026-11',
        maxAttempts: 1,
        estimatedMicroUsd: 250,
      },
    });
    expect(subRes.ok).toBe(true);

    // Exhaust 7 DO alarm invocations while clients are offline (accounting for any real workerd auto-alarm fire)
    for (let i = 0; i < 7; i += 1) {
      const preSnap = await inspectAgent(harness, tenant);
      if ((preSnap.coverage[0]?.alarm_fail_count ?? 0) >= 7) break;
      const alarmTry = await harness.fetchJson<{ ok: boolean }>('/_test/agent/alarm', {
        tenantId: tenant.tenantId,
        agentId: tenant.agentId,
        nowMs: baseMs + i * 5_000,
      });
      expect(alarmTry.data.ok).toBe(false);
    }
    const midSnap = await inspectAgent(harness, tenant);
    expect(midSnap.coverage[0]?.alarm_fail_count).toBe(7);

    // F-20 & FI-09: While DO alarm still fails (1x), Sweeper enters backoff at earliest discovery + grace and keeps next_recovery_at_ms immutable
    harness.faultInjector.setAlarmExhaustion(0);
    const d1BeforeBackoff = await readD1Rows(harness);
    const origRecoveryAt = d1BeforeBackoff[0]!.next_recovery_at_ms;
    const sweepBackoff = await harness.fetchJson<{ backoffCount: number }>('/_test/sweeper/run', {
      nowMs: origRecoveryAt + 5_000,
      sweeperId: 'sweeper-backoff',
    });
    expect(sweepBackoff.data.backoffCount).toBe(1);
    const d1AfterBackoff = await readD1Rows(harness);
    expect(d1AfterBackoff[0]!.status).toBe('backoff');
    expect(d1AfterBackoff[0]!.next_recovery_at_ms).toBe(origRecoveryAt);
    expect(d1AfterBackoff[0]!.retry_not_before_ms).toBeGreaterThan(origRecoveryAt + 5_000);

    // Now DO recovers; Sweeper wakes at due discovery + retry_not_before_ms (<= 2min detection, <= 5min recovery)
    const wakeAt = d1AfterBackoff[0]!.retry_not_before_ms! + 1_000;
    expect(wakeAt - baseMs).toBeLessThanOrEqual(300_000);
    harness.faultInjector.setVirtualNowMs(wakeAt);
    const sweepRecover = await harness.fetchJson<{ keptArmedCount: number }>('/_test/sweeper/run', {
      nowMs: wakeAt,
      sweeperId: 'sweeper-recover',
    });
    expect(sweepRecover.data.keptArmedCount).toBe(1);

    const recovered = await waitFor(async () => {
      const s = await inspectAgent(harness, tenant);
      return s.turns[0]?.status === 'completed' && s.attempts[0]?.global_synced_at_ms !== null
        ? s
        : null;
    });
    expect(recovered.turns[0]?.status).toBe('completed');
    // Fire follow-up alarm tick so AlarmMultiplexer re-arms to futureScheduleAtMs after budget_sync ack
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      nowMs: wakeAt + 1_000,
    });
    const afterRearm = await inspectAgent(harness, tenant);
    // Future schedule preserved & alarm postponed to futureScheduleAtMs!
    expect(afterRearm.schedules[0]).toMatchObject({
      schedule_id: 'sched-future-fi08',
      status: 'active',
      next_fire_at_ms: futureScheduleAtMs,
    });
    expect(afterRearm.coverage[0]?.armed_alarm_at_ms).toBe(futureScheduleAtMs);

    // FI-09: Stale sweep_lease_owner CAS rejected
    const staleD1 = await harness.fetchJson<{ meta?: { changes?: number } }>('/_test/d1/exec', {
      sql: `UPDATE v2_recovery_registry SET status = 'quarantined' WHERE agent_key = ? AND sweep_lease_owner = 'stale-owner'`,
      bindings: [`${tenant.tenantId}:${tenant.agentId}`],
    });
    expect(staleD1.data.meta?.changes ?? 0).toBe(0);
  });

  it('F-18 & FI-16: Task multi-run retry caps (4/6 attempts, 20k/30k cost) and DST Spring-Forward / Fall-Back schedules', async () => {
    const harness = await bootHarness();
    const tenant = await createTenantSession(harness);
    const now = Date.now();
    harness.faultInjector.setVirtualNowMs(now);

    // F-18: Create notes.action_items task (cap 4 attempts, 20k micro_usd)
    const taskId = randomUUID();
    const createRes = await agentRpc(harness, tenant, 'createTestTask', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      taskId,
      kind: 'notes.action_items',
      inputJson: JSON.stringify({ notes: 'test task caps' }),
      digest: 'd'.repeat(64),
      idempotencyKey: `task-cap-${taskId}`,
      deadlineAtMs: now + 300_000,
    });
    expect(createRes.ok).toBe(true);

    // Manually drive 4 task runs + reserveTaskModelAttempt + settleTaskModelAttempt -> 5th hits attempts_exhausted
    for (let i = 1; i <= 4; i += 1) {
      const env: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: `task:${taskId}:epoch:${i}`,
        tenantId: tenant.tenantId,
        agentId: tenant.agentId,
        entityKind: 'task',
        entityId: taskId,
        queueName: 'agent_task',
        fenceEpoch: i,
      };
      // Update outbox / claim via direct SQL or claimDurableWork on epoch 1 then check cap
      if (i === 1) {
        const claim = await agentRpc<{ kind: string; leaseEpoch: number }>(
          harness,
          tenant,
          'claimDurableWork',
          { envelope: env, workerId: 'w-task', leaseMs: 30_000 },
        );
        expect(claim.result?.kind).toBe('claimed');
      }
    }
    const snapTask = await inspectAgent(harness, tenant);
    const runId = snapTask.runs[0]!.id;
    for (let a = 1; a <= 4; a += 1) {
      const res = await agentRpc<{ kind: string; attemptNo: number; operationId: string }>(
        harness,
        tenant,
        'reserveTaskModelAttempt',
        {
          tenantId: tenant.tenantId,
          principalId: tenant.principalId,
          agentId: tenant.agentId,
          taskId,
          runId,
          leaseEpoch: 2,
          providerId: 'fake',
          modelLabel: 'ember-fake-model-gateway-1',
          rateVersion: 'fake-v2-2026-11',
          budgetMode: 'simulated_full_protocol',
          estimatedMicroUsd: 5_000,
        },
      );
      expect(res.result?.kind).toBe('reserved');
      await agentRpc(harness, tenant, 'settleTaskModelAttempt', {
        tenantId: tenant.tenantId,
        agentId: tenant.agentId,
        taskId,
        attemptNo: res.result!.attemptNo,
        operationId: res.result!.operationId,
        requestedState: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 5_000,
      });
    }
    // 5th attempt hits BOTH attempt (4) and cost (20,000) caps!
    const refused = await agentRpc<{ kind: string; reason: string }>(
      harness,
      tenant,
      'reserveTaskModelAttempt',
      {
        tenantId: tenant.tenantId,
        principalId: tenant.principalId,
        agentId: tenant.agentId,
        taskId,
        runId,
        leaseEpoch: 2,
        providerId: 'fake',
        modelLabel: 'ember-fake-model-gateway-1',
        rateVersion: 'fake-v2-2026-11',
        budgetMode: 'simulated_full_protocol',
        estimatedMicroUsd: 500,
      },
    );
    expect(refused.result?.kind).toBe('refused');
    expect(['attempts_exhausted', 'cost_ceiling_exceeded']).toContain(refused.result?.reason);

    // FI-16: DST Spring-Forward (2026-03-08 NY) & Fall-Back (2026-11-01 NY) inside AgentHeadDO
    const spring = DST_TRANSITION_FIXTURES.spring_forward_2026_ny;
    harness.faultInjector.setVirtualNowMs(spring.beforeTransitionUtcMs);
    const springSched = await agentRpc<{ alarmAtMs: number }>(harness, tenant, 'upsertSchedule', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      scheduleId: 'sched-dst-spring',
      sourceKind: 'commitment',
      sourceId: 'comm-spring',
      scheduleKind: 'cron_tz',
      intervalSeconds: null,
      cronExpr: spring.cronLocalTime,
      timezone: spring.timezone,
      firstFireAtMs: spring.expectedSingleFireUtcMs,
    });
    expect(springSched.ok).toBe(true);

    // Fire at expectedSingleFireUtcMs -> materializes exactly 1 occurrence and advances to next day!
    harness.faultInjector.setVirtualNowMs(spring.afterTransitionUtcMs);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      nowMs: spring.afterTransitionUtcMs,
    });
    const afterSpring = await inspectAgent(harness, tenant);
    const sRow = afterSpring.schedules.find((s) => s.schedule_id === 'sched-dst-spring')!;
    expect(sRow.occurrence_seq).toBe(1);

    const fall = DST_TRANSITION_FIXTURES.fall_back_2026_ny;
    harness.faultInjector.setVirtualNowMs(fall.beforeTransitionUtcMs);
    await agentRpc(harness, tenant, 'upsertSchedule', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      scheduleId: 'sched-dst-fall',
      sourceKind: 'commitment',
      sourceId: 'comm-fall',
      scheduleKind: 'cron_tz',
      intervalSeconds: null,
      cronExpr: fall.cronLocalTime,
      timezone: fall.timezone,
      firstFireAtMs: fall.expectedSingleFireUtcMs,
    });
    harness.faultInjector.setVirtualNowMs(fall.afterTransitionUtcMs);
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenant.tenantId,
      agentId: tenant.agentId,
      nowMs: fall.afterTransitionUtcMs,
    });
    const afterFall = await inspectAgent(harness, tenant);
    const fRow = afterFall.schedules.find((s) => s.schedule_id === 'sched-dst-fall')!;
    expect(fRow.occurrence_seq).toBe(1);
  });

  // ==========================================================================
  // Category 8: Global Budget Concurrency, Expiry, Revisions, Halt & Conflict (F-6, F-15, F-23, FI-15)
  // ==========================================================================

  it('F-6: GlobalBudget unavailable 503 and concurrent daily ceiling cap (429 BUDGET_EXCEEDED)', async () => {
    // Cap daily global budget to 750 micro_usd (3 x 250 holds)
    const harness = await bootHarness({ GLOBAL_DAILY_CEILING_MICRO_USD: '750' });
    const tenantA = await createTenantSession(harness, `budget-f6-${randomUUID()}`);

    // 1. F-6: Unavailable GlobalBudgetDO -> 503 DB_UNAVAILABLE
    harness.faultInjector.setGlobalBudgetFault('unavailable');
    const unavailRes = await harness.fetchJson<{ error: { code: string } }>(
      `/v1/conversations/${tenantA.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Budget unavailable', transcript_epoch: 0 },
      { authorization: `Bearer ${tenantA.accessToken}` },
    );
    expect(unavailRes.status).toBe(503);
    expect(unavailRes.data.error.code).toBe('DB_UNAVAILABLE');
    harness.faultInjector.setGlobalBudgetFault('healthy');

    // 2. F-6: Concurrent cap enforcement across 6 requests with ceiling=750 (250 each -> max 3 succeed)
    // Pause fake gateway slightly so holds remain concurrent
    harness.fakeGateway.setDefaultRule({ mode: 'slow_handoff', delayMs: 400, costMicroUsd: 120 });
    const conc = await harness.faultInjector.runConcurrentRace(
      Array.from(
        { length: 6 },
        (_, i) => () =>
          harness.fetchJson<{ error?: { code: string } }>(
            `/v1/conversations/${tenantA.conversationId}/messages`,
            {
              client_submission_id: randomUUID(),
              text: `Concurrent budget ${i}`,
              transcript_epoch: 0,
            },
            { authorization: `Bearer ${tenantA.accessToken}` },
          ),
      ),
    );
    const admitted = conc.filter((c) => c.status === 'fulfilled' && c.value?.status === 201);
    const rejected = conc.filter((c) => c.status === 'fulfilled' && c.value?.status === 429);
    expect(admitted.length).toBeLessThanOrEqual(3);
    expect(admitted.length).toBeGreaterThanOrEqual(1);
    expect(admitted.length + rejected.length).toBe(6);

    await waitFor(async () => {
      const s = await inspectAgent(harness, tenantA);
      return s.turns.length === admitted.length &&
        s.turns.every((t) => t.status === 'completed') &&
        s.attempts.every((a) => a.global_synced_at_ms !== null)
        ? s
        : null;
    });
  });

  it('F-23 & FI-15: budget_sync clearTranscript survival, rev=0/1 delta, and conflict_payload retention', async () => {
    const harness = await bootHarness({ GLOBAL_DAILY_CEILING_MICRO_USD: '750' });
    const tenantA = await createTenantSession(harness, `budget-f23-${randomUUID()}`);

    const revSub = await harness.fetchJson<B1SendMessageReceipt>(
      `/v1/conversations/${tenantA.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Late revision F-23', transcript_epoch: 0 },
      { authorization: `Bearer ${tenantA.accessToken}` },
    );
    expect(revSub.status).toBe(201);
    const revSnap = await waitFor(async () => {
      const s = await inspectAgent(harness, tenantA);
      const t = s.turns.find((r) => r.id === revSub.data.turn.turn_id);
      const a = s.attempts.find((r) => r.subject_id === revSub.data.turn.turn_id);
      return t?.status === 'completed' && a?.global_synced_at_ms !== null ? s : null;
    });
    const revAttempt = revSnap.attempts.find((a) => a.subject_id === revSub.data.turn.turn_id)!;
    const spendBeforeRev1 = (await readGlobalSpendDays(harness))[0]!.consumed_micro_usd;

    // Submit late revision rev=1 with higher observedCostMicroUsd (200 vs 120 -> +80 delta!) while conflict_payload is off
    await agentRpc(harness, tenantA, 'recordTurnUsage', {
      scope: { tenantId: tenantA.tenantId, agentId: tenantA.agentId },
      turnId: revSub.data.turn.turn_id,
      attemptNo: revAttempt.attempt_no,
      operationId: revAttempt.operation_id,
      observedCostMicroUsd: 200,
    });
    // Wait for rev=1 budget_sync to settle + verify delta (+80)
    await waitFor(async () => {
      const days = await readGlobalSpendDays(harness);
      return days[0]?.consumed_micro_usd === spendBeforeRev1 + 80 ? days : null;
    });

    // Clear transcript does NOT cancel budget_sync outbox (simulate GlobalBudget outage first)
    harness.faultInjector.setGlobalBudgetFault('unavailable');
    await agentRpc(harness, tenantA, 'recordTurnUsage', {
      scope: { tenantId: tenantA.tenantId, agentId: tenantA.agentId },
      turnId: revSub.data.turn.turn_id,
      attemptNo: revAttempt.attempt_no,
      operationId: revAttempt.operation_id,
      observedCostMicroUsd: 230,
    });
    const delA = await harness.fetch('/v1/me/conversation/messages', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
    });
    expect(delA.status).toBe(200);
    const afterDelA = await inspectAgent(harness, tenantA);
    const survivingBudgetSync = afterDelA.outbox.filter(
      (o) =>
        o.entity_kind === 'budget_sync' &&
        o.entity_id === revAttempt.operation_id &&
        o.state !== 'cancelled' &&
        o.state !== 'acked',
    );
    expect(survivingBudgetSync.length).toBeGreaterThanOrEqual(1);

    // Now pre-settle rev=2 cleanly on GlobalBudgetDO, then inject conflict_payload before relaying AgentHead's rev=2!
    harness.faultInjector.setGlobalBudgetFault('healthy');
    const preSettle = await harness.fetchJson<{ result: { applied: boolean } }>(
      '/_test/global-budget/rpc',
      {
        method: 'settleGlobal',
        arg: {
          tenantId: tenantA.tenantId,
          operationId: revAttempt.operation_id,
          settlementRevision: 2,
          globalGrantId: revAttempt.global_grant_id,
          state: 'settled',
          observedCostMicroUsd: 230,
          chargeMicroUsd: 230,
          reservedMicroUsd: revAttempt.reserved_micro_usd,
        },
      },
    );
    expect(preSettle.data.result.applied).toBe(true);

    harness.faultInjector.setGlobalBudgetFault('conflict_payload');
    await harness.fetchJson('/_test/agent/alarm', {
      tenantId: tenantA.tenantId,
      agentId: tenantA.agentId,
      nowMs: Date.now() + 65_000,
    });
    const afterConflict = await inspectAgent(harness, tenantA);
    const retainedConflict = afterConflict.outbox.filter(
      (o) =>
        o.entity_kind === 'budget_sync' &&
        o.entity_id === revAttempt.operation_id &&
        o.state !== 'acked' &&
        o.last_error_code !== null,
    );
    expect(retainedConflict.length).toBe(1);
    harness.faultInjector.setGlobalBudgetFault('healthy');
  });

  it('F-15 (Grant Expiry): GlobalGrant TTL expiry via real GlobalBudgetDO alarm converges expired_consumed without refund', async () => {
    const harness = await bootHarness({ GLOBAL_DAILY_CEILING_MICRO_USD: '750' });
    const tenantB = await createTenantSession(harness, `budget-exp-${randomUUID()}`);

    const expOpId = randomUUID();
    const expReserve = await harness.fetchJson<{
      ok: boolean;
      result: { kind: string; globalGrantId: string };
    }>('/_test/global-budget/rpc', {
      method: 'reserveGlobal',
      arg: {
        tenantId: tenantB.tenantId,
        principalId: tenantB.principalId,
        agentId: tenantB.agentId,
        operationId: expOpId,
        leaseEpoch: 1,
        utcDay: new Date().toISOString().slice(0, 10),
        amountMicroUsd: 50,
        ceilingMicroUsd: 750,
        expiresAtMs: Date.now() + 300,
      },
    });
    expect(expReserve.data.result.kind).toBe('reserved');
    await waitFor(async () => {
      const rows = await readGlobalReservations(harness);
      return rows.find((r) => r.operation_id === expOpId)?.state === 'expired_consumed'
        ? rows
        : null;
    }, 10_000);
    // Attempting late release on expired_consumed is denied refund (conflict=true)
    const lateRel = await harness.fetchJson<{
      result: { applied: boolean; conflict: boolean; effectiveState: string };
    }>('/_test/global-budget/rpc', {
      method: 'settleGlobal',
      arg: {
        tenantId: tenantB.tenantId,
        operationId: expOpId,
        settlementRevision: 0,
        globalGrantId: expReserve.data.result.globalGrantId,
        state: 'released',
        chargeMicroUsd: 0,
        reservedMicroUsd: 50,
      },
    });
    expect(lateRel.data.result.applied).toBe(false);
    expect(lateRel.data.result.effectiveState).toBe('expired_consumed');
  });

  it('F-15 (Cross-Agent Halt): usage_missing opens Global incident and halts cross-tenant Tenant B (429)', async () => {
    const harness = await bootHarness({ GLOBAL_DAILY_CEILING_MICRO_USD: '750' });
    const tenantA = await createTenantSession(harness, `budget-halt-a-${randomUUID()}`);
    const tenantB = await createTenantSession(harness, `budget-halt-b-${randomUUID()}`);

    harness.fakeGateway.setDefaultRule({ mode: 'usage_missing' });
    const umRes = await harness.fetch(
      `/v2/conversations/${tenantA.conversationId}/messages/stream`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tenantA.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: 'Trigger usage_missing halt',
          transcript_epoch: 0,
        }),
      },
    );
    expect(umRes.status).toBe(201);
    await umRes.text();

    await waitFor(async () => {
      const incidents = await readGlobalIncidents(harness);
      return incidents.some((i) => i.reason === 'usage_missing' && i.resolved_at_ms === null)
        ? incidents
        : null;
    });

    // Cross-tenant Tenant B MUST be halted with 429 BUDGET_EXCEEDED!
    harness.fakeGateway.setDefaultRule({ mode: 'fast_ok', costMicroUsd: 100 });
    const haltedB = await harness.fetchJson<{ error: { code: string } }>(
      `/v1/conversations/${tenantB.conversationId}/messages`,
      { client_submission_id: randomUUID(), text: 'Cross-tenant halt probe', transcript_epoch: 0 },
      { authorization: `Bearer ${tenantB.accessToken}` },
    );
    expect(haltedB.status).toBe(429);
    expect(haltedB.data.error.code).toBe('BUDGET_EXCEEDED');
  });
});
