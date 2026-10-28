import { describe, expect, it } from 'vitest';
import { DomainError } from '@ember/domain';
import { WorkerConfigError, loadWorkerConfig } from '../../apps/worker/src/config.js';
import { createWorkerLogger, type WorkerLogger } from '../../apps/worker/src/logger.js';
import { runReaperLoop, sleep } from '../../apps/worker/src/reaper-loop.js';

function captureLogger(): { logger: WorkerLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = createWorkerLogger({
    level: 'debug',
    sink: (_level, line) => lines.push(line),
    now: () => new Date('2026-10-28T00:00:00.000Z'),
  });
  return { logger, lines };
}

describe('worker configuration', () => {
  it('defaults to a reaper-only worker with bounded defaults', () => {
    const config = loadWorkerConfig({});

    expect(config.mode).toBe('reaper-only');
    expect(config.workerId).toBe('worker-local');
    expect(config.intervalMs).toBe(2_000);
    expect(config.errorBackoffMs).toBe(1_000);
    expect(config.lease.heartbeatIntervalMs).toBeLessThan(config.lease.leaseDurationMs);
  });

  it('rejects unsafe ids, unknown modes and inverted heartbeat/lease values', () => {
    expect(() => loadWorkerConfig({ EMBER_WORKER_ID: 'bad id' })).toThrow(WorkerConfigError);
    expect(() => loadWorkerConfig({ EMBER_WORKER_MODE: 'execute' })).toThrow(WorkerConfigError);
    expect(() =>
      loadWorkerConfig({
        EMBER_WORKER_MODE: 'poll',
        EMBER_WORKER_HEARTBEAT_MS: '30000',
        EMBER_WORKER_LEASE_MS: '30000',
      }),
    ).toThrow(WorkerConfigError);
  });
});

describe('reaper worker loop', () => {
  it('reaps until stopped and never claims a run', async () => {
    const { logger, lines } = captureLogger();
    const controller = new AbortController();
    let called = 0;

    await runReaperLoop({
      queue: {
        reapExpired: () => {
          called += 1;
          controller.abort();
          return Promise.resolve(1);
        },
      },
      clock: { now: () => new Date('2026-10-28T00:00:00.000Z') },
      intervalMs: 1_000,
      errorBackoffMs: 1_000,
      logger,
      signal: controller.signal,
    });

    expect(called).toBe(1);
    expect(lines.some((line) => line.includes('reaped expired leases'))).toBe(true);
  });

  it('backs off and logs a fixed domain code on failure, then stops', async () => {
    const { logger, lines } = captureLogger();
    const controller = new AbortController();
    let called = 0;

    await runReaperLoop({
      queue: {
        reapExpired: () => {
          called += 1;
          if (called === 1) {
            return Promise.reject(
              new DomainError('DB_UNAVAILABLE', 'injected secret-free failure'),
            );
          }
          controller.abort();
          return Promise.resolve(0);
        },
      },
      clock: { now: () => new Date('2026-10-28T00:00:00.000Z') },
      intervalMs: 10,
      errorBackoffMs: 10,
      logger,
      signal: controller.signal,
    });

    expect(called).toBe(2);
    const errorLine = lines.find((line) => line.includes('reaper tick failed'));
    expect(errorLine).toContain('DB_UNAVAILABLE');
    expect(errorLine).not.toContain('injected');
  });

  it('resolves an in-flight sleep as soon as the worker is stopped', async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
