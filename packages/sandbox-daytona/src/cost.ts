/**
 * Vendor cost model, expressed in one place so the report cannot drift from the code.
 *
 * Rates are the published Daytona list prices as of 2026-11-06 and are *inputs to an
 * estimate*, not a measurement. The only authoritative spend figure is the vendor wallet /
 * usage page; `estimateCostUsd` exists so a run can be bounded before it happens, not so it
 * can be reported as billed.
 */

export const DAYTONA_PRICING = Object.freeze({
  /** USD per vCPU-hour. */
  vCpuHourUsd: 0.0504,
  /** USD per GiB-hour of memory. */
  memoryGiBHourUsd: 0.0162,
  /** USD per GiB-hour of reserved disk. */
  storageGiBHourUsd: 0.000_108,
  /** Storage is free up to this many GiB. */
  freeStorageGiB: 5,
});

export interface DaytonaCostInput {
  readonly cpu: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
  readonly seconds: number;
}

/**
 * Estimates the metered cost of one sandbox held for `seconds`.
 *
 * Billing is per second with no observed minimum, so a 30-second sandbox costs roughly 1/120th
 * of an hour of its reservation. This deliberately ignores idle-stop credits and free-tier
 * allowances: over-estimating makes the PoC budget safe, under-estimating does not.
 */
export function estimateCostUsd(input: DaytonaCostInput): number {
  const hours = Math.max(input.seconds, 0) / 3_600;
  const billableDiskGiB = Math.max(input.diskGiB - DAYTONA_PRICING.freeStorageGiB, 0);

  const compute = input.cpu * DAYTONA_PRICING.vCpuHourUsd * hours;
  const memory = input.memoryGiB * DAYTONA_PRICING.memoryGiBHourUsd * hours;
  const storage = billableDiskGiB * DAYTONA_PRICING.storageGiBHourUsd * hours;

  return compute + memory + storage;
}

/** Convenience: cost of a 1 vCPU / 1 GiB / 3 GiB sandbox held for exactly one minute. */
export function estimatedCostPerMinuteUsd(cpu = 1, memoryGiB = 1, diskGiB = 3): number {
  return estimateCostUsd({ cpu, memoryGiB, diskGiB, seconds: 60 });
}
