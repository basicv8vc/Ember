import { InvalidArgumentError } from '@ember/domain';

/**
 * Single source of "now" for a LeaseQueue instance.
 *
 * Production uses `systemClock`; tests inject a deterministic manual clock. A lease
 * lifecycle must never mix `Date.now()`, database `now()` and a test clock without an
 * explicit reason, so every P0B-04 transaction receives its clock value from here.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
});

const MAX_CLOCK_YEAR = 9_999;

/**
 * Validate and copy a caller-supplied timestamp.
 *
 * Rejects invalid `Date` values and dates outside the PostgreSQL `timestamptz` range that
 * would otherwise surface as an opaque driver error.
 */
export function parseNow(value: Date, field = 'now'): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidArgumentError([{ path: field, code: 'invalid_date' }]);
  }

  const year = value.getUTCFullYear();

  if (year < 1 || year > MAX_CLOCK_YEAR) {
    throw new InvalidArgumentError([{ path: field, code: 'date_out_of_range' }]);
  }

  return new Date(value.getTime());
}
