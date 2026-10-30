import { describe, expect, it } from 'vitest';
import type { LeasedRun, RunTerminalStatus } from '@ember/domain';
import { loadWorkerConfig, WorkerConfigError } from '../../apps/worker/src/config.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { runPollLoop } from '../../apps/worker/src/poll-loop.js';
import type { RunHandlerCompletion } from '../../apps/worker/src/run-handler.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-28T00:00:00.000Z');
const IDLE_MS = 10;
const HEARTBEAT_MS = 5;

function leasedRun(index: number): LeasedRun {
  const suffix = String(index).padStart(2, '0');
  return {
    tenantId: TENANT,
    taskId: `00000000-0000-4000-8000-0000000000${suffix}`,
    runId: `11111111-0000-4000-8000-0000000000${suffix}`,
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: '2026-10-28T00:00:30.000Z',
  };
}

interface HarnessOptions {
  readonly runs?: readonly LeasedRun[];
  /** Runs that become claimable only once the first execution is already in flight. */
  readonly lateRuns?: readonly LeasedRun[];
  readonly heartbeatResult?: boolean;
  readonly finishResult?: boolean;
  readonly finishThrows?: boolean;
  readonly claimThrows?: boolean;
  readonly outcome?: RunTerminalStatus;
  readonly handlerError?: Error;
  /** Block the handler until it is released or the execution signal aborts. */
  readonly block?: boolean;
}

interface Build {
  readonly queue: {
    claimNext: (workerId: string, now: Date) => Promise<LeasedRun | null>;
    heartbeat: (run: LeasedRun, now: Date) => Promise<boolean>;
    finish: (run: LeasedRun, outcome: RunTerminalStatus) => Promise<boolean>;
  };
  readonly handler: {
    handle: (run: LeasedRun, signal: AbortSignal) => Promise<RunHandlerCompletion>;
  };
  readonly signal: AbortSignal;
  readonly lines: string[];
  readonly finishes: { runId: string; outcome: RunTerminalStatus }[];
  readonly heartbeats: string[];
  readonly waits: number[];
  readonly active: { current: number; max: number };
  /** Run ids whose handler actually started, in order. */
  readonly entered: string[];
  readonly stop: () => void;
  readonly release: () => void;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function harness(options: HarnessOptions = {}): Build {
  const lines: string[] = [];
  const finishes: { runId: string; outcome: RunTerminalStatus }[] = [];
  const heartbeats: string[] = [];
  const waits: number[] = [];
  const active = { current: 0, max: 0 };
  const entered: string[] = [];
  const pending = [...(options.runs ?? [leasedRun(1)])];
  const stopController = new AbortController();

  let release = (): void => undefined;
  let lateDelivered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queue = {
    claimNext: (): Promise<LeasedRun | null> => {
      if (options.claimThrows === true) {
        return Promise.reject(new Error('claim failed'));
      }

      const next = pending.shift() ?? null;

      // The extra Runs arrive only once the queue has already been observed as empty, which is
      // the only way to prove the loop re-polls instead of parking on in-flight executions.
      if (next === null && options.lateRuns !== undefined && !lateDelivered) {
        lateDelivered = true;
        pending.push(...options.lateRuns);
      }

      return Promise.resolve(next);
    },
    heartbeat: (run: LeasedRun): Promise<boolean> => {
      heartbeats.push(run.runId);
      return Promise.resolve(options.heartbeatResult ?? true);
    },
    finish: (run: LeasedRun, outcome: RunTerminalStatus): Promise<boolean> => {
      if (options.finishThrows === true) {
        return Promise.reject(new Error('finish failed'));
      }
      finishes.push({ runId: run.runId, outcome });
      return Promise.resolve(options.finishResult ?? true);
    },
  };

  const handler = {
    handle: async (run: LeasedRun, signal: AbortSignal): Promise<RunHandlerCompletion> => {
      active.current += 1;
      active.max = Math.max(active.max, active.current);
      entered.push(run.runId);

      try {
        if (options.block === true) {
          // A real handler stops working when its signal aborts; the fake must as well,
          // otherwise the loop could never drain.
          await Promise.race([gate, waitForAbort(signal)]);
        }

        if (options.handlerError !== undefined) {
          throw options.handlerError;
        }

        return { type: 'finish', outcome: options.outcome ?? 'succeeded' } as const;
      } finally {
        active.current -= 1;
      }
    },
  };

  return {
    queue,
    handler,
    signal: stopController.signal,
    lines,
    finishes,
    heartbeats,
    waits,
    active,
    entered,
    stop: () => stopController.abort(),
    release: () => release(),
  };
}

/** Run the loop with an injected sleeper so no test ever waits on a wall clock. */
async function run(
  build: Build,
  options: {
    readonly concurrency?: number;
    readonly onWait?: (ms: number, times: number) => void;
    /** Replace the default "resolve immediately" wait (still counted and reported). */
    readonly sleeper?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<Awaited<ReturnType<typeof runPollLoop>>> {
  const logger = createWorkerLogger({
    level: 'debug',
    sink: (_level, line) => build.lines.push(line),
    now: () => new Date(NOW.getTime()),
  });
  let calls = 0;

  const record = (ms: number): void => {
    calls += 1;
    build.waits.push(ms);
    options.onWait?.(ms, calls);
  };

  return runPollLoop({
    queue: build.queue,
    handler: build.handler,
    clock: { now: () => new Date(NOW.getTime()) },
    workerId: 'worker-test',
    concurrency: options.concurrency ?? 1,
    heartbeatIntervalMs: HEARTBEAT_MS,
    idleIntervalMs: IDLE_MS,
    errorBackoffMs: 20,
    logger,
    signal: build.signal,
    sleep: (ms, signal) => {
      record(ms);
      return options.sleeper === undefined ? Promise.resolve() : options.sleeper(ms, signal);
    },
  });
}

describe('poll loop', () => {
  it('claims, executes and finishes one Run', async () => {
    const build = harness();

    const summary = await run(build, { onWait: (ms) => ms === IDLE_MS && build.stop() });

    expect(summary).toEqual({
      claimed: 1,
      finished: 1,
      rejectedFinishes: 0,
      abandoned: 0,
      committed: 0,
    });
    expect(build.finishes).toEqual([{ runId: leasedRun(1).runId, outcome: 'succeeded' }]);
  });

  it('renews the lease while the execution is in flight', async () => {
    const build = harness({ block: true });

    const summary = await run(build, {
      onWait: (ms, times) => {
        if (ms === HEARTBEAT_MS && times >= 3) {
          build.release();
        }
        if (ms === IDLE_MS) {
          build.stop();
        }
      },
    });

    expect(build.heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(summary.finished).toBe(1);
  });

  it('releases the execution slot without waiting for another heartbeat interval', async () => {
    // A heartbeat wait that only a cancellation can end: if the loop kept waiting for the next
    // tick after `finish()`, this test would time out instead of completing.
    const build = harness();
    let interruptedByAbort = false;

    const summary = await run(build, {
      sleeper: (ms, signal) => {
        if (ms !== HEARTBEAT_MS) {
          return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
          const done = (): void => {
            interruptedByAbort = true;
            resolve();
          };

          if (signal?.aborted === true) {
            done();
            return;
          }

          signal?.addEventListener('abort', done, { once: true });
        });
      },
      onWait: (ms) => {
        if (ms === IDLE_MS) {
          build.stop();
        }
      },
    });

    expect(summary).toEqual({
      claimed: 1,
      finished: 1,
      rejectedFinishes: 0,
      abandoned: 0,
      committed: 0,
    });
    expect(interruptedByAbort).toBe(true);
    // The Run finished instantly, so no renewal was ever due.
    expect(build.heartbeats).toEqual([]);
  });

  it('claims newly arrived work while another execution is still in flight', async () => {
    const build = harness({ runs: [leasedRun(1)], lateRuns: [leasedRun(2)], block: true });
    let idlePolls = 0;

    const summary = await run(build, {
      // One slot stays free after both claims, so the loop must poll the empty queue rather
      // than park on the in-flight executions.
      concurrency: 3,
      onWait: (ms) => {
        if (ms !== IDLE_MS) {
          return;
        }
        idlePolls += 1;
        if (idlePolls >= 3) {
          build.stop();
        }
      },
    });

    // Both Runs started although neither could finish: the second claim happened while the
    // first execution still occupied its slot, instead of after it completed.
    expect(build.entered).toEqual([leasedRun(1).runId, leasedRun(2).runId]);
    expect(summary.claimed).toBe(2);
    expect(summary.finished).toBe(0);
    expect(summary.abandoned).toBe(2);
    expect(build.waits.filter((ms) => ms === IDLE_MS).length).toBeGreaterThan(0);
  });

  it('abandons the execution and never finishes when the heartbeat is lost', async () => {
    const build = harness({ block: true, heartbeatResult: false });

    const summary = await run(build, { onWait: (ms) => ms === IDLE_MS && build.stop() });

    expect(summary.claimed).toBe(1);
    expect(summary.abandoned).toBe(1);
    expect(summary.finished).toBe(0);
    expect(build.finishes).toEqual([]);
    expect(build.lines.join('\n')).toContain('result discarded');
  });

  it('logs a single rejection and never retries a fenced finish', async () => {
    const build = harness({ finishResult: false });

    const summary = await run(build, { onWait: (ms) => ms === IDLE_MS && build.stop() });

    expect(summary.rejectedFinishes).toBe(1);
    expect(summary.finished).toBe(0);
    expect(build.finishes).toHaveLength(1);
    expect(build.lines.join('\n')).toContain('lease no longer valid');
  });

  it('counts a throwing finish as rejected and logs it once', async () => {
    const build = harness({ finishThrows: true });

    const summary = await run(build, { onWait: (ms) => ms === IDLE_MS && build.stop() });

    expect(summary.rejectedFinishes).toBe(1);
    expect(build.lines.join('\n')).toContain('finish failed');
  });

  it('abandons a Run whose handler reports a stale or foreign context', async () => {
    const build = harness({ handlerError: new Error('stale lease') });

    const summary = await run(build, { onWait: (ms) => ms === IDLE_MS && build.stop() });

    expect(summary.abandoned).toBe(1);
    expect(build.finishes).toEqual([]);
    expect(build.lines.join('\n')).toContain('run execution abandoned');
  });

  it('stops claiming and drains in-flight work on shutdown', async () => {
    const build = harness({ runs: [leasedRun(1), leasedRun(2)], block: true });

    const summary = await run(build, {
      concurrency: 2,
      onWait: () => {
        // Shut down while executions are still in flight.
        build.stop();
      },
    });

    expect(build.finishes).toEqual([]);
    expect(build.active.current).toBe(0);
    expect(summary.claimed).toBeLessThanOrEqual(2);
  });

  it('never runs more than the configured number of executions at once', async () => {
    const build = harness({ runs: [leasedRun(1), leasedRun(2), leasedRun(3)], block: true });

    const summary = await run(build, {
      concurrency: 2,
      onWait: (ms) => {
        if (ms === HEARTBEAT_MS) {
          build.release();
        }
        if (ms === IDLE_MS) {
          build.stop();
        }
      },
    });

    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    expect(build.active.max).toBeLessThanOrEqual(2);
  });

  it('backs off with a bounded delay and keeps going after a failed claim', async () => {
    const build = harness({ claimThrows: true });

    const summary = await run(build, {
      onWait: (ms, times) => {
        if (times >= 2) {
          build.stop();
        }
        expect(ms).toBeGreaterThan(0);
      },
    });

    expect(summary.claimed).toBe(0);
    expect(summary.finished).toBe(0);
    expect(build.lines.join('\n')).toContain('claim failed');
  });

  it('rejects an invalid concurrency', async () => {
    const build = harness();

    await expect(run(build, { concurrency: 0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
describe('poll worker configuration guards', () => {
  it('refuses poll mode unless simulated execution is explicitly local-only', () => {
    expect(() => loadWorkerConfig({ EMBER_WORKER_MODE: 'poll' })).toThrow(WorkerConfigError);
    expect(() =>
      loadWorkerConfig({
        EMBER_WORKER_MODE: 'poll',
        EMBER_WORKER_SIMULATED_EXECUTION: 'disabled',
      }),
    ).toThrow(WorkerConfigError);
  });

  it('refuses simulated execution in production', () => {
    expect(() =>
      loadWorkerConfig({
        EMBER_ENV: 'production',
        EMBER_WORKER_MODE: 'poll',
        EMBER_WORKER_SIMULATED_EXECUTION: 'local-only',
      }),
    ).toThrow(WorkerConfigError);
  });

  it('accepts a bounded local poll worker', () => {
    const config = loadWorkerConfig({
      EMBER_ENV: 'local',
      EMBER_WORKER_MODE: 'poll',
      EMBER_WORKER_SIMULATED_EXECUTION: 'local-only',
      EMBER_WORKER_CONCURRENCY: '2',
    });

    expect(config.mode).toBe('poll');
    expect(config.env).toBe('local');
    expect(config.simulatedExecution).toBe('local-only');
    expect(config.concurrency).toBe(2);
  });

  it('defaults to a reaper-only worker with simulated execution disabled', () => {
    const config = loadWorkerConfig({});

    expect(config.mode).toBe('reaper-only');
    expect(config.simulatedExecution).toBe('disabled');
    expect(config.concurrency).toBe(4);
  });

  it('rejects an out-of-range concurrency', () => {
    expect(() => loadWorkerConfig({ EMBER_WORKER_CONCURRENCY: '0' })).toThrow(WorkerConfigError);
    expect(() => loadWorkerConfig({ EMBER_WORKER_CONCURRENCY: '17' })).toThrow(WorkerConfigError);
    expect(() => loadWorkerConfig({ EMBER_WORKER_CONCURRENCY: '1.5' })).toThrow(WorkerConfigError);
  });
});

describe('P0B-08b budget policy configuration', () => {
  it('defaults to the reviewed simulated policy', () => {
    const { budget } = loadWorkerConfig({});

    expect(budget).toEqual({
      policyId: 'p0b08b-simulated-v1',
      policyVersion: 1,
      maxRunSteps: 8,
      maxRunUnits: 100,
      maxRunElapsedMs: 120_000,
      maxTenantDailyUnits: 5_000,
      maxConcurrentSlots: 8,
    });
    // The ledger receives a frozen value, so a later caller cannot widen a shipped limit.
    expect(Object.isFrozen(budget)).toBe(true);
  });

  it('accepts explicit limits, including a zero that fails closed', () => {
    const { budget } = loadWorkerConfig({
      EMBER_WORKER_BUDGET_POLICY_ID: 'tenant-a-policy',
      EMBER_WORKER_BUDGET_POLICY_VERSION: '7',
      EMBER_WORKER_BUDGET_MAX_RUN_STEPS: '0',
      EMBER_WORKER_BUDGET_MAX_RUN_UNITS: '0',
      EMBER_WORKER_BUDGET_MAX_RUN_ELAPSED_MS: '0',
      EMBER_WORKER_BUDGET_MAX_TENANT_DAILY_UNITS: '0',
      EMBER_WORKER_BUDGET_MAX_CONCURRENT_SLOTS: '0',
    });

    expect(budget).toEqual({
      policyId: 'tenant-a-policy',
      policyVersion: 7,
      maxRunSteps: 0,
      maxRunUnits: 0,
      maxRunElapsedMs: 0,
      maxTenantDailyUnits: 0,
      maxConcurrentSlots: 0,
    });
  });

  it('rejects limits that could not be enforced exactly', () => {
    for (const value of ['-1', '1.5', 'many']) {
      expect(() => loadWorkerConfig({ EMBER_WORKER_BUDGET_MAX_RUN_UNITS: value })).toThrow(
        WorkerConfigError,
      );
    }

    expect(() => loadWorkerConfig({ EMBER_WORKER_BUDGET_POLICY_VERSION: '-1' })).toThrow(
      WorkerConfigError,
    );
    expect(() => loadWorkerConfig({ EMBER_WORKER_BUDGET_POLICY_ID: '' })).toThrow(
      WorkerConfigError,
    );
    expect(() => loadWorkerConfig({ EMBER_WORKER_BUDGET_POLICY_ID: 'x'.repeat(129) })).toThrow(
      WorkerConfigError,
    );
  });
});
