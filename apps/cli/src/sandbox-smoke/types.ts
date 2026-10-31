import type {
  SandboxCapabilities,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageRecord,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import { z } from 'zod';

export const SMOKE_SCHEMA_VERSION = '1.0.0' as const;

export const SMOKE_PHASES = [
  'capabilities',
  'create',
  'waitReady',
  'exec',
  'readOutput',
  'usage',
  'stop',
  'destroy',
] as const;

export type SmokePhase = (typeof SMOKE_PHASES)[number];

export type SmokePhaseStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface SmokePhaseDetail {
  readonly phase: SmokePhase;
  readonly status: SmokePhaseStatus;
  readonly durationMs: number;
  readonly error?: string;
  readonly details?: Record<string, unknown>;
}

export interface SmokeCleanupReport {
  readonly stopSucceeded: boolean;
  readonly destroySucceeded: boolean;
  readonly resourcesLeaked: boolean;
  readonly stopError?: string;
  readonly destroyError?: string;
}

export interface SmokeTimingReport {
  readonly totalWallMs: number;
  readonly phaseDurationsMs: Record<SmokePhase, number>;
}

export const SMOKE_LIMITATIONS: readonly string[] = Object.freeze([
  'Fake sandbox runs strictly in-process with memory isolation only; it provides NO VM, container, or network boundary.',
  'Snapshot and resume capabilities are UNSUPPORTED and fail-closed.',
  'Network policy enforcement is UNSUPPORTED; capabilities.networkPolicy is false.',
  'Vendor latency, cold-start latency, and cloud execution costs are NOT_MEASURED.',
  'This harness evaluates the provider-neutral lifecycle contract, not third-party cloud infrastructure.',
]);

export interface SmokeReport {
  readonly schemaVersion: typeof SMOKE_SCHEMA_VERSION;
  readonly testId: string;
  readonly provider: 'fake';
  readonly mode: 'LOCAL_SIMULATION';
  readonly status: 'PASS' | 'FAIL';
  readonly phases: Record<SmokePhase, SmokePhaseDetail>;
  readonly timing: SmokeTimingReport;
  readonly usageSource: 'SIMULATED';
  readonly usage: SandboxUsageRecord | null;
  readonly realIsolationStatus: 'NOT_MEASURED';
  readonly vendorColdStartMs: null;
  readonly vendorCostUsd: null;
  readonly costSource: 'NOT_MEASURED';
  readonly capabilities: SandboxCapabilities | null;
  readonly cleanup: SmokeCleanupReport;
  readonly error: string | null;
  readonly limitations: readonly string[];
}

export interface SmokeRunnerOptions {
  readonly provider: SandboxProvider;
  readonly tenantId?: Id;
  readonly runId?: Id;
  readonly imageDigest?: string;
  readonly timeoutMs?: number;
  readonly readyDeadlineMs?: number;
  readonly execTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly argv?: readonly string[];
  readonly expectedSha256?: string;
  readonly specOverrides?: Partial<SandboxSpec>;
}

const PhaseDetailSchema = z.strictObject({
  phase: z.enum(SMOKE_PHASES),
  status: z.enum(['PASS', 'FAIL', 'SKIPPED']),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Strict schema for the smoke harness output.
 *
 * Guarantees that vendor cold start, vendor costs, and real isolation CANNOT be falsely marked
 * as passed, measured, or non-null in this local simulation tier.
 */
export const SmokeReportSchema = z.strictObject({
  schemaVersion: z.literal(SMOKE_SCHEMA_VERSION),
  testId: z.string().uuid(),
  provider: z.literal('fake'),
  mode: z.literal('LOCAL_SIMULATION'),
  status: z.enum(['PASS', 'FAIL']),
  phases: z.strictObject({
    capabilities: PhaseDetailSchema,
    create: PhaseDetailSchema,
    waitReady: PhaseDetailSchema,
    exec: PhaseDetailSchema,
    readOutput: PhaseDetailSchema,
    usage: PhaseDetailSchema,
    stop: PhaseDetailSchema,
    destroy: PhaseDetailSchema,
  }),
  timing: z.strictObject({
    totalWallMs: z.number().nonnegative(),
    phaseDurationsMs: z.strictObject({
      capabilities: z.number().nonnegative(),
      create: z.number().nonnegative(),
      waitReady: z.number().nonnegative(),
      exec: z.number().nonnegative(),
      readOutput: z.number().nonnegative(),
      usage: z.number().nonnegative(),
      stop: z.number().nonnegative(),
      destroy: z.number().nonnegative(),
    }),
  }),
  usageSource: z.literal('SIMULATED'),
  usage: z
    .strictObject({
      cpuSeconds: z.number().nonnegative(),
      memoryGiBSeconds: z.number().nonnegative(),
      egressBytes: z.number().nonnegative(),
    })
    .nullable(),
  realIsolationStatus: z.literal('NOT_MEASURED'),
  vendorColdStartMs: z.null(),
  vendorCostUsd: z.null(),
  costSource: z.literal('NOT_MEASURED'),
  capabilities: z
    .strictObject({
      shell: z.boolean(),
      browser: z.boolean(),
      filesystemSnapshot: z.boolean(),
      memoryResume: z.boolean(),
      diskSurvivesStop: z.boolean(),
      forkFromSnapshot: z.boolean(),
      persistentVolume: z.boolean(),
      networkPolicy: z.boolean(),
    })
    .nullable(),
  cleanup: z.strictObject({
    stopSucceeded: z.boolean(),
    destroySucceeded: z.boolean(),
    resourcesLeaked: z.boolean(),
    stopError: z.string().optional(),
    destroyError: z.string().optional(),
  }),
  error: z.string().nullable(),
  limitations: z.array(z.string()).readonly(),
});
