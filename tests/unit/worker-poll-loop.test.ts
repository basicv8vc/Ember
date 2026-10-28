import { describe, expect, it } from 'vitest';
import type { LeasedRun, RunTerminalStatus } from '@ember/domain';
import { loadWorkerConfig, WorkerConfigError } from '../../apps/worker/src/config.js';
import { createWorkerLogger } from '../../apps/worker/src/logger.js';
import { runPollLoop } from '../../apps/worker/src/poll-loop.js';

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
    handle: (run: LeasedRun, signal: AbortSignal) => Promise<RunTerminalStatus>;
  };
  readonly signal: AbortSignal;
  readonly lines: string[];
  readonly finishes: { runId: string; outcome: RunTerminalStatus }[];
  readonly heartbeats: string[];
  readonly waits: number[];
  readonly active: { current: number; max: number };
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
  const pending = [...(options.runs ?? [leasedRun(1)])];
  const stopController = new AbortController();

  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queue = {
    claimNext: (): Promise<LeasedRun | null> => {
      if (options.claimThrows === true) {
        return Promise.reject(new Error('claim failed'));
      }
      return Promise.resolve(pending.shift() ?? null);
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
    handle: async (_run: LeasedRun, signal: AbortSignal): Promise<RunTerminalStatus> => {
      active.current += 1;
      active.max = Math.max(active.max, active.current);

      try {
        if (options.block === true) {
          // A real handler stops working when its signal aborts; the fake must as well,
          // otherwise the loop could never drain.
          await Promise.race([gate, waitForAbort(signal)]);
        }

        if (options.handlerError !== undefined) {
          throw options.handlerError;
        }

        return options.outcome ?? 'succeeded';
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
  } = {},
): Promise<Awaited<ReturnType<typeof runPollLoop>>> {
  const logger = createWorkerLogger({
    level: 'debug',
    sink: (_level, line) => build.lines.push(line),
    now: () => new Date(NOW.getTime()),
  });
  let calls = 0;

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
    sleep: (ms) => {
      calls += 1;
      build.waits.push(ms);
      options.onWait?.(ms, calls);
      return Promise.resolve();
    },
  });
}

describe('poll loop', () => {
  it('claims, executes and finishes one Run', async () => {
    const build = harness();

    const summary = await run(build, { onWait: (ms) => ms === IDLE_MS && build.stop() });

    expect(summary).toEqual({ claimed: 1, finished: 1, rejectedFinishes: 0, abandoned: 0 });
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
