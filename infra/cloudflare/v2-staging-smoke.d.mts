export const DEFAULT_V2_STAGING_URL: string;
export const DEFAULT_V1_API_URL: string;

export interface V2StagingSmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly status: number;
  readonly latencyMs?: number | null;
}

export interface V2StagingSmokeResult {
  readonly ok: boolean;
  readonly checks: readonly V2StagingSmokeCheck[];
  readonly errors: readonly string[];
}

export function runV2StagingSmoke(options?: {
  v2BaseUrl?: string;
  v1BaseUrl?: string;
  checkV1?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<V2StagingSmokeResult>;
