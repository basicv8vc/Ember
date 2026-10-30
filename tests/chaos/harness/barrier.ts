import { withTimeout } from './timeout.js';

/**
 * Deterministic synchronization primitives for chaos and concurrency testing.
 * Replaces non-deterministic sleeps with deterministic synchronization points.
 */

export interface Latch {
  countDown(): void;
  wait(timeoutMs?: number, description?: string): Promise<void>;
  isResolved(): boolean;
  getCount(): number;
}

export function createLatch(initialCount = 1): Latch {
  let count = initialCount;
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });

  if (count <= 0) {
    resolveFn?.();
  }

  return {
    countDown() {
      if (count > 0) {
        count--;
        if (count === 0) {
          resolveFn?.();
        }
      }
    },
    wait(timeoutMs = 10_000, description = 'Latch.wait') {
      if (count <= 0) {
        return Promise.resolve();
      }
      return withTimeout(promise, timeoutMs, description);
    },
    isResolved() {
      return count <= 0;
    },
    getCount() {
      return count;
    },
  };
}

export interface Barrier {
  readonly participants: number;
  wait(timeoutMs?: number, description?: string): Promise<void>;
  reset(): void;
}

export function createBarrier(participants: number, name = 'Barrier'): Barrier {
  if (participants <= 0) {
    throw new Error('Barrier participants must be > 0');
  }

  let arrived = 0;
  let generationResolve: (() => void) | undefined;
  let generationPromise = new Promise<void>((resolve) => {
    generationResolve = resolve;
  });

  return {
    participants,
    async wait(timeoutMs = 10_000, description = `${name}.wait`): Promise<void> {
      const currentPromise = generationPromise;
      arrived++;

      if (arrived === participants) {
        // All participants have arrived; release current generation
        const toResolve = generationResolve;
        arrived = 0;
        generationPromise = new Promise<void>((resolve) => {
          generationResolve = resolve;
        });
        toResolve?.();
        return;
      }

      await withTimeout(
        currentPromise,
        timeoutMs,
        `${description} (waiting for ${participants - arrived} more participants)`,
      );
    },
    reset() {
      arrived = 0;
      generationPromise = new Promise<void>((resolve) => {
        generationResolve = resolve;
      });
    },
  };
}

export interface SyncPoint {
  readonly name: string;
  /** Called by the intercepted code: signals arrival and waits for release. */
  reach(timeoutMs?: number): Promise<void>;
  /** Called by the test driver: waits until the intercepted code has arrived. */
  waitForArrival(timeoutMs?: number): Promise<void>;
  /** Called by the test driver: releases the intercepted code to continue. */
  release(): void;
  /** Whether the intercepted code is currently waiting at this point. */
  hasArrived(): boolean;
}

export function createSyncPoint(name: string): SyncPoint {
  const arrivedLatch = createLatch(1);
  const releaseLatch = createLatch(1);

  return {
    name,
    async reach(timeoutMs = 10_000): Promise<void> {
      arrivedLatch.countDown();
      await releaseLatch.wait(timeoutMs, `SyncPoint[${name}].release`);
    },
    async waitForArrival(timeoutMs = 10_000): Promise<void> {
      await arrivedLatch.wait(timeoutMs, `SyncPoint[${name}].waitForArrival`);
    },
    release(): void {
      releaseLatch.countDown();
    },
    hasArrived(): boolean {
      return arrivedLatch.isResolved();
    },
  };
}
