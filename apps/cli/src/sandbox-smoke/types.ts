import type {
  SandboxCapabilities,
  SandboxProvider,
  SandboxProviderFactory,
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

export type SmokeCleanupStepStatus = 'COMPLETED' | 'FAILED' | 'NOT_ATTEMPTED' | 'UNKNOWN';
export type SmokeLeakStatus = 'VERIFIED_CLEAN' | 'CONFIRMED_LEAK' | 'UNKNOWN';
export type SmokeResourceVerificationStatus =
  | 'VERIFIED_ZERO'
  | 'ACTIVE_RESOURCES_DETECTED'
  | 'CHECK_FAILED'
  | 'NOT_SUPPORTED'
  | 'NOT_ATTEMPTED';

export interface SmokePhaseDetail {
  readonly phase: SmokePhase;
  readonly status: SmokePhaseStatus;
  readonly durationMs: number;
  readonly error?: string;
  readonly details?: Record<string, unknown>;
}

export interface SmokeCleanupReport {
  readonly stopStatus: SmokeCleanupStepStatus;
  readonly destroyStatus: SmokeCleanupStepStatus;
  readonly leakStatus: SmokeLeakStatus;
  readonly resourceVerification: SmokeResourceVerificationStatus;
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
  readonly provider?: SandboxProvider;
  readonly factory?: SandboxProviderFactory;
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
 * Also enforces that an overall PASS report MUST be verified clean with completed destroy.
 */
export const SmokeReportSchema = z
  .strictObject({
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
      stopStatus: z.enum(['COMPLETED', 'FAILED', 'NOT_ATTEMPTED', 'UNKNOWN']),
      destroyStatus: z.enum(['COMPLETED', 'FAILED', 'NOT_ATTEMPTED', 'UNKNOWN']),
      leakStatus: z.enum(['VERIFIED_CLEAN', 'CONFIRMED_LEAK', 'UNKNOWN']),
      resourceVerification: z.enum([
        'VERIFIED_ZERO',
        'ACTIVE_RESOURCES_DETECTED',
        'CHECK_FAILED',
        'NOT_SUPPORTED',
        'NOT_ATTEMPTED',
      ]),
      stopSucceeded: z.boolean(),
      destroySucceeded: z.boolean(),
      resourcesLeaked: z.boolean(),
      stopError: z.string().optional(),
      destroyError: z.string().optional(),
    }),
    error: z.string().nullable(),
    limitations: z.array(z.string()).readonly(),
  })
  .superRefine((data, ctx) => {
    if (data.status === 'PASS') {
      if (data.cleanup.leakStatus !== 'VERIFIED_CLEAN') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A PASS report must have cleanup.leakStatus set to VERIFIED_CLEAN',
          path: ['cleanup', 'leakStatus'],
        });
      }
      if (data.cleanup.resourcesLeaked !== false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A PASS report must have cleanup.resourcesLeaked set to false',
          path: ['cleanup', 'resourcesLeaked'],
        });
      }
      if (data.cleanup.resourceVerification !== 'VERIFIED_ZERO') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A PASS report must have cleanup.resourceVerification set to VERIFIED_ZERO',
          path: ['cleanup', 'resourceVerification'],
        });
      }
      if (data.cleanup.destroyStatus !== 'COMPLETED') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A PASS report must have cleanup.destroyStatus set to COMPLETED',
          path: ['cleanup', 'destroyStatus'],
        });
      }
      if (!data.cleanup.destroySucceeded) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A PASS report must have cleanup.destroySucceeded set to true',
          path: ['cleanup', 'destroySucceeded'],
        });
      }
      if (data.cleanup.stopStatus !== 'COMPLETED') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A PASS report must have cleanup.stopStatus set to COMPLETED',
          path: ['cleanup', 'stopStatus'],
        });
      }
      if (!data.cleanup.stopSucceeded) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A PASS report must have cleanup.stopSucceeded set to true',
          path: ['cleanup', 'stopSucceeded'],
        });
      }
      for (const phase of SMOKE_PHASES) {
        if (data.phases[phase].status !== 'PASS') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `A PASS report must have phase "${phase}" status set to PASS`,
            path: ['phases', phase, 'status'],
          });
        }
      }
      if (data.error !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A PASS report must have error set to null',
          path: ['error'],
        });
      }
    }
  });
