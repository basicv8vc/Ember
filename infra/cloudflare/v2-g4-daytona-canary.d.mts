export const G4_DEFAULT_BASE_URL: string;
export const G4_APPROVED_MODEL_ID: string;
export const G4_DEFAULT_SANDBOX_OWNER: string;
export const G4_MAX_TASK_DEADLINE_MS: number;
export const G4_MAX_ARTIFACT_BYTES: number;
export const G4_SAFE_FILENAME_REGEX: RegExp;
export const G4_BLOCKED_MEDIA_TYPES: ReadonlySet<string>;

export const G4_SYNTHETIC_CSV_FIXTURE: Readonly<{
  filename: string;
  mediaType: string;
  content: string;
  sizeBytes: number;
  sha256: string;
  expectedSummary: Readonly<{
    rows: number;
    totalRevenue: number;
    totalUnits: number;
  }>;
}>;

export const G4_DIRECT_TASK_PROMPT: string;
export const G4_NL_TASK_PROMPT: string;
export const G4_CANCEL_TASK_PROMPT: string;

export function isLoopbackUrl(rawUrl: string): boolean;

export function assertCanaryExecutionAuthorized(input: {
  readonly baseUrl: string;
  readonly confirmFounderAuthorization?: boolean;
}): void;

export function validateDownloadedArtifact(input: {
  readonly artifact: {
    readonly filename: string;
    readonly media_type: string;
    readonly size: number;
    readonly sha256: string;
  };
  readonly bytes: Uint8Array;
  readonly headers?: Headers | Record<string, string | null>;
}): {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly computedSha256: string | null;
};

export interface G4OrphanSweepSummary {
  readonly liveCount: number;
  readonly destroyed: readonly string[];
  readonly failed: readonly { readonly sandboxId: string; readonly reason: string }[];
}

export interface G4CanaryRunReport {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly agentId: string;
  readonly fixtureSha256: string;
  readonly directTask: {
    readonly taskId: string;
    readonly status: string;
    readonly modelLabel: string;
    readonly simulated: boolean;
    readonly eventCount: number;
    readonly outputs: readonly {
      readonly artifactId: string;
      readonly filename: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly sha256: string | null;
    }[];
  };
  readonly nlDelegation: {
    readonly taskId: string;
    readonly status: string;
    readonly outputs: readonly {
      readonly artifactId: string;
      readonly filename: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly sha256: string | null;
    }[];
  } | null;
  readonly cancellation: {
    readonly taskId: string;
    readonly statusBeforeCancel: string;
    readonly terminalStatus: string;
    readonly committedRunArtifacts: number;
  } | null;
  readonly cleanup: {
    readonly checked: boolean;
    readonly liveCount: number | null;
    readonly destroyed: readonly string[];
    readonly failed: readonly { readonly sandboxId: string; readonly reason: string }[];
  };
  readonly elapsedMs: number;
}

export function runG4DaytonaCanary(options: {
  readonly baseUrl?: string;
  readonly bearerToken: string;
  readonly confirmFounderAuthorization?: boolean;
  readonly allowSimulated?: boolean;
  readonly expectedModelLabel?: string;
  readonly sandboxOwner?: string;
  readonly tenantId?: string;
  readonly includeNlChat?: boolean;
  readonly includeCancellation?: boolean;
  readonly taskTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly cancelWaitForRunningMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sweepOrphans?: (input: {
    readonly owner: string;
    readonly tenantId?: string;
  }) => Promise<G4OrphanSweepSummary>;
}): Promise<G4CanaryRunReport>;
