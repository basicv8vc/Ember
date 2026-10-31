import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2eCluster } from './support/e2e-cluster.js';

describe('B-T18 E2E SSE Disconnect & Reconnect', () => {
  let cluster: E2eCluster;
  let agentId: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start({
      // 50ms per step gives time to test disconnect and reconnect
      sandboxExecDurationMs: 25,
    });

    const res = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'E2E-SSE-Agent' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    agentId = body.agent_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('delivers events in monotonic order and re靜plays missed events after client disconnect', async () => {
    // 1. Submit task
    const taskRes = await cluster.fetch('/v1/tasks', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: {
        agent_id: agentId,
        kind: 'mock.chat',
        input: {
          prompt: 'Testing SSE reconnect and event cursor',
          maxOutputTokens: 64,
        },
      },
    });
    expect(taskRes.status).toBe(202);
    const receipt = (await taskRes.json()) as { task_id: string };

    // 2. Connect to SSE stream and disconnect after receiving the first event
    const abort1 = new AbortController();
    const firstEvents = await cluster.readSseEvents(receipt.task_id, cluster.tenantA.token, {
      maxEvents: 1,
      signal: abort1.signal,
    });
    expect(firstEvents.length).toBe(1);
    const firstEvent = firstEvents[0];
    expect(firstEvent).toBeDefined();
    if (!firstEvent) throw new Error('First event expected');
    expect(typeof firstEvent.id).toBe('string');
    const firstSeq = Number(firstEvent.id);
    expect(firstSeq).toBe(1);

    // 3. Await task completion while client was disconnected
    await cluster.waitForTask(receipt.task_id, 'completed', cluster.tenantA.token);

    // 4. Reconnect with Last-Event-ID header set to the first event's id
    const reconnectedEvents = await cluster.readSseEvents(receipt.task_id, cluster.tenantA.token, {
      lastEventId: String(firstSeq),
    });

    // Reconnected stream should backfill all subsequent events starting at firstSeq + 1
    expect(reconnectedEvents.length).toBeGreaterThanOrEqual(2);
    const sequences = reconnectedEvents.map((e) => Number(e.id));

    // Verify monotonic ordering with no duplicates of the first event
    expect(sequences[0]).toBe(firstSeq + 1);
    for (let i = 1; i < sequences.length; i++) {
      const curr = sequences[i];
      const prev = sequences[i - 1];
      expect(curr).toBeDefined();
      expect(prev).toBeDefined();
      if (curr !== undefined && prev !== undefined) {
        expect(curr).toBe(prev + 1);
      }
    }

    // Terminal event in reconnected stream must be completed
    const finalEvent = reconnectedEvents[reconnectedEvents.length - 1];
    expect(finalEvent).toBeDefined();
    if (!finalEvent) throw new Error('Final event expected');
    expect(finalEvent.data.phase).toBe('completed');
  });
});
