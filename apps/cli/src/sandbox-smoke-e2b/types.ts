import type { SandboxCapabilities, SandboxUsageRecord } from '@ember/contracts';

/**
 * E2B smoke report schema.
 *
 * Deliberately separate from the local harness `SmokeReport`. The local schema *proves* a
 * simulation (`mode: 'LOCAL_SIMULATION'`, `usageSource: 'SIMULATED'`, cost `null`). This one
 * proves a remote measurement, and it is the only place where vendor latency, isolation and
 * usage may be non-null.
 *
 * Anti-fabrication rules encoded in the types:
 * - every measurement is `number | null`, and `null` means NOT_MEASURED (never 0 as a stand-in);
 * - `status: 'BLOCKED'` exists so "no key" can never be reported as `PASS` or `FAIL`;
 * - `usage.basis` must be stated, and `cost.source` cannot be `VENDOR_API` (E2B publishes no
 *   per-sandbox invoice endpoint this adapter uses).
 */

export const E2B_SMOKE_SCHEMA_VERSION = '1.0.0' as const;

export const E2B_SMOKE_STEPS = [
  'preflight',
  'capabilities',
  'create',
  'waitReady',
  'execHello',
  'fileRoundTrip',
  'execTimeout',
  'egressProbe',
  'usage',
  'stop',
  'destroy',
  'cleanupVerify',
] as const;

export type E2bSmokeStep = (typeof E2B_SMOKE_STEPS)[number];

export type E2bSmokeStepStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'BLOCKED';

export interface E2bSmokeStepDetail {
  readonly step: E2bSmokeStep;
  readonly status: E2bSmokeStepStatus;
  readonly durationMs: number | null;
  readonly error?: string;
  readonly details?: Record<string, unknown>;
}

export type E2bSmokeStatus = 'PASS' | 'FAIL' | 'BLOCKED';

export type E2bUsageBasis = 'VENDOR_METRICS' | 'NOMINAL_TEMPLATE' | 'NOT_MEASURED';

export type E2bLeakStatus = 'VERIFIED_CLEAN' | 'CONFIRMED_LEAK' | 'UNKNOWN';

export type E2bResourceVerification =
  | 'VERIFIED_ZERO'
  | 'ACTIVE_RESOURCES_DETECTED'
  | 'CHECK_FAILED'
  | 'NOT_SUPPORTED'
  | 'NOT_ATTEMPTED';

export interface E2bSmokeTiming {
  /** Wall clock from the first adapter call to the last cleanup confirmation. */
  readonly totalWallMs: number | null;
  /** `Sandbox.create` round-trip. Includes microVM boot. */
  readonly createLatencyMs: number | null;
  /** `waitReady` from create-return to a verified `running` control-plane state. */
  readonly readyLatencyMs: number | null;
  /** First user command (`python3 -c print(...)`), the number that matters for UX. */
  readonly firstCommandLatencyMs: number | null;
  /** Second command (`cat` of the written file), a warm-path sample. */
  readonly warmCommandLatencyMs: number | null;
  readonly stopLatencyMs: number | null;
  readonly destroyLatencyMs: number | null;
  /** Vendor control-plane audit after destroy. */
  readonly cleanupVerifyLatencyMs: number | null;
}

export interface E2bSmokeMeasurements {
  readonly createLatencyMs: number | null;
  readonly readyLatencyMs: number | null;
  readonly firstCommandLatencyMs: number | null;
  readonly secondCommandLatencyMs: number | null;
  readonly stopLatencyMs: number | null;
  readonly destroyLatencyMs: number | null;
  readonly timeoutProbe: {
    readonly requestedTimeoutMs: number | null;
    readonly observedElapsedMs: number | null;
    readonly observedExitCode: number | null;
    readonly timedOut: boolean | null;
    readonly overshootMs: number | null;
  };
  /** Allocated resources as reported by the vendor after readiness. */
  readonly allocatedCpuCount: number | null;
  readonly allocatedMemoryMiB: number | null;
  readonly requestedCpuMilli: number | null;
  readonly requestedMemoryMiB: number | null;
  readonly sandboxLifetimeSec: number | null;
}

export interface E2bSmokeUsage {
  readonly usage: SandboxUsageRecord | null;
  readonly basis: E2bUsageBasis;
  /** E2B does not expose per-sandbox egress bytes through this adapter's API surface. */
  readonly egressBytes: number | null;
  readonly egressSource: 'NOT_MEASURED';
}

export interface E2bEgressProbeTarget {
  readonly target: string;
  readonly port: number;
  readonly connected: boolean | null;
  readonly elapsedMs: number | null;
  /** Raw socket errno class only (e.g. `ENETUNREACH`); never a vendor message. */
  readonly failureClass: string | null;
}

export interface E2bSmokeIsolation {
  readonly requestedAllowInternetAccess: boolean | null;
  readonly observedAllowInternetAccess: boolean | null;
  readonly networkPolicyId: string | null;
  readonly egressProbes: readonly E2bEgressProbeTarget[];
  /** `true` only when every probe failed to connect while policy was deny-all. */
  readonly egressDeniedAsExpected: boolean | null;
}

export interface E2bSmokeCost {
  readonly estimatedSandboxUsd: number | null;
  readonly actualBilledUsd: number | null;
  readonly remainingCreditUsd: number | null;
  readonly source: 'NOT_MEASURED' | 'USER_SUPPLIED_PRICE_TABLE' | 'VENDOR_CONSOLE_REQUIRED';
  readonly priceTableNote: string | null;
}

export interface E2bSmokeCleanup {
  readonly stopStatus: 'COMPLETED' | 'FAILED' | 'NOT_ATTEMPTED' | 'UNKNOWN';
  readonly destroyStatus: 'COMPLETED' | 'FAILED' | 'NOT_ATTEMPTED' | 'UNKNOWN';
  readonly leakStatus: E2bLeakStatus;
  readonly resourceVerification: E2bResourceVerification;
  readonly liveSandboxIds: readonly string[];
  readonly stopError?: string;
  readonly destroyError?: string;
}

export interface E2bSmokeEvidence {
  readonly helloStdout: string | null;
  readonly helloStderr: string | null;
  readonly helloExitCode: number | null;
  readonly helloStdoutMatches: boolean | null;
  readonly fileWrittenBytes: number | null;
  readonly fileReadMatches: boolean | null;
  readonly fileVisibleInSandbox: boolean | null;
}

export interface E2bSmokeEnvironment {
  readonly sdkVersion: string;
  readonly pinnedSdkVersion: string;
  readonly template: string;
  /** Digest bound to `SandboxSpec.imageDigest`; must equal what the provider was built with. */
  readonly templateDigest: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly apiKeyPresent: boolean;
  /** Key fingerprint: 6 hex chars of SHA-256. Never the key itself. */
  readonly apiKeyFingerprint: string | null;
}

export interface E2bSmokeReport {
  readonly schemaVersion: typeof E2B_SMOKE_SCHEMA_VERSION;
  readonly testId: string;
  readonly provider: 'e2b';
  readonly mode: 'REAL_REMOTE';
  readonly status: E2bSmokeStatus;
  readonly blockedReason: string | null;
  readonly environment: E2bSmokeEnvironment;
  readonly steps: Record<E2bSmokeStep, E2bSmokeStepDetail>;
  readonly timing: E2bSmokeTiming;
  readonly measurements: E2bSmokeMeasurements;
  readonly usage: E2bSmokeUsage;
  readonly isolation: E2bSmokeIsolation;
  readonly cost: E2bSmokeCost;
  readonly cleanup: E2bSmokeCleanup;
  readonly evidence: E2bSmokeEvidence;
  readonly capabilities: SandboxCapabilities | null;
  readonly error: string | null;
  readonly limitations: readonly string[];
}

export const E2B_SMOKE_LIMITATIONS: readonly string[] = Object.freeze([
  'This report covers one sandbox in one region at one moment; it is not a benchmark of the E2B fleet.',
  'Cost fields are NOT_MEASURED unless a price table is supplied; E2B publishes no per-sandbox invoice endpoint used here.',
  'Egress bytes per sandbox are not exposed by the adapter API surface and are reported as null.',
  'Latency measured from a developer machine includes local network conditions and is not a datacentre baseline.',
  'A PASS here means the tested lifecycle and isolation assertions held; it is not a production readiness claim.',
]);

/**
 * Enforces the anti-fabrication invariants of a PASS report.
 *
 * Mirrors the local harness guarantee: a PASS cannot exist without a verified-zero cleanup,
 * a complete step table and non-null primary measurements. Returns the list of violations so
 * the CLI can fail closed instead of emitting a misleading report.
 */
export function validateE2bSmokeReport(report: E2bSmokeReport): readonly string[] {
  const violations: string[] = [];

  if (report.status !== 'PASS') {
    return violations;
  }

  if (report.cleanup.leakStatus !== 'VERIFIED_CLEAN') {
    violations.push('PASS requires cleanup.leakStatus === VERIFIED_CLEAN');
  }

  if (report.cleanup.resourceVerification !== 'VERIFIED_ZERO') {
    violations.push('PASS requires cleanup.resourceVerification === VERIFIED_ZERO');
  }

  if (report.cleanup.stopStatus !== 'COMPLETED' || report.cleanup.destroyStatus !== 'COMPLETED') {
    violations.push('PASS requires stop and destroy to be COMPLETED');
  }

  for (const step of E2B_SMOKE_STEPS) {
    if (report.steps[step].status !== 'PASS') {
      violations.push(`PASS requires step "${step}" to be PASS`);
    }
  }

  const required: Array<[string, number | null]> = [
    ['timing.createLatencyMs', report.timing.createLatencyMs],
    ['timing.readyLatencyMs', report.timing.readyLatencyMs],
    ['timing.firstCommandLatencyMs', report.timing.firstCommandLatencyMs],
    ['measurements.createLatencyMs', report.measurements.createLatencyMs],
    ['measurements.readyLatencyMs', report.measurements.readyLatencyMs],
    ['measurements.firstCommandLatencyMs', report.measurements.firstCommandLatencyMs],
  ];

  for (const [name, value] of required) {
    if (value === null) {
      violations.push(`PASS requires ${name} to be measured`);
    }
  }

  if (report.usage.basis === 'NOT_MEASURED') {
    violations.push('PASS requires a usage basis (VENDOR_METRICS or NOMINAL_TEMPLATE)');
  }

  if (report.evidence.helloStdoutMatches !== true) {
    violations.push('PASS requires the hello-ember stdout assertion to hold');
  }

  if (report.evidence.fileReadMatches !== true) {
    violations.push('PASS requires the file round-trip assertion to hold');
  }

  if (report.isolation.egressDeniedAsExpected !== true) {
    violations.push('PASS requires egress to be denied under the deny-all policy');
  }

  if (report.environment.sdkVersion !== report.environment.pinnedSdkVersion) {
    violations.push('PASS requires the pinned SDK version');
  }

  if (report.error !== null) {
    violations.push('PASS requires error === null');
  }

  return violations;
}
