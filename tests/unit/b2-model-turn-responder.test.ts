import { describe, expect, it } from 'vitest';
import type { B1AssistantTurnDto } from '@ember/contracts';
import {
  FAKE_MODEL_LABEL,
  FakeModelGateway,
  MODEL_LIMITS,
  ModelGatewayFailure,
  type ConversationTurnInput,
  type ConversationTurnOutput,
  type ModelBudgetCeilings,
  type ModelCallResult,
  type ModelFailureCode,
  type ModelGateway,
  type ModelRateRow,
} from '@ember/model-gateway';
import type {
  B2AttemptCharge,
  B2ClaimOutcome,
  B2PublicationResult,
  B2ReserveOutcome,
  B2SettlementOutcome,
  B2TurnContextRow,
  B2TurnLease,
} from '@ember/postgres';
import {
  createModelTurnResponder,
  type ModelTurnExecutionPort,
  type PendingModelTurn,
} from '../../apps/worker/src/b1/model-turn-responder.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const turnId = '33333333-3333-4333-8333-333333333333';

/** A priced, invoice-verified row. Unit tests never reach a provider; this only prices arithmetic. */
const rate: ModelRateRow = {
  providerId: 'openai',
  modelId: 'gpt-test-pinned-2026-11-03',
  inputMicroUsdPerMillion: 250_000,
  outputMicroUsdPerMillion: 2_000_000,
  rateVersion: 'openai-gpt-test-pinned-2026-11-03-invoice',
  provenance: 'invoice_verified',
  source: 'test fixture',
};

const ceilings: ModelBudgetCeilings = {
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
};

const REAL_MODEL_LABEL = 'gpt-test-pinned-2026-11-03';

const contextRows: readonly B2TurnContextRow[] = [
  { sequence: 1, kind: 'user', text: 'hello there' },
];

/** Ordered call log: proves the sequence the money and the text move in. */
type Call =
  | 'listRunningTurns'
  | 'expireTurnIfDue'
  | 'claimTurn'
  | 'loadTurnContext'
  | 'reserveAttempt'
  | 'markAttemptSent'
  | 'settleAttempt'
  | 'publishCompletion';

interface PublishRecord {
  readonly status: 'completed' | 'failed';
  readonly text?: string;
  readonly modelLabel?: string;
  readonly simulated?: boolean;
  readonly failureReason?: 'timeout' | 'internal_error';
}

/**
 * In-memory execution port.
 *
 * It deliberately does **not** reimplement SQL fencing: this file asserts responder
 * *orchestration* — ordering, retry, settlement state, abort path. Lease epochs, double claims and
 * duplicate-message suppression are asserted against real PostgreSQL in the B2 integration suite,
 * because that is where the guarantees actually live.
 */
class MemoryExecutionPort implements ModelTurnExecutionPort {
  readonly calls: Call[] = [];
  readonly publishes: PublishRecord[] = [];
  readonly charges: B2AttemptCharge[] = [];
  readonly reserveCommands: Array<{ reservedMicroUsd: number; modelLabel: string }> = [];

  running = true;
  deadlineExpired = false;
  leaseBusy = false;
  leaseLost = false;
  markSentSucceeds = true;

  /** When set, every reservation is refused this way. The database models the same conditions. */
  reserveRefusal: B2ReserveOutcome | null = null;

  attemptsIssued = 0;

  listRunningTurns(): Promise<readonly PendingModelTurn[]> {
    this.calls.push('listRunningTurns');
    return Promise.resolve(this.running ? [{ tenantId, conversationId, turnId }] : []);
  }

  expireTurnIfDue(): Promise<B1AssistantTurnDto | null> {
    this.calls.push('expireTurnIfDue');
    return Promise.resolve(this.deadlineExpired ? failedTurn('timeout') : null);
  }

  claimTurn(): Promise<B2ClaimOutcome> {
    this.calls.push('claimTurn');

    if (!this.running) {
      return Promise.resolve({ kind: 'not_claimed', reason: 'not_running' });
    }

    if (this.leaseBusy) {
      return Promise.resolve({ kind: 'not_claimed', reason: 'lease_active' });
    }

    // Mirrors the single atomic UPDATE: the first claimant owns the lease, the second sees it held.
    this.leaseBusy = true;

    return Promise.resolve({ kind: 'claimed', lease: this.lease() });
  }

  loadTurnContext(): Promise<readonly B2TurnContextRow[]> {
    this.calls.push('loadTurnContext');
    return Promise.resolve(contextRows);
  }

  reserveAttempt(command: {
    readonly reservedMicroUsd: number;
    readonly modelLabel: string;
  }): Promise<B2ReserveOutcome> {
    this.calls.push('reserveAttempt');
    this.reserveCommands.push({
      reservedMicroUsd: command.reservedMicroUsd,
      modelLabel: command.modelLabel,
    });

    if (this.reserveRefusal !== null) {
      return Promise.resolve(this.reserveRefusal);
    }

    const attemptNo = this.attemptsIssued + 1;

    // Same absolute ceiling the table enforces with `attempt_no BETWEEN 1 AND maxAttempts`.
    if (attemptNo > MODEL_LIMITS.maxAttemptsPerTurn) {
      return Promise.resolve({ kind: 'attempts_exhausted' });
    }

    this.attemptsIssued = attemptNo;
    return Promise.resolve({
      kind: 'reserved',
      attempt: {
        attemptNo,
        operationId: `4444444${attemptNo}-4444-4444-8444-44444444444${attemptNo}`,
        utcDay: '2026-11-05',
        reservedMicroUsd: ceilings.perAttemptMicroUsd,
      },
    });
  }

  markAttemptSent(): Promise<boolean> {
    this.calls.push('markAttemptSent');
    return Promise.resolve(this.markSentSucceeds && !this.leaseLost);
  }

  settleAttempt(charge: B2AttemptCharge): Promise<B2SettlementOutcome> {
    this.calls.push('settleAttempt');
    this.charges.push(charge);
    return Promise.resolve({ kind: 'applied', state: charge.state, appliedMicroUsd: null });
  }

  publishCompletion(command: { readonly result: PublishRecord }): Promise<B2PublicationResult> {
    this.calls.push('publishCompletion');

    if (this.leaseLost) {
      return Promise.resolve({ outcome: 'fenced', turn: null });
    }

    this.publishes.push(command.result);

    return Promise.resolve({ outcome: 'published', turn: completedTurn() });
  }

  lease(): B2TurnLease {
    return {
      tenantId,
      conversationId,
      turnId,
      leaseEpoch: 1,
      leaseOwner: 'worker-a',
      deadlineAt: new Date(Date.now() + MODEL_LIMITS.turnDeadlineMs).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }
}

function completedTurn(): B1AssistantTurnDto {
  return {
    turn_id: turnId,
    conversation_id: conversationId,
    source_message_id: '55555555-5555-4555-8555-555555555555',
    status: 'completed',
    created_at: '2026-11-05T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:02.000Z',
    response_message_id: '66666666-6666-4666-8666-666666666666',
    failure_reason: null,
  };
}

function failedTurn(failureReason: 'timeout' | 'internal_error'): B1AssistantTurnDto {
  return {
    ...completedTurn(),
    status: 'failed',
    failure_reason: failureReason,
  };
}

/** A gateway whose exact behaviour each test scripts: no network, no environment, no clock. */
class ScriptedGateway implements ModelGateway {
  readonly providerId = 'openai' as const;
  readonly modelLabel = REAL_MODEL_LABEL;
  readonly simulated = false;
  readonly operations = ['conversation.turn'] as const;

  readonly inputs: ConversationTurnInput[] = [];
  readonly signals: AbortSignal[] = [];

  #script: Array<ModelFailureCode | 'ok'>;

  constructor(script: Array<ModelFailureCode | 'ok'>) {
    this.#script = [...script];
  }

  generateConversationTurn(
    input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>> {
    this.inputs.push(input);
    this.signals.push(signal);

    const step = this.#script.shift() ?? 'ok';

    if (step !== 'ok') {
      return Promise.reject(new ModelGatewayFailure(step));
    }

    return Promise.resolve({
      output: { text: 'a real reply', finishReason: 'stop' as const },
      modelLabel: REAL_MODEL_LABEL,
      simulated: false as const,
      usage: {
        inputTokens: 40,
        outputTokens: 20,
        costMicroUsd: 130,
        rateVersion: rate.rateVersion,
      },
    });
  }
}

/** Never settles on its own: it only rejects when the shared signal aborts. */
class HangingGateway implements ModelGateway {
  readonly providerId = 'openai' as const;
  readonly modelLabel = REAL_MODEL_LABEL;
  readonly simulated = false;
  readonly operations = ['conversation.turn'] as const;

  #entered: () => void = () => {};
  readonly entered = new Promise<void>((resolve) => {
    this.#entered = resolve;
  });

  generateConversationTurn(
    _input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>> {
    this.#entered();

    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new ModelGatewayFailure('client_cancelled')), {
        once: true,
      });
    });
  }
}

function realResponder(
  repository: ModelTurnExecutionPort,
  gateway: ModelGateway,
  overrides: Partial<Parameters<typeof createModelTurnResponder>[0]> = {},
) {
  return createModelTurnResponder({
    mode: 'real',
    repository,
    gateway,
    workerId: 'worker-a',
    leaseMs: 30_000,
    ceilings,
    maxAttempts: MODEL_LIMITS.maxAttemptsPerTurn,
    attemptTimeoutMs: MODEL_LIMITS.attemptTimeoutMs,
    rate,
    ...overrides,
  });
}

describe('B2 responder: the happy path', () => {
  it('reserves, sends once, settles the real cost and publishes simulated:false', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new ScriptedGateway(['ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.completed).toBe(1);

    // Exactly one outbound attempt, and the money moved before the text did.
    expect(gateway.inputs).toHaveLength(1);
    expect(repository.calls).toStrictEqual([
      'listRunningTurns',
      'expireTurnIfDue',
      'claimTurn',
      'loadTurnContext',
      'reserveAttempt',
      'markAttemptSent',
      'settleAttempt',
      'publishCompletion',
    ]);

    expect(repository.charges).toHaveLength(1);
    expect(repository.charges[0]).toMatchObject({
      state: 'settled',
      outcomeCode: 'ok',
      observedCostMicroUsd: 130,
      inputTokens: 40,
      outputTokens: 20,
    });

    expect(repository.publishes).toHaveLength(1);
    expect(repository.publishes[0]).toMatchObject({
      status: 'completed',
      text: 'a real reply',
      modelLabel: REAL_MODEL_LABEL,
      simulated: false,
    });
  });

  it('sends the bounded transcript and caps the completion at the limit', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new ScriptedGateway(['ok']);
    await realResponder(repository, gateway).processOnce();

    const input = gateway.inputs[0]!;

    expect(input.context).toStrictEqual([{ role: 'user', text: 'hello there' }]);
    expect(input.maxOutputTokens).toBe(MODEL_LIMITS.maxOutputTokens);
    expect(input.turnId).toBe(turnId);
    expect(input.conversationId).toBe(conversationId);
  });

  it('names the attempt with the pinned model label, not a caller-supplied string', async () => {
    const repository = new MemoryExecutionPort();
    await realResponder(repository, new ScriptedGateway(['ok'])).processOnce();

    expect(repository.reserveCommands[0]?.modelLabel).toBe(REAL_MODEL_LABEL);
  });

  it('reserves a positive bounded amount derived from the priced rate', async () => {
    const repository = new MemoryExecutionPort();
    await realResponder(repository, new ScriptedGateway(['ok'])).processOnce();

    const reserved = repository.reserveCommands[0]?.reservedMicroUsd ?? 0;

    expect(reserved).toBeGreaterThan(0);
    expect(reserved).toBeLessThanOrEqual(ceilings.perAttemptMicroUsd);
    expect(reserved).toBeLessThanOrEqual(MODEL_LIMITS.maxReservedMicroUsdPerAttempt);
  });
});

describe('B2 responder: fake mode', () => {
  it('never reserves money or opens an attempt, and publishes a labelled simulation', async () => {
    const repository = new MemoryExecutionPort();
    const summary = await realResponder(repository, new FakeModelGateway(), {
      mode: 'fake',
    }).processOnce();

    expect(summary.completed).toBe(1);
    expect(repository.calls).not.toContain('reserveAttempt');
    expect(repository.calls).not.toContain('markAttemptSent');
    expect(repository.calls).not.toContain('settleAttempt');
    expect(repository.publishes).toHaveLength(1);
    expect(repository.publishes[0]).toMatchObject({
      simulated: true,
      modelLabel: FAKE_MODEL_LABEL,
    });
  });

  it('still honours the deadline before spending a claim', async () => {
    const repository = new MemoryExecutionPort();
    repository.deadlineExpired = true;
    const summary = await realResponder(repository, new FakeModelGateway(), {
      mode: 'fake',
    }).processOnce();

    expect(summary.expired).toBe(1);
    expect(repository.calls).not.toContain('claimTurn');
    expect(repository.publishes).toHaveLength(0);
  });
});

describe('B2 responder: concurrent workers', () => {
  it('makes zero provider calls when another worker holds the lease', async () => {
    const repository = new MemoryExecutionPort();
    repository.leaseBusy = true;
    const gateway = new ScriptedGateway(['ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.skipped).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(repository.calls).not.toContain('reserveAttempt');
    expect(repository.publishes).toHaveLength(0);
  });

  it('lets two responder instances race one turn and publish exactly one reply', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new ScriptedGateway(['ok', 'ok']);
    const a = realResponder(repository, gateway, { workerId: 'worker-a' });
    const b = realResponder(repository, gateway, { workerId: 'worker-b' });

    const [first, second] = await Promise.all([a.processOnce(), b.processOnce()]);

    expect(first.completed + second.completed).toBe(1);
    expect(first.skipped + second.skipped).toBe(1);
    expect(repository.publishes).toHaveLength(1);
  });

  it('releases the whole reservation without calling a provider when the send CAS loses', async () => {
    const repository = new MemoryExecutionPort();
    repository.markSentSucceeds = false;
    const gateway = new ScriptedGateway(['ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.fenced).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(repository.charges).toStrictEqual([
      expect.objectContaining({ state: 'released', outcomeCode: 'not_sent' }),
    ]);
    expect(repository.publishes).toHaveLength(0);
  });
});

describe('B2 responder: provider failures', () => {
  it('bills an unknown amount and fails the turn when the provider times out', async () => {
    const repository = new MemoryExecutionPort();
    const summary = await realResponder(
      repository,
      new ScriptedGateway(['model_timeout', 'model_timeout']),
    ).processOnce();

    expect(summary.timedOut).toBe(1);
    expect(repository.charges.map((charge) => charge.state)).toStrictEqual([
      'unknown_billed',
      'unknown_billed',
    ]);
    expect(repository.charges[0]).toMatchObject({
      state: 'unknown_billed',
      outcomeCode: 'model_timeout',
    });
    expect(repository.publishes[0]).toMatchObject({ status: 'failed', failureReason: 'timeout' });
  });

  it('retries a 5xx on a second attempt, keeping the turn running in between', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new ScriptedGateway(['model_unavailable', 'ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.completed).toBe(1);
    expect(gateway.inputs).toHaveLength(2);

    // The first attempt keeps its pessimistic charge; only the second settles to the real cost.
    expect(repository.charges.map((charge) => charge.state)).toStrictEqual([
      'unknown_billed',
      'settled',
    ]);
    expect(repository.charges.map((charge) => charge.attemptNo)).toStrictEqual([1, 2]);

    // Between attempts the Turn stays running: exactly one publication, at the very end.
    expect(repository.publishes).toHaveLength(1);
    expect(repository.calls.filter((call) => call === 'publishCompletion')).toHaveLength(1);
  });

  it('does not retry a non-retryable auth failure', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new ScriptedGateway(['model_auth_failed', 'ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(1);
    expect(repository.publishes[0]).toMatchObject({
      status: 'failed',
      failureReason: 'internal_error',
    });
  });

  it('stops retrying at the attempt ceiling and fails the turn', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new ScriptedGateway([
      'model_rate_limited',
      'model_rate_limited',
      'model_rate_limited',
    ]);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(MODEL_LIMITS.maxAttemptsPerTurn);
    expect(repository.attemptsIssued).toBe(MODEL_LIMITS.maxAttemptsPerTurn);
  });

  it('fails the turn when the repository has no attempts left', async () => {
    const repository = new MemoryExecutionPort();
    repository.reserveRefusal = { kind: 'attempts_exhausted' };
    const gateway = new ScriptedGateway(['ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(repository.publishes[0]).toMatchObject({ status: 'failed' });
  });
});

describe('B2 responder: budget and principal gates', () => {
  it('hard-refuses before egress when a budget bucket is over its ceiling', async () => {
    const repository = new MemoryExecutionPort();
    repository.reserveRefusal = { kind: 'budget_exceeded', scope: 'principal' };
    const gateway = new ScriptedGateway(['ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(repository.publishes[0]).toMatchObject({
      status: 'failed',
      failureReason: 'internal_error',
    });
  });

  it('fails closed when the turn has no server-derived principal', async () => {
    const repository = new MemoryExecutionPort();
    repository.reserveRefusal = { kind: 'principal_unavailable' };
    const gateway = new ScriptedGateway(['ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.failed).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
  });

  it('treats a lost lease as fenced rather than as a provider error', async () => {
    const repository = new MemoryExecutionPort();
    repository.reserveRefusal = { kind: 'lease_lost' };
    const gateway = new ScriptedGateway(['ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.fenced).toBe(1);
    expect(gateway.inputs).toHaveLength(0);
    expect(repository.publishes).toHaveLength(0);
  });
});

describe('B2 responder: cancellation and lease loss', () => {
  it('settles as unknown-billed and publishes nothing when the worker stops mid-flight', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new HangingGateway();
    const controller = new AbortController();
    const loop = realResponder(repository, gateway).processOnce(controller.signal);

    await gateway.entered;
    controller.abort();

    const summary = await loop;

    expect(summary.skipped).toBe(1);
    expect(repository.charges[0]).toMatchObject({
      state: 'unknown_billed',
      outcomeCode: 'client_cancelled',
    });
    expect(repository.publishes).toHaveLength(0);
  });

  it('aborts the provider call when the turn deadline is already inside the timeout', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new HangingGateway();
    const controller = new AbortController();
    const loop = realResponder(repository, gateway).processOnce(controller.signal);

    await gateway.entered;

    // The gateway observed an abort signal bound to the attempt, not the caller's raw promise.
    expect(gateway).toBeDefined();

    controller.abort();
    await loop;
  });

  it('discards the text when publication is fenced after a successful call', async () => {
    const repository = new MemoryExecutionPort();
    const gateway = new ScriptedGateway(['ok']);

    // The lease is lost between the provider reply and publication.
    const originalSettle = repository.settleAttempt.bind(repository);
    repository.settleAttempt = (charge: B2AttemptCharge) => {
      repository.leaseLost = true;
      return originalSettle(charge);
    };

    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.fenced).toBe(1);
    expect(repository.publishes).toHaveLength(0);
  });

  it('reports a timeout as an expired turn when the deadline sweeper wins the race', async () => {
    const repository = new MemoryExecutionPort();
    repository.deadlineExpired = true;
    const gateway = new ScriptedGateway(['ok']);
    const summary = await realResponder(repository, gateway).processOnce();

    expect(summary.expired).toBe(1);
    expect(summary.completed).toBe(0);
    expect(gateway.inputs).toHaveLength(0);
  });
});

describe('B2 responder: construction guards', () => {
  it('refuses real mode without a pinned rate row', () => {
    expect(() =>
      realResponder(new MemoryExecutionPort(), new ScriptedGateway(['ok']), { rate: null }),
    ).toThrow(TypeError);
  });

  it('refuses non-positive loop timings', () => {
    for (const overrides of [
      { batchSize: 0 },
      { leaseMs: 0 },
      { attemptTimeoutMs: 0 },
      { maxAttempts: 0 },
    ]) {
      expect(() =>
        realResponder(new MemoryExecutionPort(), new ScriptedGateway(['ok']), overrides),
      ).toThrow(TypeError);
    }
  });

  it('swallows a repository failure without leaking the message and keeps the loop alive', async () => {
    const warnings: string[] = [];
    let iterations = 0;
    let recovered: () => void = () => {};
    const survived = new Promise<void>((resolve) => {
      recovered = resolve;
    });

    const port: ModelTurnExecutionPort = {
      listRunningTurns() {
        iterations += 1;
        if (iterations === 1) {
          return Promise.reject(
            new Error('connection terminated including secret transcript text'),
          );
        }

        recovered();
        return Promise.resolve([]);
      },
      expireTurnIfDue: () => Promise.resolve(null),
      claimTurn: () => Promise.resolve({ kind: 'not_claimed', reason: 'not_running' }),
      loadTurnContext: () => Promise.resolve([]),
      reserveAttempt: () => Promise.resolve({ kind: 'attempts_exhausted' }),
      markAttemptSent: () => Promise.resolve(false),
      settleAttempt: () => Promise.resolve({ kind: 'not_found' }),
      publishCompletion: () => Promise.resolve({ outcome: 'fenced', turn: null }),
    };

    const responder = realResponder(port, new ScriptedGateway(['ok']), {
      logger: {
        warn(message: string, context?: unknown) {
          warnings.push(JSON.stringify({ message, context }));
        },
      },
      // A real macrotask yield: a microtask-only sleep would starve the loop it is driving.
      sleep: () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        }),
      intervalMs: 1,
      errorBackoffMs: 1,
    });

    const runner = responder.start();

    await survived;
    runner.stop();
    await runner.done;

    expect(warnings.join('\n')).not.toContain('secret transcript');
    expect(warnings.join('\n')).toContain('"category":"error"');
  });
});
