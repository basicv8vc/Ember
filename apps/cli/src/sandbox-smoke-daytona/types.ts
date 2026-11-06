import type { DaytonaSandboxClass } from '@ember/sandbox-daytona';

/**
 * Report schema for the Daytona sandbox smoke run.
 *
 * The shape is intentionally verbose: every field is either measured, or explicitly `null`
 * with a reason. There is no `unknown` bucket that a later reader could mistake for a pass.
 */

export const DAYTONA_SMOKE_STEPS = [
  'preflight',
  'create',
  'waitReady',
  'execHello',
  'kernelProbe',
  'fileRoundTrip',
  'execTimeout',
  'cancel',
  'egressProbe',
  'isolationCrossTenant',
  'crashRecovery',
  'usage',
  'stop',
  'destroy',
  'cleanupVerify',
] as const;

export type DaytonaSmokeStep = (typeof DAYTONA_SMOKE_STEPS)[number];
export type DaytonaSmokeStepStatus = 'PASS' | 'FAIL' | 'SKIP' | 'BLOCKED';

export interface DaytonaSmokeStepDetail {
  readonly step: DaytonaSmokeStep;
  readonly status: DaytonaSmokeStepStatus;
  readonly durationMs: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface DaytonaSmokeEnvironment {
  readonly sdkVersion: string;
  readonly pinnedSdkVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  /** Host of the API endpoint only; the key and any query string are never recorded. */
  readonly apiHost: string;
  readonly target: string | null;
  readonly snapshot: string;
  readonly sandboxClass: DaytonaSandboxClass;
  readonly profileId: string;
  readonly owner: string;
  readonly tenantA: string;
  readonly tenantB: string;
  /** Deliberately vague: tier is a dashboard fact, not something the API reports. */
  readonly tierNote: string;
  readonly startedAt: string;
}

export interface DaytonaSmokeMeasurements {
  createLatencyMs: number | null;
  readyLatencyMs: number | null;
  firstCommandLatencyMs: number | null;
  commandLatencyMs: number | null;
  fileWriteLatencyMs: number | null;
  fileReadLatencyMs: number | null;
  timeoutObservedMs: number | null;
  cancelObservedMs: number | null;
  stopLatencyMs: number | null;
  destroyLatencyMs: number | null;
  reconcileLatencyMs: number | null;
}

export interface DaytonaSmokeIsolation {
  /** `true` when an outbound connection to the public internet failed inside the sandbox. */
  egressBlocked: boolean | null;
  /** `true` when the cloud metadata endpoint was reachable — a hard security failure. */
  metadataEndpointReachable: boolean | null;
  /** `true` when tenant B's attempt to use tenant A's sandbox id was rejected. */
  crossTenantHandleDenied: boolean | null;
  /** `true` when tenant B saw tenant A's file (must be false). */
  crossTenantFileVisible: boolean | null;
  sandboxClassReported: string | null;
  snapshotReported: string | null;
  kernelRelease: string | null;
  cgroupDriver: string | null;
  cgroupCpuMax: string | null;
  uid: number | null;
  networkBlockAllReported: boolean | null;
}

export interface DaytonaSmokeCleanup {
  liveBeforeDestroy: number | null;
  vendorLiveAfterDestroy: number | null;
  ownerWideLiveAfterDestroy: number | null;
  orphanSweptCount: number | null;
  orphanSweepFailures: number | null;
  /** Set when the sweep ran in a genuinely separate OS process. */
  orphanSweepProcessId: string | null;
}

export interface DaytonaSmokeUsage {
  cpuSeconds: number;
  memoryGiBSeconds: number;
  egressBytes: number;
  basis: string;
}

export interface DaytonaSmokeCost {
  estimatedUsd: number;
  estimatedPerMinuteUsd: number;
  rateCard: Readonly<Record<string, number>>;
}

export interface DaytonaSmokeLimits {
  readonly requestedCpu: number;
  readonly requestedMemoryMiB: number;
  readonly maxLifetimeSec: number;
  readonly vendorTtlMinutes: number;
  readonly idleStopMinutes: number;
  readonly concurrencyCap: number;
}

export interface DaytonaSmokeReport {
  readonly schemaVersion: '1.0';
  readonly status: 'PASS' | 'FAIL' | 'BLOCKED';
  readonly blockedReason?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly environment: DaytonaSmokeEnvironment;
  readonly steps: Readonly<Record<DaytonaSmokeStep, DaytonaSmokeStepDetail>>;
  readonly measurements: DaytonaSmokeMeasurements | null;
  readonly isolation: DaytonaSmokeIsolation | null;
  readonly cleanup: DaytonaSmokeCleanup | null;
  readonly usage: DaytonaSmokeUsage | null;
  readonly cost: DaytonaSmokeCost | null;
  readonly limits: DaytonaSmokeLimits;
  readonly findings: readonly string[];
}

export const DAYTONA_SMOKE_EXIT = Object.freeze({
  pass: 0,
  fail: 1,
  blocked: 3,
});
