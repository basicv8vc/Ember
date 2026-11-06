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
  /**
   * `true` when DNS resolution of a public hostname failed inside the sandbox.
   * Layer 1 of the egress picture: a deny-all policy may still leak DNS.
   */
  dnsBlocked: boolean | null;
  /**
   * `true` when TCP to a fixed public IP (1.1.1.1:443) failed inside the sandbox.
   * Layer 2: IP-literal connectivity, deliberately bypassing DNS.
   */
  publicTcpBlocked: boolean | null;
  /** `true` when a full outbound HTTPS request to the public internet failed. Layer 3. */
  egressBlocked: boolean | null;
  /** `true` when TCP connect to 169.254.169.254:80 succeeded. Link-local reachability at the transport layer. */
  metadataTcpReachable: boolean | null;
  /**
   * HTTP status code returned by the IMDSv1 metadata root (`GET /latest/meta-data/`), or
   * `null` when no HTTP response was received. ANY status code — including 401/403/404 —
   * proves the metadata service is reachable at the HTTP layer.
   *
   * It does NOT prove credential exposure. The probe never reads response bodies and never
   * requests `user-data` or IAM credential paths, so "credentials were readable" remains
   * untested and unproven even when this field is non-null.
   */
  metadataHttpStatus: number | null;
  /**
   * HTTP status of the IMDSv2 token endpoint (`PUT /latest/api/token`), same caveats as
   * `metadataHttpStatus`: status code only, body never read (the token itself is never captured).
   */
  metadataImdsV2TokenStatus: number | null;
  /**
   * `true` when the metadata service answered at the HTTP layer (any status code).
   * This is the strongest statement the probe can make without touching credentials.
   */
  metadataHttpReachable: boolean | null;
  /**
   * `true` when tenant B's attempt to use tenant A's sandbox id was rejected.
   *
   * Scope note: this exercises the Ember adapter's own tenant-scoped record bookkeeping —
   * it is NOT evidence that the Daytona control plane enforces cross-account isolation.
   */
  crossTenantHandleDenied: boolean | null;
  /** `true` when tenant B saw tenant A's file (must be false). Adapter-local check, same scope note as above. */
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
