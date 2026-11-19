import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { LoopbackFakeModelGateway, type FakeConversationStreamRequest } from '@ember/model-gateway';
import { FakeModelGatewayServer } from '../../apps/benchmark/src/v2-m1/fake-model-gateway-server.js';

function newRequest(deadlineAtMs: number): FakeConversationStreamRequest {
  return {
    operationId: crypto.randomUUID(),
    deadlineAtMs,
    input: {
      turnId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      context: [{ role: 'user', text: 'local provider probe' }],
      maxOutputTokens: 32,
    },
  };
}

describe('V2 Edge and Durable loopback provider protocol', () => {
  it('recovers the original provider job after HTTP abort and keeps receipts after the publish deadline', async () => {
    const server = new FakeModelGatewayServer();
    const controller = new AbortController();
    try {
      const origin = await server.start();
      const edgeGateway = new LoopbackFakeModelGateway(origin);
      server.enqueueRules({ mode: 'slow_handoff', delayMs: 150, costMicroUsd: 400 });
      const request = newRequest(Date.now() + 1_500);
      const stream = edgeGateway.streamConversationTurn(request, controller.signal);
      const first = await stream.next();
      if (first.done || first.value.kind !== 'job') throw new Error('expected a job handle');
      const { handle } = first.value;
      controller.abort();
      await stream.return();

      const durableGateway = new LoopbackFakeModelGateway(origin);
      const signal = new AbortController().signal;
      expect(
        await durableGateway.queryConversationJob(crypto.randomUUID(), handle, signal),
      ).toEqual({
        state: 'unavailable',
      });
      await expect
        .poll(() => durableGateway.queryConversationJob(request.operationId, handle, signal))
        .toMatchObject({
          state: 'completed',
          result: { usage: { costMicroUsd: 400 } },
        });
      await delay(Math.max(0, request.deadlineAtMs - Date.now()));
      expect(
        await durableGateway.queryConversationJob(request.operationId, handle, signal),
      ).toEqual({
        state: 'unavailable',
      });
      expect(
        await durableGateway.queryConversationUsage(request.operationId, signal),
      ).toMatchObject({
        state: 'completed',
        usage: { costMicroUsd: 400 },
      });
      expect(server.getAuditSnapshot()).toMatchObject({
        totalCalls: 1,
        uniqueOperationIds: [request.operationId],
        abortedCalls: 1,
      });
    } finally {
      controller.abort();
      await server.stop();
    }
  });

  it('reads missing usage and a cumulative late revision from the same provider process', async () => {
    const server = new FakeModelGatewayServer();
    try {
      const gateway = new LoopbackFakeModelGateway(await server.start());
      const signal = new AbortController().signal;
      server.enqueueRules(
        { mode: 'late_charge_revision', costMicroUsd: 120, lateRevisionCostMicroUsd: 400 },
        { mode: 'usage_missing' },
      );
      const original = newRequest(Date.now() + 5_000);
      const missing = newRequest(Date.now() + 5_000);
      for (const request of [original, missing]) {
        let completed = false;
        for await (const frame of gateway.streamConversationTurn(request, signal)) {
          if (frame.kind === 'result') {
            completed = true;
            expect(frame.result.usage?.costMicroUsd ?? null).toEqual(
              request === original ? 120 : null,
            );
          }
        }
        expect(completed).toBe(true);
      }
      expect(await gateway.queryConversationUsage(missing.operationId, signal)).toEqual({
        state: 'completed',
        usage: null,
      });
      const revision = {
        operationId: original.operationId,
        settlementRevision: 1,
        cumulativeChargeMicroUsd: 400,
      };
      expect(await gateway.queryUsageRevision(original.operationId, signal)).toEqual(revision);
      expect(await gateway.queryUsageRevision(original.operationId, signal)).toEqual(revision);
      expect(server.getAuditSnapshot().totalCalls).toBe(2);
    } finally {
      await server.stop();
    }
  });
});
