/**
 * Seedable deterministic pseudo-random number generator (Mulberry32) for chaos testing.
 *
 * All randomized interleavings and fault injections record their seed so any failure
 * is 100% reproducible by passing `CHAOS_SEED=<seed>`.
 */

export interface ChaosPrng {
  readonly seed: number;
  /** Returns a float in [0, 1) */
  next(): number;
  /** Returns an integer in [min, max] inclusive */
  nextInt(min: number, max: number): number;
  /** Return a shuffled copy of an array */
  shuffle<T>(array: readonly T[]): T[];
  /** Pick a random element from a non-empty array */
  pick<T>(array: readonly T[]): T;
}

export function resolveChaosSeed(explicitSeed?: number): number {
  if (explicitSeed !== undefined && Number.isSafeInteger(explicitSeed)) {
    return explicitSeed;
  }

  const envSeed = process.env.CHAOS_SEED;
  if (envSeed !== undefined && envSeed.length > 0) {
    const parsed = parseInt(envSeed, 10);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  // Default seed: 20261030 for reproducibility unless explicitly overridden.
  return 20261030;
}

export function createChaosPrng(seedInput?: number): ChaosPrng {
  const seed = resolveChaosSeed(seedInput);
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function nextInt(min: number, max: number): number {
    if (min > max) {
      throw new Error(`min (${min}) must be <= max (${max})`);
    }
    return Math.floor(next() * (max - min + 1)) + min;
  }

  function shuffle<T>(array: readonly T[]): T[] {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const temp = copy[i]!;
      copy[i] = copy[j]!;
      copy[j] = temp;
    }
    return copy;
  }

  function pick<T>(array: readonly T[]): T {
    if (array.length === 0) {
      throw new Error('cannot pick from an empty array');
    }
    return array[nextInt(0, array.length - 1)]!;
  }

  return { seed, next, nextInt, shuffle, pick };
}
