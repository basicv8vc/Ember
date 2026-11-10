import { describe, expect, it, vi } from 'vitest';
import type { B1TurnDispatchEvent } from '../../packages/postgres/src/repositories/b1-turn-dispatch-outbox.js';
import { resolveCloudRuntimeModelConfig } from '../../apps/cloud-async-runtime/src/config.js';
import {
  consumeTurnDispatchMessage,
  parseB1TurnDispatchEnvelope,
  recoverDeadLetter,
  type TurnDispatchOutboxPort,
  type TurnDispatchQueueMessage,
} from '../../apps/cloud-async-runtime/src/dispatch.js';
import { publishDueTurnDispatches } from '../../apps/cloud-async-runtime/src/relay.js';

const TURN_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849302';
const TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849303';
const CONVERSATION_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849304';

function event(overrides: Partial<B1TurnDispatchEvent> = {}): B1TurnDispatchEvent {
  return {
    schemaVersion: 1,
    eventId: TURN_ID,
    turnId: TURN_ID,
    tenantId: TENANT_ID,
    conversationId: CONVERSATION_ID,
    status: 'running',
    deadlineAt: '2026-11-10T00:01:00.000Z',
    leaseExpiresAt: null,
    leaseRemainingMs: 0,
    ...overrides,
  };
}

function envelope() {
  return {
    schemaVersion: 1,
    eventId: TURN_ID,
    tenantId: TENANT_ID,
    turnId: TURN_ID,
  };
}

class Message implements TurnDispatchQueueMessage {
  readonly attempts = 1;
  ack = vi.fn();
  retry = vi.fn();

  constructor(readonly body: unknown = envelope()) {}
}

class MemoryOutbox implements TurnDispatchOutboxPort {
  current: B1TurnDispatchEvent | null;
  readonly deferred = vi.fn(() => Promise.resolve(true));
  readonly completed = vi.fn(() => Promise.resolve(true));
  readonly due = vi.fn(() => Promise.resolve(true));

  constructor(initial: B1TurnDispatchEvent | null = event()) {
    this.current = initial;
  }

  getEvent = vi.fn((_eventId: string) => Promise.resolve(this.current));

  deferNextDispatch = this.deferred;
  markCompleted = this.completed;
  makeDue = this.due;
}

describe('Cloud Async Runtime dispatch', () => {
  it('parses only the closed, prompt-free Queue envelope', () => {
    expect(parseB1TurnDispatchEnvelope(envelope())).toMatchObject({ eventId: TURN_ID });
    expect(parseB1TurnDispatchEnvelope({ ...envelope(), text: 'private transcript' })).toBeNull();
    expect(parseB1TurnDispatchEnvelope({ ...envelope(), tenantId: CONVERSATION_ID })).toMatchObject(
      {
        tenantId: CONVERSATION_ID,
      },
    );
    expect(parseB1TurnDispatchEnvelope({ ...envelope(), eventId: CONVERSATION_ID })).toBeNull();
  });

  it('keeps model disabled by default and refuses Fake Model in a shared environment', () => {
    expect(
      resolveCloudRuntimeModelConfig({ EMBER_ENV: 'staging', EMBER_MODEL_EXECUTION: 'fake' }),
    ).toEqual({
      kind: 'refused',
      reason: 'simulated_execution_in_shared_environment',
    });
    expect(resolveCloudRuntimeModelConfig({ EMBER_ENV: 'production' })).toEqual({
      kind: 'disabled',
    });
    expect(
      resolveCloudRuntimeModelConfig({ EMBER_ENV: 'test', EMBER_MODEL_EXECUTION: 'fake' }),
    ).toMatchObject({
      kind: 'enabled',
      mode: 'fake',
    });
  });

  it('executes a running Turn once, marks the outbox complete, and deduplicates redelivery', async () => {
    const outbox = new MemoryOutbox();
    const executor = {
      expireTurnIfDue: vi.fn(() => Promise.resolve(null)),
      processTurn: vi.fn(() => {
        outbox.current = event({ status: 'completed' });
        return Promise.resolve();
      }),
    };
    const first = new Message();

    await consumeTurnDispatchMessage(first, { outbox, executor });

    expect(executor.processTurn).toHaveBeenCalledTimes(1);
    expect(outbox.deferred).toHaveBeenCalledWith(TURN_ID, 60_000);
    expect(outbox.completed).toHaveBeenCalledTimes(1);
    expect(first.ack).toHaveBeenCalledTimes(1);

    const duplicate = new Message();
    await consumeTurnDispatchMessage(duplicate, { outbox, executor });

    expect(executor.processTurn).toHaveBeenCalledTimes(1);
    expect(duplicate.ack).toHaveBeenCalledTimes(1);
  });

  it('recovers a committed reply after a Worker crash before Queue acknowledgement', async () => {
    const outbox = new MemoryOutbox();
    const executor = {
      expireTurnIfDue: vi.fn(() => Promise.resolve(null)),
      processTurn: vi.fn(() => {
        // This represents the B2 transaction committing the Assistant Message and terminal Turn.
        outbox.current = event({ status: 'completed' });
        return Promise.resolve();
      }),
    };
    const crashed = new Message();
    crashed.ack.mockImplementation(() => {
      throw new Error('simulated isolate termination after commit');
    });

    await expect(consumeTurnDispatchMessage(crashed, { outbox, executor })).rejects.toThrow(
      'simulated isolate termination',
    );

    const restarted = new Message();
    await consumeTurnDispatchMessage(restarted, { outbox, executor });

    expect(executor.processTurn).toHaveBeenCalledTimes(1);
    expect(restarted.ack).toHaveBeenCalledTimes(1);
  });

  it('acknowledges disabled model execution without fabricating or expiring a reply', async () => {
    const outbox = new MemoryOutbox();
    const executor = {
      expireTurnIfDue: vi.fn(() => Promise.resolve(null)),
      processTurn: vi.fn(() => Promise.resolve()),
    };
    const message = new Message();

    await consumeTurnDispatchMessage(message, { outbox, executor: null });

    expect(executor.expireTurnIfDue).not.toHaveBeenCalled();
    expect(executor.processTurn).not.toHaveBeenCalled();
    expect(outbox.current?.status).toBe('running');
    expect(outbox.deferred).toHaveBeenCalledTimes(1);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('waits on a live PostgreSQL lease and ignores a mismatched tenant envelope', async () => {
    const liveOutbox = new MemoryOutbox(event({ leaseRemainingMs: 2_500 }));
    const liveExecutor = {
      expireTurnIfDue: vi.fn(() => Promise.resolve(null)),
      processTurn: vi.fn(() => Promise.resolve()),
    };
    const liveMessage = new Message();
    await consumeTurnDispatchMessage(liveMessage, { outbox: liveOutbox, executor: liveExecutor });
    expect(liveExecutor.processTurn).not.toHaveBeenCalled();
    expect(liveMessage.retry).toHaveBeenCalledWith({ delaySeconds: 3 });

    const mismatchedOutbox = new MemoryOutbox();
    const badMessage = new Message({ ...envelope(), tenantId: CONVERSATION_ID });
    await consumeTurnDispatchMessage(badMessage, {
      outbox: mismatchedOutbox,
      executor: liveExecutor,
    });
    expect(badMessage.ack).toHaveBeenCalledTimes(1);
    expect(mismatchedOutbox.deferred).not.toHaveBeenCalled();
  });

  it('returns DLQ work to the PostgreSQL outbox', async () => {
    const outbox = new MemoryOutbox();
    const message = new Message();

    await recoverDeadLetter(message, outbox);

    expect(outbox.getEvent).toHaveBeenCalledWith(TURN_ID);
    expect(outbox.due).toHaveBeenCalledWith(TURN_ID, 60_000);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('does not let a mismatched DLQ envelope reschedule another tenant Turn', async () => {
    const outbox = new MemoryOutbox();
    const message = new Message({ ...envelope(), tenantId: CONVERSATION_ID });

    await recoverDeadLetter(message, outbox);

    expect(outbox.due).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('releases failed Queue publication for relay retry and emits only the stable envelope', async () => {
    const outbox = {
      claimDue: vi.fn(() => Promise.resolve([event()])),
      markEnqueued: vi.fn(() => Promise.resolve(true)),
      release: vi.fn(() => Promise.resolve(true)),
    };
    const failingQueue = {
      send: vi.fn(() => Promise.reject(new Error('Queue unavailable'))),
    };

    const failed = await publishDueTurnDispatches({
      outbox,
      queue: failingQueue,
      workerId: 'relay-test',
    });
    expect(failed).toEqual({ claimed: 1, enqueued: 0, failed: 1 });
    expect(outbox.release).toHaveBeenCalledWith({
      eventId: TURN_ID,
      workerId: 'relay-test',
      retryAfterMs: 5_000,
      errorCode: 'queue_unavailable',
    });

    const workingQueue = { send: vi.fn(() => Promise.resolve()) };
    const sent = await publishDueTurnDispatches({
      outbox,
      queue: workingQueue,
      workerId: 'relay-test',
    });
    expect(sent.enqueued).toBe(1);
    expect(workingQueue.send).toHaveBeenCalledWith(envelope());
    expect(outbox.markEnqueued).toHaveBeenCalledTimes(1);
  });
});
