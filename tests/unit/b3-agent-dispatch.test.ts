import { describe, expect, it, vi } from 'vitest';
import type { B3TaskDispatchEvent } from '@ember/postgres/b3-worker';
import {
  AGENT_TASK_DLQ_NAME,
  AGENT_TASK_QUEUE_NAME,
  agentTaskEnvelope,
  consumeAgentDispatchMessage,
  recoverAgentDeadLetter,
  type AgentTaskOutboxPort,
} from '../../apps/cloud-async-runtime/src/agent-dispatch.js';
import {
  publishDueAgentDispatches,
  type AgentDispatchRelayOutboxPort,
} from '../../apps/cloud-async-runtime/src/relay.js';
import cloudAsyncRuntime from '../../apps/cloud-async-runtime/src/index.js';
import type { TurnDispatchQueueMessage } from '../../apps/cloud-async-runtime/src/dispatch.js';

const TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849310';
const TASK_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849311';

function makeEvent(overrides: Partial<B3TaskDispatchEvent> = {}): B3TaskDispatchEvent {
  return {
    schemaVersion: 1,
    eventId: TASK_ID,
    taskId: TASK_ID,
    tenantId: TENANT_ID,
    kind: 'python.agent',
    status: 'queued',
    deadlineAt: '2026-11-16T00:10:00.000Z',
    nextRunAt: null,
    leaseRemainingMs: 0,
    ...overrides,
  };
}

class QueueMsg implements TurnDispatchQueueMessage {
  readonly attempts = 1;
  ack = vi.fn();
  retry = vi.fn();
  constructor(
    readonly body: unknown = agentTaskEnvelope({ tenantId: TENANT_ID, taskId: TASK_ID }),
  ) {}
}

class MemoryAgentOutbox implements AgentTaskOutboxPort {
  current: B3TaskDispatchEvent | null;
  readonly deferNextDispatch = vi.fn(() => Promise.resolve(true));
  readonly markCompleted = vi.fn(() => Promise.resolve(true));
  readonly makeDue = vi.fn(() => Promise.resolve(true));
  readonly getEvent = vi.fn(() => Promise.resolve(this.current));

  constructor(initial: B3TaskDispatchEvent | null = makeEvent()) {
    this.current = initial;
  }
}

describe('Cloud Async Runtime agent dispatch & relay', () => {
  it('routes agent task queue and DLQ envelopes cleanly while ACKing invalid payloads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      HYPERDRIVE: { connectionString: 'postgresql://127.0.0.1/unused' },
      TURN_DISPATCH_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
      AGENT_TASK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
      EMBER_AGENT_TASK_QUEUE_NAME: 'ember-staging-agent-tasks',
      EMBER_AGENT_TASK_DLQ_NAME: 'ember-staging-agent-tasks-dlq',
      EMBER_ENV: 'staging',
      EMBER_MODEL_EXECUTION: 'disabled',
    };

    try {
      const badMsg = new QueueMsg({ bogus: true });
      await cloudAsyncRuntime.queue(
        { queue: 'ember-staging-agent-tasks', messages: [badMsg] },
        env,
      );
      expect(badMsg.ack).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'discarded malformed Agent Task dispatch envelope',
        expect.objectContaining({ category: 'invalid_envelope' }),
      );

      const badDlq = new QueueMsg(null);
      await cloudAsyncRuntime.queue(
        { queue: 'ember-staging-agent-tasks-dlq', messages: [badDlq] },
        env,
      );
      expect(badDlq.ack).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'discarded malformed Agent Task DLQ envelope',
        expect.objectContaining({ category: 'invalid_envelope' }),
      );

      expect(AGENT_TASK_QUEUE_NAME).toBe('ember-agent-tasks');
      expect(AGENT_TASK_DLQ_NAME).toBe('ember-agent-tasks-dlq');
    } finally {
      warn.mockRestore();
    }
  });

  it('defers execution when running lease is active or retryable_failed backoff has not elapsed', async () => {
    const nowMs = Date.parse('2026-11-16T00:00:00.000Z');
    const runningOutbox = new MemoryAgentOutbox(
      makeEvent({ status: 'running', leaseRemainingMs: 12_000 }),
    );
    const runningMsg = new QueueMsg();
    const processTask = vi.fn();

    await consumeAgentDispatchMessage(runningMsg, {
      outbox: runningOutbox,
      executor: { processTask },
      now: () => nowMs,
    });
    expect(processTask).not.toHaveBeenCalled();
    expect(runningMsg.retry).toHaveBeenCalledWith({
      delaySeconds: expect.any(Number) as number,
    });

    const backoffOutbox = new MemoryAgentOutbox(
      makeEvent({ status: 'retryable_failed', nextRunAt: '2026-11-16T00:00:45.000Z' }),
    );
    const backoffMsg = new QueueMsg();
    await consumeAgentDispatchMessage(backoffMsg, {
      outbox: backoffOutbox,
      executor: { processTask },
      now: () => nowMs,
    });
    expect(processTask).not.toHaveBeenCalled();
    expect(backoffMsg.retry).toHaveBeenCalledWith({ delaySeconds: 45 });
  });

  it('runs executor for queued tasks, marks outbox completed on terminal outcomes, and retries on failed_retryable', async () => {
    const okOutbox = new MemoryAgentOutbox(makeEvent({ status: 'queued' }));
    const okMsg = new QueueMsg();
    await consumeAgentDispatchMessage(okMsg, {
      outbox: okOutbox,
      executor: {
        processTask: () => Promise.resolve({ outcome: 'succeeded' }),
      },
    });
    expect(okOutbox.markCompleted).toHaveBeenCalledWith(TASK_ID);
    expect(okMsg.ack).toHaveBeenCalledTimes(1);

    const retryOutbox = new MemoryAgentOutbox(makeEvent({ status: 'queued' }));
    const retryMsg = new QueueMsg();
    await consumeAgentDispatchMessage(retryMsg, {
      outbox: retryOutbox,
      executor: {
        processTask: () => {
          retryOutbox.current = makeEvent({
            status: 'retryable_failed',
            nextRunAt: new Date(Date.now() + 20_000).toISOString(),
          });
          return Promise.resolve({ outcome: 'failed_retryable' });
        },
      },
    });
    expect(retryOutbox.markCompleted).not.toHaveBeenCalled();
    expect(retryMsg.ack).not.toHaveBeenCalled();
    expect(retryMsg.retry).toHaveBeenCalledTimes(1);
  });

  it('returns runnable Agent Task DLQ messages to PostgreSQL outbox and publishes due agent dispatches', async () => {
    const dlqOutbox = new MemoryAgentOutbox(makeEvent({ status: 'queued' }));
    const dlqMsg = new QueueMsg();
    const logger = { warn: vi.fn() };
    await recoverAgentDeadLetter(dlqMsg, dlqOutbox, logger);
    expect(dlqOutbox.makeDue).toHaveBeenCalledTimes(1);
    expect(dlqMsg.ack).toHaveBeenCalledTimes(1);

    const relayOutbox: AgentDispatchRelayOutboxPort = {
      claimDue: vi.fn(() => Promise.resolve([makeEvent()])),
      markEnqueued: vi.fn(() => Promise.resolve(true)),
      release: vi.fn(() => Promise.resolve(true)),
    };
    const queue = { send: vi.fn(() => Promise.resolve()) };

    const result = await publishDueAgentDispatches({
      outbox: relayOutbox,
      queue,
      workerId: 'relay-worker-1',
    });

    expect(result).toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect(queue.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      eventId: TASK_ID,
      tenantId: TENANT_ID,
      taskId: TASK_ID,
    });
  });
});
