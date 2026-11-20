import http from 'node:http';

export type D1FaultMode =
  'healthy' | 'unavailable' | 'uncertain_timeout_committed' | 'uncertain_timeout_aborted';

export type GlobalBudgetFaultMode =
  | 'healthy'
  | 'unavailable'
  | 'timeout'
  | 'grant_expired'
  | 'halt_day_ceiling_exceeded'
  | 'halt_reservation_exceeded'
  | 'halt_usage_missing'
  | 'conflict_payload';

export type CrashHookPoint =
  | 'none'
  | 'after_do_pending_before_d1'
  | 'after_d1_before_confirm'
  | 'after_prepare_before_mark_sent'
  | 'after_mark_sent_before_provider_fetch'
  | 'after_do_commit_before_queue_send'
  | 'after_queue_send_before_outbox_update'
  | 'after_claim_before_send'
  | 'after_claim_before_commit'
  | 'after_commit_before_queue_ack'
  | 'alarm_exhaust_6_retries';

export type ForgedEnvelopePreset =
  | 'budget_sync_in_queue'
  | 'null_queue_name'
  | 'wrong_tenant'
  | 'wrong_agent'
  | 'wrong_queue'
  | 'future_fence_epoch'
  | 'stale_fence_epoch';

export interface CanonicalV2DispatchEnvelope {
  readonly schemaVersion: 2;
  readonly eventId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly entityKind: 'turn' | 'task' | 'schedule_occurrence' | 'handoff';
  readonly entityId: string;
  readonly queueName: 'durable_turn' | 'agent_task';
  readonly fenceEpoch: number;
}

export interface FaultInjectionState {
  readonly d1Mode: D1FaultMode;
  readonly d1DelayMs: number;
  readonly globalBudgetMode: GlobalBudgetFaultMode;
  readonly queueDuplicateCount: number;
  readonly queueForceDlq: boolean;
  readonly crashPoint: CrashHookPoint;
  readonly alarmFailRemaining: number;
  readonly virtualNowMs: number | null;
}

export interface DstTransitionFixture {
  readonly id: 'spring_forward_2026_ny' | 'fall_back_2026_ny';
  readonly timezone: 'America/New_York';
  readonly cronLocalTime: string;
  readonly beforeTransitionUtcMs: number;
  readonly afterTransitionUtcMs: number;
  readonly expectedSingleFireUtcMs: number;
}

export const DST_TRANSITION_FIXTURES: Readonly<
  Record<DstTransitionFixture['id'], DstTransitionFixture>
> = Object.freeze({
  spring_forward_2026_ny: {
    id: 'spring_forward_2026_ny',
    timezone: 'America/New_York',
    cronLocalTime: '30 2 * * *', // 02:30 local skipped on 2026-03-08 -> fires at 03:00 EDT (07:00Z)
    beforeTransitionUtcMs: Date.parse('2026-03-08T06:55:00.000Z'), // 01:55 EST
    afterTransitionUtcMs: Date.parse('2026-03-08T07:05:00.000Z'), // 03:05 EDT
    expectedSingleFireUtcMs: Date.parse('2026-03-08T07:00:00.000Z'),
  },
  fall_back_2026_ny: {
    id: 'fall_back_2026_ny',
    timezone: 'America/New_York',
    cronLocalTime: '30 1 * * *', // 01:30 local occurs twice on 2026-11-01 -> fires once on first 01:30 EDT (05:30Z)
    beforeTransitionUtcMs: Date.parse('2026-11-01T05:25:00.000Z'), // 01:25 EDT
    afterTransitionUtcMs: Date.parse('2026-11-01T06:35:00.000Z'), // 01:35 EST
    expectedSingleFireUtcMs: Date.parse('2026-11-01T05:30:00.000Z'),
  },
});

export interface ConcurrentRaceOutcome<T> {
  readonly index: number;
  readonly status: 'fulfilled' | 'rejected';
  readonly value?: T;
  readonly reason?: string;
  readonly durationMs: number;
}

/**
 * Deterministic Fault Injection, Virtual/DST Clock, Forged Envelope Builder, and Concurrency Racer
 * for V2 M1 integration & acceptance tests.
 */
export class V2FaultInjector {
  #state: FaultInjectionState = {
    d1Mode: 'healthy',
    d1DelayMs: 0,
    globalBudgetMode: 'healthy',
    queueDuplicateCount: 1,
    queueForceDlq: false,
    crashPoint: 'none',
    alarmFailRemaining: 0,
    virtualNowMs: null,
  };
  #oneShotCrashQueue: CrashHookPoint[] = [];
  #controlServer: http.Server | null = null;
  #controlUrl: string | null = null;

  getState(): FaultInjectionState {
    return { ...this.#state };
  }

  get controlUrl(): string | null {
    return this.#controlUrl;
  }

  reset(): void {
    this.#state = {
      d1Mode: 'healthy',
      d1DelayMs: 0,
      globalBudgetMode: 'healthy',
      queueDuplicateCount: 1,
      queueForceDlq: false,
      crashPoint: 'none',
      alarmFailRemaining: 0,
      virtualNowMs: null,
    };
    this.#oneShotCrashQueue = [];
  }

  setD1Fault(mode: D1FaultMode, delayMs = 0): void {
    this.#state = { ...this.#state, d1Mode: mode, d1DelayMs: Math.max(0, Math.trunc(delayMs)) };
  }

  setGlobalBudgetFault(mode: GlobalBudgetFaultMode): void {
    this.#state = { ...this.#state, globalBudgetMode: mode };
  }

  setQueueFault(opts: { readonly duplicateCount?: number; readonly forceDlq?: boolean }): void {
    this.#state = {
      ...this.#state,
      ...(opts.duplicateCount !== undefined
        ? { queueDuplicateCount: Math.max(1, Math.trunc(opts.duplicateCount)) }
        : {}),
      ...(opts.forceDlq !== undefined ? { queueForceDlq: opts.forceDlq } : {}),
    };
  }

  setCrashPoint(crashPoint: CrashHookPoint, oneShot = false): void {
    if (oneShot && crashPoint !== 'none') {
      this.#oneShotCrashQueue.push(crashPoint);
      return;
    }
    this.#state = { ...this.#state, crashPoint };
  }

  setAlarmExhaustion(failCount = 6): void {
    this.#state = {
      ...this.#state,
      crashPoint: 'alarm_exhaust_6_retries',
      alarmFailRemaining: Math.max(0, Math.trunc(failCount)),
    };
  }

  setVirtualNowMs(nowMs: number | null): void {
    this.#state = { ...this.#state, virtualNowMs: nowMs };
  }

  advanceVirtualNowMs(deltaMs: number): number {
    const base = this.#state.virtualNowMs ?? Date.now();
    const next = base + deltaMs;
    this.#state = { ...this.#state, virtualNowMs: next };
    return next;
  }

  consumeCrashPoint(hook: CrashHookPoint): boolean {
    if (this.#oneShotCrashQueue[0] === hook) {
      this.#oneShotCrashQueue.shift();
      return true;
    }
    if (this.#state.crashPoint === hook) {
      this.#state = { ...this.#state, crashPoint: 'none' };
      return true;
    }
    return false;
  }

  consumeAlarmFailure(): boolean {
    if (this.#state.alarmFailRemaining > 0) {
      this.#state = {
        ...this.#state,
        alarmFailRemaining: this.#state.alarmFailRemaining - 1,
      };
      return true;
    }
    return false;
  }

  /**
   * Build deterministic invalid/forged queue envelopes for FI-05 and F-22 validation.
   */
  buildForgedEnvelope(
    valid: CanonicalV2DispatchEnvelope,
    preset: ForgedEnvelopePreset,
  ): Record<string, unknown> {
    switch (preset) {
      case 'budget_sync_in_queue':
        return { ...valid, entityKind: 'budget_sync', queueName: null };
      case 'null_queue_name':
        return { ...valid, queueName: null };
      case 'wrong_tenant':
        return { ...valid, tenantId: `${valid.tenantId}-forged` };
      case 'wrong_agent':
        return { ...valid, agentId: `${valid.agentId}-forged` };
      case 'wrong_queue':
        return {
          ...valid,
          queueName: valid.queueName === 'durable_turn' ? 'agent_task' : 'durable_turn',
        };
      case 'future_fence_epoch':
        return { ...valid, fenceEpoch: valid.fenceEpoch + 100 };
      case 'stale_fence_epoch':
        return { ...valid, fenceEpoch: Math.max(0, valid.fenceEpoch - 1) };
    }
  }

  /**
   * Run N concurrent operations through a synchronized Promise barrier to deterministically
   * exercise race conditions (F-1, F-2, F-3, F-13, F-17, budget contention).
   */
  async runConcurrentRace<T>(
    tasks: ReadonlyArray<() => Promise<T>>,
  ): Promise<readonly ConcurrentRaceOutcome<T>[]> {
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const pending = tasks.map(async (fn, index): Promise<ConcurrentRaceOutcome<T>> => {
      await barrier;
      const t0 = performance.now();
      try {
        const value = await fn();
        return {
          index,
          status: 'fulfilled',
          value,
          durationMs: Number((performance.now() - t0).toFixed(3)),
        };
      } catch (err) {
        return {
          index,
          status: 'rejected',
          reason: err instanceof Error ? err.message : String(err),
          durationMs: Number((performance.now() - t0).toFixed(3)),
        };
      }
    });

    // Ensure all tasks are parked at the barrier before releasing simultaneously.
    await Promise.resolve();
    releaseBarrier();
    return Promise.all(pending);
  }

  /**
   * Start a loopback HTTP fault control server so Workers inside `workerd` can inspect
   * active fault/clock state without modifying production business code.
   */
  async startControlServer(): Promise<string> {
    if (this.#controlServer !== null && this.#controlUrl !== null) {
      return this.#controlUrl;
    }

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && reqUrl.pathname === '/faults/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...this.#state,
            queuedCrashPoints: [...this.#oneShotCrashQueue],
            effectiveNowMs: this.#state.virtualNowMs ?? Date.now(),
          }),
        );
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/faults/consume-alarm') {
        const shouldFail = this.consumeAlarmFailure();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ shouldFail, remaining: this.#state.alarmFailRemaining }));
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/faults/consume-crash') {
        const hook = (reqUrl.searchParams.get('hook') ?? 'none') as CrashHookPoint;
        const shouldCrash = this.consumeCrashPoint(hook);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hook, shouldCrash }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to bind V2FaultInjector control server on loopback port');
    }
    this.#controlServer = server;
    this.#controlUrl = `http://127.0.0.1:${address.port}`;
    return this.#controlUrl;
  }

  async stopControlServer(): Promise<void> {
    const server = this.#controlServer;
    this.#controlServer = null;
    this.#controlUrl = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}
