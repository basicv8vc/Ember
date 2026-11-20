import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { B1SessionResponseSchema } from '@ember/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2LocalRuntimeHarness } from '../../apps/benchmark/src/v2-m1/index.js';
import type {
  DeviceClaim,
  DeviceTaskSnapshot,
} from '../../packages/runtime-v2/src/contracts/device-execution.js';
import { SimulatedDeviceExecutor } from './support/simulated-device-executor.js';

const configPath = fileURLToPath(
  new URL('../../apps/api/wrangler.local-v2.jsonc', import.meta.url),
);
const poll = { timeout: 10_000, interval: 100 };
type Claim = Extract<DeviceClaim, { kind: 'claimed' }>;

async function json<T>(response: Response, expected: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expected);
  return JSON.parse(body) as T;
}

function success(claim: Claim, text: string) {
  return {
    operationId: claim.operationId,
    runId: claim.runId,
    leaseEpoch: claim.leaseEpoch,
    status: 'completed' as const,
    output: { text },
  };
}

describe('M2-F1 device execution in local workerd', () => {
  let harness: V2LocalRuntimeHarness;
  let stateDir: string;
  let token: string;
  let headId: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ember-m2-device-'));
    harness = await V2LocalRuntimeHarness.start({ target: { kind: 'ab_runtime', configPath } });
    token = await signIn();
    const ids = await harness.listDurableObjectIds('AGENT_HEAD');
    expect(ids).toHaveLength(1);
    headId = ids[0]!;
  });

  afterEach(async () => {
    await harness?.dispose();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  function fetchOverHttp(path: string, init: RequestInit) {
    return harness.fetchOverHttp(path, init);
  }

  async function signIn() {
    const response = await fetchOverHttp('/v1/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'dev', identity_token: randomUUID(), nonce: randomUUID() }),
    });
    return B1SessionResponseSchema.parse(await json(response, 201)).access_token;
  }

  function request(
    path: string,
    {
      body,
      method = body === undefined ? 'GET' : 'POST',
      session = token,
    }: { body?: Record<string, unknown>; method?: 'GET' | 'POST'; session?: string } = {},
  ) {
    return fetchOverHttp(path, {
      method,
      headers: {
        authorization: `Bearer ${session}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function device(name = 'iphone', session = token, id?: string) {
    return SimulatedDeviceExecutor.create(fetchOverHttp, session, join(stateDir, name), id);
  }

  async function claim(device: SimulatedDeviceExecutor): Promise<Claim> {
    const result = await json<DeviceClaim>(await device.claim(), 200);
    if (result.kind !== 'claimed') throw new Error('Expected a device task claim');
    return result;
  }

  async function dispatch(deviceId: string, text: string, deadlineMs?: number) {
    return json<DeviceTaskSnapshot>(
      await request('/v2/device-tasks', {
        body: {
          deviceId,
          operationId: randomUUID(),
          input: { text },
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
        },
      }),
      201,
    );
  }

  function status(taskId: string) {
    return request(`/v2/device-tasks/${taskId}`).then((r) => json<DeviceTaskSnapshot>(r, 200));
  }

  function rows(query: `SELECT ${string}`, id: string) {
    return harness.readDurableObjectRows('AGENT_HEAD', { id: headId }, query, id);
  }

  it('replays dispatch, claim and result across lost acknowledgments and device restart', async () => {
    const iphone = await device();
    const registration = await json<{ readyUntilMs: number }>(await iphone.register(), 200);
    expect(registration).toMatchObject({
      deviceId: iphone.id,
      capability: 'mock.compute',
      version: 1,
    });
    expect(registration.readyUntilMs).toBeGreaterThan(Date.now());
    expect(await json(await iphone.claim(), 200)).toEqual({ kind: 'idle' });

    const body = {
      deviceId: iphone.id,
      operationId: randomUUID(),
      input: { text: '  Native  text\n extraction\t demo  ' },
    };
    const [first, second] = await Promise.all([
      request('/v2/device-tasks', { body }),
      request('/v2/device-tasks', { body }),
    ]);
    const created = first.status === 201 ? first : second;
    const replay = first.status === 201 ? second : first;
    const task = await json<DeviceTaskSnapshot>(created, 201);
    expect(task).toMatchObject({ status: 'queued', availability: 'ready', result: null });
    expect(await json(replay, 200)).toMatchObject({ taskId: task.taskId, replayed: true });
    expect(
      (await request('/v2/device-tasks', { body: { ...body, input: { text: 'changed input' } } }))
        .status,
    ).toBe(409);

    const original = await claim(iphone);
    expect(original).toMatchObject({
      taskId: task.taskId,
      operationId: body.operationId,
      input: body.input,
      capability: 'mock.compute',
      version: 1,
    });
    expect(original.leaseExpiresAtMs).toBeLessThanOrEqual(original.deadlineAtMs);
    expect(await claim(iphone)).toEqual(original);
    await iphone.prepare(original);
    // Simulate a commit whose HTTP receipt is lost and a fresh process reopening the outbox.
    expect(await iphone.flush({ discardAcknowledgment: true })).toBeNull();
    await harness.evictDurableObject('AGENT_HEAD', { id: headId });
    expect(await status(task.taskId)).toMatchObject({
      status: 'completed',
      result: { text: 'Native text extraction demo' },
    });

    await setTimeout(Math.max(0, original.leaseExpiresAtMs - Date.now() + 25));
    expect(Date.now()).toBeGreaterThanOrEqual(original.leaseExpiresAtMs);
    const resumed = await SimulatedDeviceExecutor.reopen(
      fetchOverHttp,
      token,
      join(stateDir, 'iphone'),
    );
    expect(await resumed.flush()).toEqual({ kind: 'committed', replayed: true });
    await expect(resumed.flush()).rejects.toThrow('No pending result');
    expect(
      (await resumed.submitResult(task.taskId, success(original, 'conflicting result'))).status,
    ).toBe(409);
    expect(
      await rows(
        'SELECT status, execution_target, attempt_count FROM tasks WHERE id = ?',
        task.taskId,
      ),
    ).toEqual([{ status: 'completed', execution_target: 'device', attempt_count: 1 }]);
    expect(
      await rows(
        'SELECT status, executor_kind, lease_epoch FROM runs WHERE task_id = ?',
        task.taskId,
      ),
    ).toEqual([{ status: 'succeeded', executor_kind: 'device', lease_epoch: original.leaseEpoch }]);
  });

  it('recovers a lost lease without cloud execution and fences its stale result after reclaim', async () => {
    const iphone = await device();
    await json(await iphone.register(), 200);
    const task = await dispatch(iphone.id, 'reconnect and resume');
    const original = await claim(iphone);

    // No status or claim HTTP request drives the expiry. The existing alarm recovers it.
    await expect
      .poll(() => rows('SELECT status FROM runs WHERE id = ?', original.runId), poll)
      .toEqual([{ status: 'lease_expired' }]);

    await json(await iphone.register(), 200);
    const current = await claim(iphone);
    expect(current).toMatchObject({ taskId: task.taskId, operationId: original.operationId });
    expect(current.runId).not.toBe(original.runId);
    expect(current.leaseEpoch).toBeGreaterThan(original.leaseEpoch);
    expect(
      await json(await iphone.submitResult(task.taskId, success(original, 'late')), 409),
    ).toEqual({ kind: 'fenced' });
    await iphone.prepare(current);
    expect(await iphone.flush()).toEqual({ kind: 'committed', replayed: false });
    expect(await status(task.taskId)).toMatchObject({
      status: 'completed',
      result: { text: 'reconnect and resume' },
    });
    expect(
      await rows(
        'SELECT status, executor_kind FROM runs WHERE task_id = ? ORDER BY attempt',
        task.taskId,
      ),
    ).toEqual([
      { status: 'lease_expired', executor_kind: 'device' },
      { status: 'succeeded', executor_kind: 'device' },
    ]);
  });

  it('makes cancellation terminal and rejects a result from the cancelled run', async () => {
    const iphone = await device();
    await json(await iphone.register(), 200);
    const task = await dispatch(iphone.id, 'cancel me');
    const active = await claim(iphone);
    const cancelPath = `/v2/device-tasks/${task.taskId}/cancel`;
    const cancelled = await json<DeviceTaskSnapshot>(
      await request(cancelPath, { method: 'POST' }),
      200,
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', reason: 'cancelled', result: null });
    expect(await json(await request(cancelPath, { method: 'POST' }), 200)).toMatchObject({
      status: 'cancelled',
    });
    expect(
      await json(await iphone.submitResult(task.taskId, success(active, 'late')), 409),
    ).toEqual({ kind: 'fenced' });
    expect(await json(await iphone.claim(), 200)).toEqual({ kind: 'idle' });
    expect(await rows('SELECT status FROM runs WHERE id = ?', active.runId)).toEqual([
      { status: 'cancelled' },
    ]);
  });

  it('reports unavailable devices and handles reconnect or a deadline with no cloud fallback', async () => {
    const iphone = await device();
    const waiting = await dispatch(iphone.id, 'run once connected');
    expect(waiting).toMatchObject({
      status: 'queued',
      availability: 'device_unavailable',
      reason: 'device_unavailable',
      result: null,
    });
    expect(await status(waiting.taskId)).toMatchObject({
      taskId: waiting.taskId,
      status: 'queued',
      availability: 'device_unavailable',
      reason: 'device_unavailable',
    });
    expect(await rows('SELECT status FROM runs WHERE task_id = ?', waiting.taskId)).toEqual([]);

    const d1 = await harness.getD1Database();
    if (d1 === null) throw new Error('Expected local D1 recovery registry');
    const coverage = await d1
      .prepare('SELECT generation, next_recovery_at_ms, status FROM v2_recovery_registry')
      .all<{ generation: number; next_recovery_at_ms: number; status: string }>();
    expect(coverage.results).toHaveLength(1);
    const covered = coverage.results![0]!;
    expect(covered.status).toBe('armed');
    expect(covered.generation).toBeGreaterThan(0);
    expect(covered.next_recovery_at_ms).toBeGreaterThan(Date.now());

    await json(await iphone.register(), 200);
    const offer = await claim(iphone);
    expect(offer.taskId).toBe(waiting.taskId);
    await iphone.prepare(offer);
    expect(await iphone.flush()).toEqual({ kind: 'committed', replayed: false });

    const neverConnected = await dispatch(randomUUID(), 'device stays offline', 500);
    expect(neverConnected).toMatchObject({ status: 'queued', availability: 'device_unavailable' });
    await expect
      .poll(() => rows('SELECT status FROM tasks WHERE id = ?', neverConnected.taskId), poll)
      .toEqual([{ status: 'failed' }]);
    expect(await status(neverConnected.taskId)).toMatchObject({
      status: 'failed',
      availability: 'device_unavailable',
      reason: 'deadline_exceeded',
      result: null,
    });
    expect(await rows('SELECT status FROM runs WHERE task_id = ?', neverConnected.taskId)).toEqual(
      [],
    );
    expect(harness.fakeGateway.getAuditSnapshot().totalCalls).toBe(0);
  });

  it(
    'expires a registration heartbeat and surfaces executor failure after it reconnects',
    { timeout: 45_000 },
    async () => {
      const iphone = await device();
      const registration = await json<{ readyUntilMs: number }>(await iphone.register(), 200);
      const task = await dispatch(iphone.id, '\n\t ');
      expect(task).toMatchObject({ status: 'queued', availability: 'ready' });

      await setTimeout(Math.max(0, registration.readyUntilMs - Date.now() + 25));
      expect(await status(task.taskId)).toMatchObject({
        status: 'queued',
        availability: 'device_unavailable',
        reason: 'device_unavailable',
      });
      expect(await json(await iphone.claim(), 200)).toEqual({ kind: 'idle' });
      await json(await iphone.register(), 200);
      expect(await status(task.taskId)).toMatchObject({ status: 'queued', availability: 'ready' });
      const active = await claim(iphone);
      await iphone.prepare(active);
      expect(await iphone.flush()).toEqual({ kind: 'committed', replayed: false });
      expect(await status(task.taskId)).toMatchObject({
        status: 'failed',
        reason: 'executor_failed',
        result: null,
      });
      expect(await rows('SELECT status FROM runs WHERE id = ?', active.runId)).toEqual([
        { status: 'failed_terminal' },
      ]);
    },
  );

  it('scopes authenticated devices to their account and rejects a revoked credential', async () => {
    const iphone = await device();
    await json(await iphone.register(), 200);
    const task = await dispatch(iphone.id, 'account scoped input');
    const active = await claim(iphone);

    const impostor = await device('impostor', token, iphone.id);
    expect((await impostor.register()).status).toBe(403);
    expect((await impostor.claim()).status).toBe(403);
    expect((await impostor.submitResult(task.taskId, success(active, 'forged'))).status).toBe(403);

    const sameAccount = await device('same-account');
    await json(await sameAccount.register(), 200);
    expect(await json(await sameAccount.claim(), 200)).toEqual({ kind: 'idle' });
    expect(
      (await sameAccount.submitResult(task.taskId, success(active, 'wrong device'))).status,
    ).toBe(404);

    const otherToken = await signIn();
    const otherAccount = await device('other-account', otherToken, iphone.id);
    await json(await otherAccount.register(), 200);
    expect(await json(await otherAccount.claim(), 200)).toEqual({ kind: 'idle' });
    expect((await request(`/v2/device-tasks/${task.taskId}`, { session: otherToken })).status).toBe(
      404,
    );

    expect(
      await json(await request(`/v2/devices/${iphone.id}/revoke`, { method: 'POST' }), 200),
    ).toEqual({
      status: 'revoked',
    });
    expect((await iphone.register()).status).toBe(403);
    expect((await iphone.claim()).status).toBe(403);
    expect((await iphone.submitResult(task.taskId, success(active, 'revoked'))).status).toBe(403);
    expect(await status(task.taskId)).toMatchObject({
      availability: 'device_unavailable',
      result: null,
    });
  });
});
