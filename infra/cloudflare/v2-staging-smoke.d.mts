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

export function parseV2StagingSmokeArgs(
  args?: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): {
  readonly v2BaseUrl: string;
  readonly v1BaseUrl: string;
  readonly checkV1: boolean;
};

export function runV2StagingSmokeCli(options?: {
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}): Promise<{ readonly exitCode: number; readonly result: V2StagingSmokeResult }>;
