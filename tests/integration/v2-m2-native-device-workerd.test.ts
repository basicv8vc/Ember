import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { B1SessionResponseSchema } from '@ember/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V2LocalRuntimeHarness } from '../../apps/benchmark/src/v2-m1/index.js';
import {
  DEVICE_TEXT_CAPABILITY,
  type DeviceClaim,
  type DeviceTaskSnapshot,
} from '../../packages/runtime-v2/src/contracts/device-execution.js';

const configPath = fileURLToPath(
  new URL('../../apps/api/wrangler.local-v2.jsonc', import.meta.url),
);
type Claim = Extract<DeviceClaim, { kind: 'claimed' }>;

async function json<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

function fence(claim: Claim) {
  return {
    operationId: claim.operationId,
    runId: claim.runId,
    leaseEpoch: claim.leaseEpoch,
  };
}

describe('M2-F2 native device wire and lease authority in local workerd', () => {
  let harness: V2LocalRuntimeHarness;
  let token: string;
  let headId: string;

  beforeAll(async () => {
    harness = await V2LocalRuntimeHarness.start({ target: { kind: 'ab_runtime', configPath } });
    const response = await harness.fetchOverHttp('/v1/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'dev', identity_token: randomUUID(), nonce: randomUUID() }),
    });
    token = B1SessionResponseSchema.parse(await json(response, 201)).access_token;
    const ids = await harness.listDurableObjectIds('AGENT_HEAD');
    expect(ids).toHaveLength(1);
    headId = ids[0]!;
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  function rpc(path: string, method: 'GET' | 'POST', body?: unknown, deviceToken?: string) {
    return harness.fetchOverHttp(path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(deviceToken === undefined ? {} : { 'x-device-token': deviceToken }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function device() {
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const request = (path: string, body: unknown) =>
      rpc('/v2/devices/' + id + path, 'POST', body, secret);
    return { id, request };
  }

  function dispatch(deviceId: string, deadlineMs: number, text = '𝄞\r\ne\u0301\n') {
    return {
      deviceId,
      operationId: randomUUID(),
      deadlineMs,
      capability: DEVICE_TEXT_CAPABILITY,
      version: 1,
      input: { operation: 'stats', text },
    };
  }

  async function claim(executor: ReturnType<typeof device>): Promise<Claim> {
    const offer = await json<DeviceClaim>(await executor.request('/claim', {}), 200);
    if (offer.kind !== 'claimed') throw new Error('Expected native lease');
    return offer;
  }

  function taskRoute(taskId: string) {
    return '/v2/device-tasks/' + taskId;
  }

  it('binds native input, placement and output to a versioned capability', async () => {
    const mock = device();
    await json(await mock.request('/register', { capability: 'mock.compute', version: 1 }), 200);
    await json(
      await mock.request('/register', { capability: DEVICE_TEXT_CAPABILITY, version: 1 }),
      409,
    );
    const mismatch = await json<DeviceTaskSnapshot>(
      await rpc('/v2/device-tasks', 'POST', dispatch(mock.id, 10_000)),
      201,
    );
    expect(mismatch).toMatchObject({ status: 'queued', reason: 'device_unavailable' });
    expect(await json(await mock.request('/claim', {}), 200)).toEqual({ kind: 'idle' });
    await json(await rpc(taskRoute(mismatch.taskId) + '/cancel', 'POST'), 200);

    const native = device();
    await json(
      await native.request('/register', { capability: DEVICE_TEXT_CAPABILITY, version: 1 }),
      200,
    );
    const command = dispatch(native.id, 90_000);
    await json(
      await rpc('/v2/device-tasks', 'POST', {
        ...command,
        input: { operation: 'uppercase', text: command.input.text },
      }),
      400,
    );
    const task = await json<DeviceTaskSnapshot>(
      await rpc('/v2/device-tasks', 'POST', command),
      201,
    );
    expect(await json(await rpc('/v2/device-tasks', 'POST', command), 200)).toMatchObject({
      taskId: task.taskId,
      replayed: true,
    });

    const offer = await claim(native);
    expect(offer).toMatchObject({
      capability: DEVICE_TEXT_CAPABILITY,
      version: 1,
      input: command.input,
    });
    expect(offer.leaseExpiresAtMs - Date.now()).toBeGreaterThan(28_000);
    const resultPath = '/tasks/' + task.taskId + '/result';
    const result = { ...fence(offer), status: 'completed' };
    await json(
      await native.request(resultPath, { ...result, output: { text: 'legacy output' } }),
      400,
    );
    const stats = { utf8Bytes: 10, unicodeScalars: 6, lines: 3 };
    expect(await json(await native.request(resultPath, { ...result, output: stats }), 200)).toEqual(
      { kind: 'committed', replayed: false },
    );
    expect(
      await json(
        await native.request(resultPath, {
          ...result,
          output: { lines: 3, unicodeScalars: 6, utf8Bytes: 10 },
        }),
        200,
      ),
    ).toEqual({ kind: 'committed', replayed: true });
    await json(
      await native.request(resultPath, { ...result, output: { ...stats, lines: 2 } }),
      409,
    );
    expect(await json(await rpc(taskRoute(task.taskId), 'GET'), 200)).toMatchObject({
      status: 'completed',
      result: stats,
    });
    expect(
      await harness.readDurableObjectRows(
        'AGENT_HEAD',
        { id: headId },
        'SELECT model_label, simulated FROM task_results WHERE task_id = ?',
        task.taskId,
      ),
    ).toEqual([{ model_label: DEVICE_TEXT_CAPABILITY, simulated: 0 }]);
  });

  it('renews both authoritative lease rows without advancing the epoch, then fences cancellation', async () => {
    const native = device();
    await json(
      await native.request('/register', { capability: DEVICE_TEXT_CAPABILITY, version: 1 }),
      200,
    );
    const task = await json<DeviceTaskSnapshot>(
      await rpc('/v2/device-tasks', 'POST', dispatch(native.id, 90_000)),
      201,
    );
    const offer = await claim(native);
    const renewPath = '/tasks/' + task.taskId + '/renew';
    expect(
      await json(
        await native.request(renewPath, {
          ...fence(offer),
          leaseEpoch: offer.leaseEpoch + 1,
        }),
        409,
      ),
    ).toEqual({ kind: 'fenced' });
    await setTimeout(30);
    const renewed = await json<{ kind: string; leaseExpiresAtMs: number }>(
      await native.request(renewPath, fence(offer)),
      200,
    );
    expect(renewed.kind).toBe('renewed');
    expect(renewed.leaseExpiresAtMs).toBeGreaterThan(offer.leaseExpiresAtMs);
    expect(renewed.leaseExpiresAtMs).toBeLessThan(offer.deadlineAtMs);
    expect(await claim(native)).toEqual({ ...offer, leaseExpiresAtMs: renewed.leaseExpiresAtMs });
    expect(
      await harness.readDurableObjectRows(
        'AGENT_HEAD',
        { id: headId },
        `SELECT t.lease_epoch AS lease_epoch, t.lease_expires_at_ms AS task_expiry, r.leased_until_ms AS run_expiry
        FROM tasks t JOIN runs r ON r.id = t.current_run_id WHERE t.id = ?`,
        task.taskId,
      ),
    ).toEqual([
      {
        lease_epoch: offer.leaseEpoch,
        task_expiry: renewed.leaseExpiresAtMs,
        run_expiry: renewed.leaseExpiresAtMs,
      },
    ]);
    await json(await rpc(taskRoute(task.taskId) + '/cancel', 'POST'), 200);
    expect(await json(await native.request(renewPath, fence(offer)), 409)).toEqual({
      kind: 'fenced',
    });
    expect(
      await json(
        await native.request('/tasks/' + task.taskId + '/result', {
          ...fence(offer),
          status: 'failed',
        }),
        409,
      ),
    ).toEqual({ kind: 'fenced' });
  });

  it('caps renewal at the deadline and rejects a late renewal and result', async () => {
    const native = device();
    await json(
      await native.request('/register', { capability: DEVICE_TEXT_CAPABILITY, version: 1 }),
      200,
    );
    const task = await json<DeviceTaskSnapshot>(
      await rpc('/v2/device-tasks', 'POST', dispatch(native.id, 1_500)),
      201,
    );
    const offer = await claim(native);
    const renewPath = '/tasks/' + task.taskId + '/renew';
    expect(await json(await native.request(renewPath, fence(offer)), 200)).toEqual({
      kind: 'renewed',
      leaseExpiresAtMs: offer.deadlineAtMs,
    });
    await setTimeout(Math.max(0, offer.deadlineAtMs - Date.now() + 25));
    expect(await json(await native.request(renewPath, fence(offer)), 409)).toEqual({
      kind: 'fenced',
    });
    expect(
      await json(
        await native.request('/tasks/' + task.taskId + '/result', {
          ...fence(offer),
          status: 'failed',
        }),
        409,
      ),
    ).toEqual({ kind: 'fenced' });
    expect(await json(await rpc(taskRoute(task.taskId), 'GET'), 200)).toMatchObject({
      status: 'failed',
      reason: 'deadline_exceeded',
      result: null,
    });
  });

  it('recovers a native lease after 30 seconds without the executor', async () => {
    const native = device();
    const registration = { capability: DEVICE_TEXT_CAPABILITY, version: 1 };
    await json(await native.request('/register', registration), 200);
    const task = await json<DeviceTaskSnapshot>(
      await rpc('/v2/device-tasks', 'POST', dispatch(native.id, 90_000)),
      201,
    );
    const old = await claim(native);
    await expect
      .poll(
        () =>
          harness.readDurableObjectRows(
            'AGENT_HEAD',
            { id: headId },
            'SELECT status FROM runs WHERE id = ?',
            old.runId,
          ),
        { timeout: 34_000, interval: 500 },
      )
      .toEqual([{ status: 'lease_expired' }]);
    const waiting = await json<DeviceTaskSnapshot>(await rpc(taskRoute(task.taskId), 'GET'), 200);
    expect(waiting).toMatchObject({ status: 'queued', availability: 'device_unavailable' });
    await json(await native.request('/register', registration), 200);
    const current = await claim(native);
    expect(current.taskId).toBe(task.taskId);
    expect(current.runId).not.toBe(old.runId);
    expect(current.leaseEpoch).toBeGreaterThan(old.leaseEpoch);
    expect(
      await json(await native.request('/tasks/' + task.taskId + '/renew', fence(old)), 409),
    ).toEqual({ kind: 'fenced' });
    expect(
      await json(
        await native.request('/tasks/' + task.taskId + '/result', {
          ...fence(old),
          status: 'failed',
        }),
        409,
      ),
    ).toEqual({ kind: 'fenced' });
    await json(
      await native.request('/tasks/' + task.taskId + '/result', {
        ...fence(current),
        status: 'completed',
        output: { utf8Bytes: 10, unicodeScalars: 6, lines: 3 },
      }),
      200,
    );
  }, 40_000);
});
