import { describe, expect, it, vi } from 'vitest';
import type { B1TurnDispatchEvent } from '../../packages/postgres/src/repositories/b1-turn-dispatch-outbox.js';
import {
  isAuthorizedCloudModelTurn,
  resolveCloudRuntimeModelConfig,
} from '../../apps/cloud-async-runtime/src/config.js';
import cloudAsyncRuntime from '../../apps/cloud-async-runtime/src/index.js';
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
const TEST_MODEL_KEY = 'sk-test-cloud-staging-alpha-abcdefghijklmnopqrstuvwxyz';
const ALPHA_NOW = new Date('2026-11-12T12:00:00.000Z');

function stagingAlphaEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    EMBER_ENV: 'staging',
    EMBER_MODEL_EXECUTION: 'real',
    EMBER_MODEL_PROVIDER: 'openrouter',
    EMBER_MODEL_ID: 'nvidia/nemotron-3.5-lightning',
    EMBER_MODEL_API_KEY: TEST_MODEL_KEY,
    EMBER_MODEL_ALPHA_TENANT_ID: TENANT_ID,
    EMBER_MODEL_ALPHA_CONVERSATION_ID: CONVERSATION_ID,
    EMBER_MODEL_ALPHA_TURN_ID: TURN_ID,
    ...overrides,
  };
}

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
  it('routes the configured Staging Queue to the consumer and still ACKs unknown Queues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      HYPERDRIVE: { connectionString: 'postgresql://127.0.0.1/unused' },
      TURN_DISPATCH_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
      EMBER_TURN_DISPATCH_QUEUE_NAME: 'ember-staging-assistant-turns',
      EMBER_TURN_DISPATCH_DLQ_NAME: 'ember-staging-assistant-turns-dlq',
      EMBER_ENV: 'staging',
      EMBER_MODEL_EXECUTION: 'disabled',
    };

    try {
      const stagingMessage = new Message(null);
      await cloudAsyncRuntime.queue(
        { queue: 'ember-staging-assistant-turns', messages: [stagingMessage] },
        env,
      );

      expect(stagingMessage.ack).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'discarded malformed Assistant Turn dispatch envelope',
        expect.objectContaining({ category: 'invalid_envelope' }),
      );
      expect(warn).not.toHaveBeenCalledWith(
        'discarded Assistant Turn message from an unexpected Queue',
        expect.anything(),
      );

      const stagingDlqMessage = new Message(null);
      await cloudAsyncRuntime.queue(
        { queue: 'ember-staging-assistant-turns-dlq', messages: [stagingDlqMessage] },
        env,
      );

      expect(stagingDlqMessage.ack).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'discarded malformed Assistant Turn DLQ envelope',
        expect.objectContaining({ category: 'invalid_envelope' }),
      );

      const defaultEnv = {
        ...env,
        EMBER_TURN_DISPATCH_QUEUE_NAME: undefined,
        EMBER_TURN_DISPATCH_DLQ_NAME: undefined,
      };
      const defaultMessage = new Message(null);
      await cloudAsyncRuntime.queue(
        { queue: 'ember-assistant-turns', messages: [defaultMessage] },
        defaultEnv,
      );

      expect(defaultMessage.ack).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'discarded malformed Assistant Turn dispatch envelope',
        expect.objectContaining({ category: 'invalid_envelope' }),
      );

      const unexpectedMessage = new Message();
      await cloudAsyncRuntime.queue(
        { queue: 'ember-unconfigured-assistant-turns', messages: [unexpectedMessage] },
        env,
      );

      expect(unexpectedMessage.ack).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'discarded Assistant Turn message from an unexpected Queue',
        expect.objectContaining({ category: 'unexpected_queue' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

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

  it('allows only the code-selected staging Alpha purpose and exact server-configured Turn', () => {
    const model = resolveCloudRuntimeModelConfig(stagingAlphaEnv(), 'staging_alpha', ALPHA_NOW);

    expect(model).toMatchObject({
      kind: 'enabled',
      mode: 'real',
      onlyTurn: { tenantId: TENANT_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID },
      resolution: {
        executionScope: 'staging_alpha',
        maxStagingAlphaTurns: 1,
        approval: { approvalId: 'L4C3-B2-CLOUD-STAGING-ALPHA-2026-11-12' },
        settings: { maxAttempts: 1 },
      },
    });
    if (model.kind !== 'enabled' || model.mode !== 'real') return;

    expect(isAuthorizedCloudModelTurn(model, event())).toBe(true);
    for (const mismatch of [
      { tenantId: CONVERSATION_ID },
      { conversationId: TENANT_ID },
      { turnId: CONVERSATION_ID, eventId: CONVERSATION_ID },
    ]) {
      expect(isAuthorizedCloudModelTurn(model, event(mismatch))).toBe(false);
    }
  });

  it('refuses missing target identity, environment-selected purpose and production execution', () => {
    const scoped = stagingAlphaEnv();
    delete scoped.EMBER_MODEL_ALPHA_TURN_ID;
    expect(resolveCloudRuntimeModelConfig(scoped, 'staging_alpha', ALPHA_NOW)).toMatchObject({
      kind: 'refused',
      reason: 'staging_alpha_turn_scope_required',
    });

    expect(
      resolveCloudRuntimeModelConfig(
        stagingAlphaEnv({ EMBER_MODEL_EXECUTION_PURPOSE: 'staging_alpha' }),
        'resident_worker',
        ALPHA_NOW,
      ),
    ).toMatchObject({ kind: 'refused', reason: 'execution_scope_refused' });

    expect(
      resolveCloudRuntimeModelConfig(
        stagingAlphaEnv({ EMBER_ENV: 'production' }),
        'staging_alpha',
        ALPHA_NOW,
      ),
    ).toMatchObject({ kind: 'refused', reason: 'staging_alpha_environment_required' });
  });

  it('uses approved defaults when Alpha budgets are absent and rejects higher values', () => {
    const missing = resolveCloudRuntimeModelConfig(stagingAlphaEnv(), 'staging_alpha', ALPHA_NOW);
    expect(missing).toMatchObject({
      kind: 'enabled',
      mode: 'real',
      resolution: {
        settings: {
          ceilings: {
            perAttemptMicroUsd: 5_000,
            principalDailyMicroUsd: 5_000,
            tenantDailyMicroUsd: 5_000,
            globalDailyMicroUsd: 5_000,
            principalDailyTurns: 1,
          },
        },
      },
    });

    for (const override of [
      {
        EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: '5001',
        EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: '6000',
        EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '7000',
      },
      {
        EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: '5001',
        EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '6000',
      },
      { EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '5001' },
      { EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: '2' },
      { EMBER_MODEL_MAX_ATTEMPTS: '2' },
    ]) {
      expect(
        resolveCloudRuntimeModelConfig(stagingAlphaEnv(override), 'staging_alpha', ALPHA_NOW),
      ).toMatchObject({ kind: 'refused' });
    }

    expect(
      resolveCloudRuntimeModelConfig(
        stagingAlphaEnv({
          EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD: '4000',
          EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: '4000',
          EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: '4000',
          EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '4000',
          EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: '1',
        }),
        'staging_alpha',
        ALPHA_NOW,
      ),
    ).toMatchObject({ kind: 'enabled', mode: 'real' });
  });

  it('expires the Staging Alpha grant without extending the existing Smoke approval', () => {
    expect(
      resolveCloudRuntimeModelConfig(
        stagingAlphaEnv(),
        'staging_alpha',
        new Date('2026-11-14T00:00:00.000Z'),
      ),
    ).toMatchObject({ kind: 'refused', reason: 'approval_not_effective' });
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
