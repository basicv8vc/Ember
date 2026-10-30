import type { LatencyDistribution, TaskMix } from './types.js';

/**
 * Deterministic pseudo-random number generator (Mulberry32).
 * Fast, 32-bit state, excellent uniform distribution for reproducible benchmark workloads.
 */
export class DeterministicPrng {
  private state: number;

  constructor(seed: number = 42) {
    this.state = Math.floor(seed) | 0;
  }

  /** Return a pseudorandom float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Return a pseudorandom integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return Math.floor(this.next() * (hi - lo + 1)) + lo;
  }

  /** Pick a random item from an array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('cannot pick from an empty array');
    }
    const index = Math.floor(this.next() * items.length);
    return items[index]!;
  }
}

/**
 * Calculate percentiles, mean, min, max, and standard deviation for a numeric sample array.
 */
export function calculateDistribution(values: readonly number[]): LatencyDistribution {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      stdDevMs: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const minMs = sorted[0]!;
  const maxMs = sorted[count - 1]!;

  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const meanMs = sum / count;

  const variance =
    count > 1 ? sorted.reduce((acc, v) => acc + Math.pow(v - meanMs, 2), 0) / count : 0;
  const stdDevMs = Math.sqrt(variance);

  const percentile = (p: number): number => {
    if (count === 1) return sorted[0]!;
    const rank = (p / 100) * (count - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const weight = rank - lower;
    return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
  };

  return {
    count,
    minMs: Number(minMs.toFixed(2)),
    meanMs: Number(meanMs.toFixed(2)),
    p50Ms: Number(percentile(50).toFixed(2)),
    p90Ms: Number(percentile(90).toFixed(2)),
    p95Ms: Number(percentile(95).toFixed(2)),
    p99Ms: Number(percentile(99).toFixed(2)),
    maxMs: Number(maxMs.toFixed(2)),
    stdDevMs: Number(stdDevMs.toFixed(2)),
  };
}

/**
 * Parse a task mix string or object into normalized fast/standard ratios summing to 1.0.
 * Examples accepted:
 *   "fast:70,standard:30"
 *   "70/30"
 *   "fast:100"
 *   "standard:100"
 *   { fast: 0.7, standard: 0.3 }
 */
export function parseTaskMix(input?: string | TaskMix): TaskMix {
  if (!input) {
    return { fast: 0.7, standard: 0.3 };
  }

  if (typeof input === 'object') {
    if (
      !Number.isFinite(input.fast) ||
      !Number.isFinite(input.standard) ||
      input.fast < 0 ||
      input.standard < 0
    ) {
      throw new Error('invalid task mix: weights must be finite and non-negative');
    }
    const total = input.fast + input.standard;
    if (total <= 0) {
      throw new Error(
        `invalid task mix: fast (${input.fast}) + standard (${input.standard}) must be > 0`,
      );
    }
    return {
      fast: input.fast / total,
      standard: input.standard / total,
    };
  }

  const trimmed = input.trim().toLowerCase();

  // Handle format "70/30"
  if (/^\d+\/\d+$/.test(trimmed)) {
    const [fStr, sStr] = trimmed.split('/');
    const f = Number(fStr);
    const s = Number(sStr);
    const sum = f + s;
    if (sum === 0) throw new Error(`invalid ratio: ${input}`);
    return { fast: f / sum, standard: s / sum };
  }

  let fastWeight = 0;
  let standardWeight = 0;

  const parts = trimmed.split(/[,;]/);
  for (const part of parts) {
    const [key, val] = part.split(':').map((s) => s.trim());
    const num = val === undefined ? 1 : Number(val);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`invalid number in task-mix "${input}": "${val}"`);
    }

    if (key === 'fast') {
      fastWeight += num;
    } else if (key === 'standard') {
      standardWeight += num;
    } else {
      throw new Error(
        `unknown task kind in task-mix "${input}": "${key}" (expected "fast" or "standard")`,
      );
    }
  }

  const total = fastWeight + standardWeight;
  if (total <= 0) {
    throw new Error(`task mix total weight must be > 0: ${input}`);
  }

  return {
    fast: fastWeight / total,
    standard: standardWeight / total,
  };
}
