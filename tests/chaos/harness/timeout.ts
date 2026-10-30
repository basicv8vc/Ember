/**
 * Explicit timeout wrapper for chaos testing operations.
 *
 * Prevents test hangs and provides descriptive error diagnostics when an unexpected
 * deadlock or synchronization stall occurs.
 */

export class ChaosTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly operationDescription: string;

  constructor(timeoutMs: number, operationDescription: string) {
    super(
      `Chaos operation timed out after ${timeoutMs}ms: "${operationDescription}". ` +
        `This indicates a synchronization deadlock, barrier stall, or unreleased lock.`,
    );
    this.name = 'ChaosTimeoutError';
    this.timeoutMs = timeoutMs;
    this.operationDescription = operationDescription;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationDescription: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ChaosTimeoutError(timeoutMs, operationDescription));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
