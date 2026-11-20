export const UNPROVISIONED_D1_PLACEHOLDER: string;

export interface WranglerV2StagingConfig {
  name?: string;
  main?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  vars?: Record<string, string>;
  durable_objects?: {
    bindings?: Array<{ name: string; class_name: string }>;
  };
  migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
  d1_databases?: Array<{
    binding: string;
    database_name?: string;
    database_id?: string;
    migrations_dir?: string;
  }>;
  queues?: {
    producers?: Array<{ binding?: string; queue?: string }>;
    consumers?: Array<{ queue?: string; dead_letter_queue?: string }>;
  };
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  hyperdrive?: Array<{ binding?: string; id?: string }>;
  routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
  triggers?: { crons?: string[] };
}

export interface V2StagingValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly notices: readonly string[];
}

export function parseJsonc(source: string): WranglerV2StagingConfig;

export function validateV2StagingConfig(input: {
  v2Config: WranglerV2StagingConfig;
  v1Configs: readonly WranglerV2StagingConfig[];
  migrationExists?: boolean;
  requireProvisioned?: boolean;
}): V2StagingValidationResult;
