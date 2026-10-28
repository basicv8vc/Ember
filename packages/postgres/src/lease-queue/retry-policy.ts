import { InvalidArgumentError } from '@ember/domain';
import type { RetryPolicyConfig } from './config.js';

/** Maximum exponent used before cap clamping; keeps arithmetic bounded. */
const MAX_BACKOFF_EXPONENT = 30;

function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new InvalidArgumentError([{ path: 'attempt', code: 'invalid_attempt' }]);
  }
}

/**
 * Delay before the retry *after* `attempt` failed.
 *
 * attempt 1 → base, attempt 2 → 2×base, … capped at `capDelayMs`. P0 deliberately has no
 * jitter; see the note on `RetryPolicyConfig`.
 */
export function retryDelayMs(policy: RetryPolicyConfig, attempt: number): number {
  assertAttempt(attempt);

  const exponent = Math.min(attempt - 1, MAX_BACKOFF_EXPONENT);
  const exponential = policy.baseDelayMs * 2 ** exponent;

  return Math.min(policy.capDelayMs, exponential);
}

export interface RetryPlanInput {
  readonly policy: RetryPolicyConfig;
  /** Stable clock value for this decision. */
  readonly now: Date;
  /** The attempt that just failed (already counted in `tasks.attempt_count`). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly deadlineAt: Date | null;
}

export type RetryPlan =
  | { readonly retry: true; readonly nextRunAt: Date; readonly delayMs: number }
  | {
      readonly retry: false;
      readonly reason: 'attempts_exhausted' | 'deadline_reached';
    };

/**
 * Pure bounded-retry decision shared by Finish and the Reaper.
 *
 * A retry is scheduled only when a new attempt remains and the computed `next_run_at`
 * is strictly before the deadline. The deadline itself is never extended.
 */
export function planRetry(input: RetryPlanInput): RetryPlan {
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new InvalidArgumentError([{ path: 'maxAttempts', code: 'invalid_max_attempts' }]);
  }

  if (input.attempt >= input.maxAttempts) {
    return { retry: false, reason: 'attempts_exhausted' };
  }

  if (input.deadlineAt !== null && input.now.getTime() >= input.deadlineAt.getTime()) {
    return { retry: false, reason: 'deadline_reached' };
  }

  const delayMs = retryDelayMs(input.policy, input.attempt);
  const nextRunAt = new Date(input.now.getTime() + delayMs);

  if (input.deadlineAt !== null && nextRunAt.getTime() >= input.deadlineAt.getTime()) {
    return { retry: false, reason: 'deadline_reached' };
  }

  return { retry: true, nextRunAt, delayMs };
}
