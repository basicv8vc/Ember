import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DomainError, type LeasedRun } from '@ember/domain';
import {
  PostgresB1TurnDispatchOutboxRepository,
  type B1TurnDispatchEvent,
} from '../../packages/postgres/src/repositories/b1-turn-dispatch-outbox.js';
import { PostgresLeaseQueue } from '../../packages/postgres/src/lease-queue/postgres-lease-queue.js';
import {
  PostgresB3StagedUploadRepository,
  PostgresByteaBlobStore,
} from '@ember/postgres/b3-worker';
import {
  isAuthorizedCloudModelTurn,
  isCloudModelConversationAuthorized,
  isCloudModelTenantAuthorized,
  resolveCloudRuntimeModelConfig,
} from '../../apps/cloud-async-runtime/src/config.js';
import cloudAsyncRuntime, {
  MAINTENANCE_GC_CRON,
  RECOVERY_RELAY_CRON,
  createCloudAsyncRuntime,
} from '../../apps/cloud-async-runtime/src/index.js';
import { createNotesTaskLeaseQueue } from '../../apps/cloud-async-runtime/src/runtime.js';
import {
  consumeTaskDispatchMessage,
  consumeTurnDispatchMessage,
  parseB1TaskDispatchEnvelope,
  parseB1TurnDispatchEnvelope,
  recoverDeadLetter,
  recoverTaskDeadLetter,
  taskDispatchEnvelope,
  type TaskDispatchHandlerPort,
  type TaskDispatchQueuePort,
  type TurnDispatchOutboxPort,
  type TurnDispatchQueueMessage,
} from '../../apps/cloud-async-runtime/src/dispatch.js';
import {
  publishDueNotesTaskDispatches,
  publishDueTurnDispatches,
} from '../../apps/cloud-async-runtime/src/relay.js';

const TURN_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849302';
const TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849303';
const SECOND_TENANT_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849305';
const CONVERSATION_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849304';
const TEST_MODEL_KEY = 'sk-test-cloud-staging-alpha-abcdefghijklmnopqrstuvwxyz';
const ALPHA_NOW = new Date('2026-11-13T12:00:00.000Z');
function stagingAlphaEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    EMBER_ENV: 'staging',
    EMBER_MODEL_EXECUTION: 'real',
    EMBER_MODEL_PROVIDER: 'openrouter',
    EMBER_MODEL_ID: 'nvidia/nemotron-3.5-lightning',
    EMBER_MODEL_API_KEY: TEST_MODEL_KEY,
    EMBER_MODEL_ALPHA_TENANT_IDS: `${TENANT_ID},${SECOND_TENANT_ID}`,
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
        'discarded dispatch message from an unexpected Queue',
        expect.objectContaining({ category: 'unexpected_queue' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps Wrangler cron triggers low-frequency and free of per-minute polling', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    for (const relPath of [
      'apps/cloud-async-runtime/wrangler.jsonc',
      'apps/cloud-async-runtime/wrangler.staging.jsonc',
    ]) {
      const raw = readFileSync(`${repoRoot}${relPath}`, 'utf8');
      // Strip trailing commas before closing braces/brackets so JSON.parse accepts valid JSONC.
      const normalized = raw.replace(/,\s*([}\]])/g, '$1');
      const parsed = JSON.parse(normalized) as {
        readonly triggers?: { readonly crons?: readonly string[] };
      };
      const crons = parsed.triggers?.crons ?? [];
      expect(crons, relPath).not.toContain('* * * * *');
      expect(crons, relPath).toEqual([RECOVERY_RELAY_CRON, MAINTENANCE_GC_CRON]);
    }
  });

  it('avoids PostgreSQL access for empty/unexpected queues and disabled/refused recovery ticks', async () => {
    const createPoolSpy = vi.fn(() => {
      throw new Error('unexpected DB pool creation');
    });
    const worker = createCloudAsyncRuntime({ createPool: createPoolSpy });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const runScheduled = (cron: string, envOverrides: Record<string, unknown> = {}) => {
      let pending: Promise<unknown> | undefined;
      worker.scheduled(
        { cron, scheduledTime: Date.now() },
        {
          HYPERDRIVE: { connectionString: 'postgresql://127.0.0.1/unused' },
          TURN_DISPATCH_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
          EMBER_ENV: 'staging',
          EMBER_MODEL_EXECUTION: 'disabled',
          ...envOverrides,
        },
        {
          waitUntil(promise) {
            pending = promise;
          },
        },
      );
      if (pending === undefined) throw new Error('expected scheduled work promise');
      return pending;
    };

    try {
      await worker.queue(
        { queue: 'ember-staging-assistant-turns', messages: [] },
        {
          HYPERDRIVE: { connectionString: 'postgresql://127.0.0.1/unused' },
          TURN_DISPATCH_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
          EMBER_ENV: 'staging',
          EMBER_MODEL_EXECUTION: 'disabled',
        },
      );
      const unexpectedMessage = new Message();
      await worker.queue(
        { queue: 'ember-unknown-queue', messages: [unexpectedMessage] },
        {
          HYPERDRIVE: { connectionString: 'postgresql://127.0.0.1/unused' },
          TURN_DISPATCH_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
          EMBER_ENV: 'staging',
          EMBER_MODEL_EXECUTION: 'disabled',
        },
      );
      expect(unexpectedMessage.ack).toHaveBeenCalledTimes(1);

      await runScheduled(RECOVERY_RELAY_CRON, { EMBER_MODEL_EXECUTION: 'disabled' });
      await runScheduled(RECOVERY_RELAY_CRON, { EMBER_MODEL_EXECUTION: 'fake' });

      expect(createPoolSpy).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('dispatches recovery relay and maintenance GC crons exclusively by schedule expression', async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const createPoolSpy = vi.fn(() => fakePool as never);
    const worker = createCloudAsyncRuntime({ createPool: createPoolSpy });
    const claimDueSpy = vi
      .spyOn(PostgresB1TurnDispatchOutboxRepository.prototype, 'claimDue')
      .mockResolvedValue([]);
    const reapSpy = vi.spyOn(PostgresLeaseQueue.prototype, 'reapExpired').mockResolvedValue(0);
    const uploadGcSpy = vi
      .spyOn(PostgresB3StagedUploadRepository.prototype, 'sweepExpiredUnboundUploads')
      .mockResolvedValue({ removed: 0 });
    const blobGcSpy = vi
      .spyOn(PostgresByteaBlobStore.prototype, 'sweepOrphans')
      .mockResolvedValue({ scanned: 0, removedStaged: 0, removedBlobs: 0, retained: 0 });

    const runScheduled = (cron: string) => {
      let pending: Promise<unknown> | undefined;
      worker.scheduled(
        { cron, scheduledTime: Date.now() },
        {
          ...stagingAlphaEnv(),
          EMBER_MODEL_ALPHA_SCOPE: 'authenticated_tenants',
          HYPERDRIVE: { connectionString: 'postgresql://127.0.0.1/unused' },
          TURN_DISPATCH_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
        },
        {
          waitUntil(promise) {
            pending = promise;
          },
        },
      );
      if (pending === undefined) throw new Error('expected scheduled work promise');
      return pending;
    };

    try {
      await runScheduled(RECOVERY_RELAY_CRON);
      expect(createPoolSpy).toHaveBeenCalledTimes(1);
      expect(claimDueSpy).toHaveBeenCalledTimes(1);
      expect(reapSpy).toHaveBeenCalledTimes(1);
      expect(uploadGcSpy).not.toHaveBeenCalled();
      expect(blobGcSpy).not.toHaveBeenCalled();
      expect(fakePool.end).toHaveBeenCalledTimes(1);

      claimDueSpy.mockClear();
      reapSpy.mockClear();
      createPoolSpy.mockClear();
      fakePool.end.mockClear();

      await runScheduled(MAINTENANCE_GC_CRON);
      expect(createPoolSpy).toHaveBeenCalledTimes(1);
      expect(uploadGcSpy).toHaveBeenCalledTimes(1);
      expect(blobGcSpy).toHaveBeenCalledTimes(1);
      expect(claimDueSpy).not.toHaveBeenCalled();
      expect(reapSpy).not.toHaveBeenCalled();
      expect(fakePool.end).toHaveBeenCalledTimes(1);
    } finally {
      blobGcSpy.mockRestore();
      uploadGcSpy.mockRestore();
      reapSpy.mockRestore();
      claimDueSpy.mockRestore();
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

  it('allows every Turn in every Conversation owned by an explicitly allowed internal tenant', () => {
    const model = resolveCloudRuntimeModelConfig(stagingAlphaEnv(), 'staging_alpha', ALPHA_NOW);

    expect(model).toMatchObject({
      kind: 'enabled',
      mode: 'real',
      tenantScope: 'allowlist',
      onlyTenantIds: [TENANT_ID, SECOND_TENANT_ID],
      resolution: {
        executionScope: 'staging_alpha',
        approval: { approvalId: 'EMBER-CLOUD-INTERNAL-MULTI-TURN' },
        settings: { maxAttempts: 1 },
      },
    });
    if (model.kind !== 'enabled' || model.mode !== 'real') return;

    expect(isAuthorizedCloudModelTurn(model, event())).toBe(true);
    expect(
      isAuthorizedCloudModelTurn(
        model,
        event({ conversationId: CONVERSATION_ID, turnId: CONVERSATION_ID }),
      ),
    ).toBe(true);
    expect(isAuthorizedCloudModelTurn(model, event({ tenantId: SECOND_TENANT_ID }))).toBe(true);
    expect(isAuthorizedCloudModelTurn(model, event({ tenantId: CONVERSATION_ID }))).toBe(false);
  });

  it('authorizes all authenticated tenants for Private Alpha without requiring an allowlist while keeping environment and purpose guards', () => {
    const openEnv = stagingAlphaEnv({ EMBER_MODEL_ALPHA_SCOPE: 'authenticated_tenants' });
    delete openEnv.EMBER_MODEL_ALPHA_TENANT_IDS;
    const model = resolveCloudRuntimeModelConfig(openEnv, 'staging_alpha', ALPHA_NOW);

    expect(model).toMatchObject({
      kind: 'enabled',
      mode: 'real',
      tenantScope: 'authenticated_tenants',
      onlyTenantIds: null,
      resolution: {
        executionScope: 'staging_alpha',
        settings: { maxAttempts: 1 },
      },
    });
    if (model.kind !== 'enabled' || model.mode !== 'real') return;

    const newExternalTenantId = '018f5f2e-0e91-7a30-ae62-bcb97d849399';
    expect(
      isCloudModelConversationAuthorized(model, event({ tenantId: newExternalTenantId })),
    ).toBe(true);
    expect(isAuthorizedCloudModelTurn(model, event({ tenantId: newExternalTenantId }))).toBe(true);

    // Tolerates legacy EMBER_MODEL_ALPHA_TENANT_IDS secret when authenticated_tenants is enabled.
    const withLegacySecret = resolveCloudRuntimeModelConfig(
      stagingAlphaEnv({ EMBER_MODEL_ALPHA_SCOPE: 'authenticated_tenants' }),
      'staging_alpha',
      ALPHA_NOW,
    );
    expect(withLegacySecret).toMatchObject({
      kind: 'enabled',
      mode: 'real',
      tenantScope: 'authenticated_tenants',
      onlyTenantIds: null,
    });
    if (withLegacySecret.kind === 'enabled' && withLegacySecret.mode === 'real') {
      expect(
        isAuthorizedCloudModelTurn(withLegacySecret, event({ tenantId: newExternalTenantId })),
      ).toBe(true);
    }

    expect(
      resolveCloudRuntimeModelConfig(
        { ...openEnv, EMBER_ENV: 'production' },
        'staging_alpha',
        ALPHA_NOW,
      ),
    ).toMatchObject({ kind: 'refused', reason: 'staging_alpha_environment_required' });

    expect(resolveCloudRuntimeModelConfig(openEnv, 'resident_worker', ALPHA_NOW)).toMatchObject({
      kind: 'refused',
      reason: 'execution_scope_refused',
    });
  });

  it('requires an explicit internal tenant allowlist and refuses environment-selected purpose or production', () => {
    const scoped = stagingAlphaEnv();
    delete scoped.EMBER_MODEL_ALPHA_TENANT_IDS;
    expect(resolveCloudRuntimeModelConfig(scoped, 'staging_alpha', ALPHA_NOW)).toMatchObject({
      kind: 'refused',
      reason: 'staging_alpha_tenant_allowlist_required',
    });

    expect(
      resolveCloudRuntimeModelConfig(
        stagingAlphaEnv({
          EMBER_MODEL_EXECUTION_PURPOSE: 'staging_alpha',
          EMBER_MODEL_ALPHA_TURN_ID: TURN_ID,
        }),
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

  it('fails closed for malformed Tenant allowlists', () => {
    for (const allowlist of ['', '*', `${TENANT_ID},`, 'not-a-tenant-id']) {
      expect(
        resolveCloudRuntimeModelConfig(
          stagingAlphaEnv({ EMBER_MODEL_ALPHA_TENANT_IDS: allowlist }),
          'staging_alpha',
          ALPHA_NOW,
        ),
      ).toMatchObject({ kind: 'refused', reason: 'invalid_runtime_configuration' });
    }
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
            principalDailyMicroUsd: 250_000,
            tenantDailyMicroUsd: 1_000_000,
            globalDailyMicroUsd: 1_000_000,
            principalDailyTurns: 60,
          },
        },
      },
    });

    for (const override of [
      {
        EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: '250001',
        EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: '1000001',
        EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '1000001',
      },
      {
        EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: '1000001',
        EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '1000001',
      },
      { EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '1000001' },
      { EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: '61' },
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
          EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: '200000',
          EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: '800000',
          EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: '800000',
          EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: '30',
        }),
        'staging_alpha',
        ALPHA_NOW,
      ),
    ).toMatchObject({ kind: 'enabled', mode: 'real' });
  });

  it('keeps the internal grant active without extending the independently expiring Smoke grant', () => {
    expect(
      resolveCloudRuntimeModelConfig(
        stagingAlphaEnv(),
        'staging_alpha',
        new Date('2028-11-21T00:00:00.000Z'),
      ),
    ).toMatchObject({ kind: 'enabled', mode: 'real' });
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

  describe('Notes Task dispatch, DLQ recovery, and reconciliation relay', () => {
    const TASK_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849306';
    const RUN_ID = '018f5f2e-0e91-7a30-ae62-bcb97d849307';

    function sampleTaskEnvelope() {
      return taskDispatchEnvelope({ tenantId: TENANT_ID, taskId: TASK_ID });
    }

    function sampleLease(): LeasedRun {
      return {
        tenantId: TENANT_ID,
        taskId: TASK_ID,
        runId: RUN_ID,
        attempt: 1,
        leaseEpoch: 1,
        leaseExpiresAt: '2026-11-15T12:00:30.000Z',
      };
    }

    function createMockTaskQueue(overrides?: {
      reapExpired?: ReturnType<typeof vi.fn<TaskDispatchQueuePort['reapExpired']>>;
      claimTask?: ReturnType<typeof vi.fn<TaskDispatchQueuePort['claimTask']>>;
      heartbeat?: ReturnType<typeof vi.fn<TaskDispatchQueuePort['heartbeat']>>;
      finish?: ReturnType<typeof vi.fn<TaskDispatchQueuePort['finish']>>;
    }) {
      const reapExpired =
        overrides?.reapExpired ??
        vi.fn<TaskDispatchQueuePort['reapExpired']>(() => Promise.resolve(0));
      const claimTask =
        overrides?.claimTask ??
        vi.fn<TaskDispatchQueuePort['claimTask']>(() => Promise.resolve({ kind: 'not_found' }));
      const heartbeat =
        overrides?.heartbeat ??
        vi.fn<TaskDispatchQueuePort['heartbeat']>(() => Promise.resolve(true));
      const finish =
        overrides?.finish ?? vi.fn<TaskDispatchQueuePort['finish']>(() => Promise.resolve(true));
      return {
        port: { reapExpired, claimTask, heartbeat, finish } satisfies TaskDispatchQueuePort,
        reapExpired,
        claimTask,
        heartbeat,
        finish,
      };
    }

    it('parses only prompt-free closed Notes Task envelopes and checks tenant authorization', () => {
      const valid = sampleTaskEnvelope();
      expect(valid).toEqual({
        schemaVersion: 1,
        kind: 'task',
        tenantId: TENANT_ID,
        taskId: TASK_ID,
      });
      expect(parseB1TaskDispatchEnvelope(valid)).toEqual(valid);
      expect(parseB1TaskDispatchEnvelope({ ...valid, notes: 'secret' })).toBeNull();
      expect(parseB1TaskDispatchEnvelope({ ...valid, kind: 'turn' })).toBeNull();
      expect(parseB1TaskDispatchEnvelope({ ...valid, taskId: 'not-uuid' })).toBeNull();

      const model = resolveCloudRuntimeModelConfig(stagingAlphaEnv(), 'staging_alpha', ALPHA_NOW);
      expect(model.kind).toBe('enabled');
      if (model.kind !== 'enabled') return;
      expect(isCloudModelTenantAuthorized(model, TENANT_ID)).toBe(true);
      expect(isCloudModelTenantAuthorized(model, SECOND_TENANT_ID)).toBe(true);
      expect(isCloudModelTenantAuthorized(model, CONVERSATION_ID)).toBe(false);
    });

    it('claims, executes, finishes, and handles retries/fencing on Notes Task messages', async () => {
      const fixedNow = () => new Date('2026-11-15T12:00:00.000Z');
      const warn = vi.fn();

      // Malformed envelope -> ACK + discard.
      const badMsg = new Message({ kind: 'task', tenantId: TENANT_ID });
      const unusedQueue = createMockTaskQueue();
      await consumeTaskDispatchMessage(badMsg, {
        leaseQueue: unusedQueue.port,
        workerId: 'w-1',
        handler: { handle: vi.fn() },
        logger: { warn },
        now: fixedNow,
      });
      expect(badMsg.ack).toHaveBeenCalledTimes(1);
      expect(unusedQueue.claimTask).not.toHaveBeenCalled();

      // Handler null (disabled/unauthorized) -> ACK without touching DB.
      const disabledMsg = new Message(sampleTaskEnvelope());
      await consumeTaskDispatchMessage(disabledMsg, {
        leaseQueue: unusedQueue.port,
        workerId: 'w-1',
        handler: null,
        now: fixedNow,
      });
      expect(disabledMsg.ack).toHaveBeenCalledTimes(1);
      expect(unusedQueue.claimTask).not.toHaveBeenCalled();

      // Active lease -> retry with lease delay.
      const leaseActiveQueue = createMockTaskQueue({
        claimTask: vi.fn<TaskDispatchQueuePort['claimTask']>(() =>
          Promise.resolve({ kind: 'lease_active', leaseRemainingMs: 2_300 }),
        ),
      });
      const leaseActiveMsg = new Message(sampleTaskEnvelope());
      await consumeTaskDispatchMessage(leaseActiveMsg, {
        leaseQueue: leaseActiveQueue.port,
        workerId: 'w-1',
        handler: { handle: vi.fn() },
        now: fixedNow,
      });
      expect(leaseActiveMsg.retry).toHaveBeenCalledWith({ delaySeconds: 3 });

      // Deferred -> reaps expired, then claims on retry and commits -> ACK without calling finish.
      const claimTaskDeferred = vi
        .fn<TaskDispatchQueuePort['claimTask']>()
        .mockResolvedValueOnce({ kind: 'deferred', delayMs: 2_000 })
        .mockResolvedValueOnce({ kind: 'claimed', lease: sampleLease() });
      const committedQueue = createMockTaskQueue({
        reapExpired: vi.fn<TaskDispatchQueuePort['reapExpired']>(() => Promise.resolve(1)),
        claimTask: claimTaskDeferred,
      });
      const handleCommitted = vi.fn<TaskDispatchHandlerPort['handle']>(() =>
        Promise.resolve({ type: 'committed' }),
      );
      const committedMsg = new Message(sampleTaskEnvelope());
      await consumeTaskDispatchMessage(committedMsg, {
        leaseQueue: committedQueue.port,
        workerId: 'w-1',
        handler: { handle: handleCommitted },
        now: fixedNow,
      });
      expect(committedQueue.reapExpired).toHaveBeenCalledTimes(1);
      expect(handleCommitted).toHaveBeenCalledTimes(1);
      expect(committedQueue.finish).not.toHaveBeenCalled();
      expect(committedMsg.ack).toHaveBeenCalledTimes(1);

      // Failed retryable -> calls finish(failed_retryable) and retries message.
      const retryQueue = createMockTaskQueue({
        claimTask: vi.fn<TaskDispatchQueuePort['claimTask']>(() =>
          Promise.resolve({ kind: 'claimed', lease: sampleLease() }),
        ),
      });
      const retryMsg = new Message(sampleTaskEnvelope());
      await consumeTaskDispatchMessage(retryMsg, {
        leaseQueue: retryQueue.port,
        workerId: 'w-1',
        handler: {
          handle: vi.fn<TaskDispatchHandlerPort['handle']>(() =>
            Promise.resolve({ type: 'finish', outcome: 'failed_retryable' }),
          ),
        },
        now: fixedNow,
      });
      expect(retryQueue.finish).toHaveBeenCalledWith(sampleLease(), 'failed_retryable', fixedNow());
      expect(retryMsg.retry).toHaveBeenCalledWith({ delaySeconds: 1 });

      // STALE_LEASE -> retries without calling finish().
      const staleQueue = createMockTaskQueue({
        claimTask: vi.fn<TaskDispatchQueuePort['claimTask']>(() =>
          Promise.resolve({ kind: 'claimed', lease: sampleLease() }),
        ),
      });
      const staleMsg = new Message(sampleTaskEnvelope());
      await consumeTaskDispatchMessage(staleMsg, {
        leaseQueue: staleQueue.port,
        workerId: 'w-1',
        handler: {
          handle: vi.fn(() => Promise.reject(new DomainError('STALE_LEASE', 'epoch lost'))),
        },
        now: fixedNow,
      });
      expect(staleQueue.finish).not.toHaveBeenCalled();
      expect(staleMsg.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
    });

    it('recovers Notes DLQ envelopes and filters due Notes relay targets by tenant allowlist', async () => {
      const warn = vi.fn();
      const openMsg = new Message(sampleTaskEnvelope());
      await recoverTaskDeadLetter(
        openMsg,
        vi.fn<() => Promise<'open' | 'terminal' | 'missing'>>(() => Promise.resolve('open')),
        { warn },
      );
      expect(openMsg.ack).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'returned Notes Task DLQ delivery to PostgreSQL cron reconciliation',
        expect.objectContaining({ taskId: TASK_ID }),
      );

      const relay = {
        reapExpired: vi.fn(() => Promise.resolve(2)),
        listDueNotesTasks: vi.fn(() =>
          Promise.resolve([
            { tenantId: TENANT_ID, taskId: TASK_ID },
            { tenantId: CONVERSATION_ID, taskId: TURN_ID },
          ]),
        ),
      };
      const queue = { send: vi.fn(() => Promise.resolve()) };
      const result = await publishDueNotesTaskDispatches({
        relay,
        queue,
        isAuthorizedTenant: (tenantId) => tenantId === TENANT_ID,
      });
      expect(result).toEqual({ reaped: 2, examined: 1, enqueued: 1, failed: 0 });
      expect(queue.send).toHaveBeenCalledTimes(1);
      expect(queue.send).toHaveBeenCalledWith(sampleTaskEnvelope());
    });

    it('renews lease heartbeats past the original lease TTL and cleans up timers on exit', async () => {
      vi.useFakeTimers();
      try {
        const start = new Date('2026-11-15T12:00:00.000Z');
        vi.setSystemTime(start);
        const lease: LeasedRun = {
          ...sampleLease(),
          leaseExpiresAt: new Date(start.getTime() + 100).toISOString(),
        };
        const queue = createMockTaskQueue({
          claimTask: vi.fn<TaskDispatchQueuePort['claimTask']>(() =>
            Promise.resolve({ kind: 'claimed', lease }),
          ),
        });

        let abortedDuringExecution = false;
        let finishExecution!: () => void;
        const executionDone = new Promise<void>((resolve) => {
          finishExecution = resolve;
        });

        const msg = new Message(sampleTaskEnvelope());
        const consumePromise = consumeTaskDispatchMessage(msg, {
          leaseQueue: queue.port,
          workerId: 'w-hb-1',
          heartbeatIntervalMs: 30,
          handler: {
            handle: async (_run, signal) => {
              signal.addEventListener('abort', () => {
                abortedDuringExecution = true;
              });
              await executionDone;
              return { type: 'committed' };
            },
          },
        });

        // Advance well past the 100ms initial lease TTL; heartbeats every 30ms keep extending watchdog.
        await vi.advanceTimersByTimeAsync(150);
        expect(queue.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(abortedDuringExecution).toBe(false);

        finishExecution();
        await consumePromise;

        expect(msg.ack).toHaveBeenCalledTimes(1);
        expect(queue.finish).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts execution and handles fencing/cancellation/errors cleanly when heartbeat fails', async () => {
      const fixedNow = () => new Date('2026-11-15T12:00:00.000Z');
      const warn = vi.fn();

      // 1) heartbeat() returns false -> aborts handler, skips non-cancelled finish(), retries message.
      const lostQueue = createMockTaskQueue({
        claimTask: vi.fn<TaskDispatchQueuePort['claimTask']>(() =>
          Promise.resolve({ kind: 'claimed', lease: sampleLease() }),
        ),
        heartbeat: vi.fn<TaskDispatchQueuePort['heartbeat']>(() => Promise.resolve(false)),
      });
      const lostMsg = new Message(sampleTaskEnvelope());
      let signalAbortedOnLost = false;
      await consumeTaskDispatchMessage(lostMsg, {
        leaseQueue: lostQueue.port,
        workerId: 'w-hb-lost',
        heartbeatIntervalMs: 1_000,
        sleep: () => Promise.resolve(),
        now: fixedNow,
        logger: { warn },
        handler: {
          handle: (_run, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  signalAbortedOnLost = true;
                  resolve({ type: 'finish', outcome: 'failed_retryable' });
                },
                { once: true },
              );
            }),
        },
      });
      expect(signalAbortedOnLost).toBe(true);
      expect(lostQueue.finish).not.toHaveBeenCalled();
      expect(lostMsg.ack).not.toHaveBeenCalled();
      expect(lostMsg.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
      expect(warn).toHaveBeenCalledWith(
        'Notes Task lease heartbeat rejected',
        expect.objectContaining({ category: 'lease_lost' }),
      );

      // 2) heartbeat() returns false due to cooperative cancellation -> converges via finish('cancelled').
      const cancelQueue = createMockTaskQueue({
        claimTask: vi.fn<TaskDispatchQueuePort['claimTask']>(() =>
          Promise.resolve({ kind: 'claimed', lease: sampleLease() }),
        ),
        heartbeat: vi.fn<TaskDispatchQueuePort['heartbeat']>(() => Promise.resolve(false)),
      });
      const cancelMsg = new Message(sampleTaskEnvelope());
      await consumeTaskDispatchMessage(cancelMsg, {
        leaseQueue: cancelQueue.port,
        workerId: 'w-hb-cancel',
        heartbeatIntervalMs: 1_000,
        sleep: () => Promise.resolve(),
        now: fixedNow,
        handler: {
          handle: (_run, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  resolve({ type: 'finish', outcome: 'cancelled' });
                },
                { once: true },
              );
            }),
        },
      });
      expect(cancelQueue.finish).toHaveBeenCalledWith(sampleLease(), 'cancelled', fixedNow());
      expect(cancelMsg.ack).toHaveBeenCalledTimes(1);
      expect(cancelMsg.retry).not.toHaveBeenCalled();

      // 3) heartbeat() throws -> aborts handler, skips finish() even if outcome looks terminal, retries.
      const errorQueue = createMockTaskQueue({
        claimTask: vi.fn<TaskDispatchQueuePort['claimTask']>(() =>
          Promise.resolve({ kind: 'claimed', lease: sampleLease() }),
        ),
        heartbeat: vi.fn<TaskDispatchQueuePort['heartbeat']>(() =>
          Promise.reject(new DomainError('DB_UNAVAILABLE', 'pool timeout')),
        ),
      });
      const errMsg = new Message(sampleTaskEnvelope());
      await consumeTaskDispatchMessage(errMsg, {
        leaseQueue: errorQueue.port,
        workerId: 'w-hb-err',
        heartbeatIntervalMs: 1_000,
        sleep: () => Promise.resolve(),
        now: fixedNow,
        logger: { warn },
        handler: {
          handle: (_run, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  resolve({ type: 'finish', outcome: 'cancelled' });
                },
                { once: true },
              );
            }),
        },
      });
      expect(errorQueue.finish).not.toHaveBeenCalled();
      expect(errMsg.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
      expect(warn).toHaveBeenCalledWith(
        'Notes Task lease heartbeat failed',
        expect.objectContaining({ category: 'DB_UNAVAILABLE' }),
      );

      // 4) createNotesTaskLeaseQueue configures heartbeat strictly shorter than short 1s leases.
      const shortModel = resolveCloudRuntimeModelConfig(
        stagingAlphaEnv({ EMBER_MODEL_TURN_LEASE_MS: '1000' }),
        'staging_alpha',
        ALPHA_NOW,
      );
      expect(shortModel.kind).toBe('enabled');
      const shortLeaseQueue = createNotesTaskLeaseQueue({} as never, shortModel);
      expect(shortLeaseQueue.configuration.leaseDurationMs).toBe(1_000);
      expect(shortLeaseQueue.configuration.heartbeatIntervalMs).toBe(333);
    });
  });
});
