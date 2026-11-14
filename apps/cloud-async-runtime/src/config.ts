import {
  MODEL_LIMITS,
  resolveModelExecution,
  type ModelBudgetCeilings,
  type ModelExecutionPurpose,
  type ModelExecutionResolution,
} from '@ember/model-gateway';
import { z } from 'zod';

const runtimeEnvSchema = z.object({
  EMBER_ENV: z.enum(['local', 'test', 'ci', 'staging', 'production']).default('production'),
  NODE_ENV: z.string().optional(),
  EMBER_MODEL_EXECUTION: z.enum(['disabled', 'fake', 'real']).default('disabled'),
  EMBER_MODEL_PROVIDER: z.string().min(1).max(64).default('openai'),
  EMBER_MODEL_ID: z.string().max(120).optional(),
  EMBER_MODEL_API_KEY: z.string().max(512).optional(),
  EMBER_MODEL_TURN_LEASE_MS: z.coerce.number().int().min(1_000).max(60_000).default(30_000),
  EMBER_MODEL_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(20_000),
  EMBER_MODEL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(2).optional(),
  EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD: z.coerce.number().int().min(1).max(5_000).optional(),
  EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: z.coerce
    .number()
    .int()
    .min(0)
    .max(250_000)
    .optional(),
  EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional(),
  EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: z.coerce
    .number()
    .int()
    .min(0)
    .max(5_000_000)
    .optional(),
  EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: z.coerce.number().int().min(0).max(60).optional(),
  EMBER_MODEL_ALPHA_SCOPE: z.enum(['allowlist', 'authenticated_tenants']).default('allowlist'),
  EMBER_MODEL_ALPHA_TENANT_IDS: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .transform((value) => value.split(',').map((tenantId) => tenantId.trim().toLowerCase()))
    .pipe(z.array(z.string().uuid()).min(1).max(100))
    .optional(),
});

export type CloudAsyncRuntimeEnv = z.input<typeof runtimeEnvSchema>;

export type CloudRuntimeModelConfig =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      readonly kind: 'enabled';
      readonly mode: 'fake';
      readonly resolution: Extract<
        ModelExecutionResolution,
        { readonly ok: true; readonly mode: 'fake' }
      >;
    }
  | {
      readonly kind: 'enabled';
      readonly mode: 'real';
      readonly resolution: Extract<
        ModelExecutionResolution,
        { readonly ok: true; readonly mode: 'real' }
      >;
      readonly tenantScope: 'allowlist' | 'authenticated_tenants';
      /** Internal account allowlist when tenantScope is 'allowlist'; null for all authenticated tenants. Conversations and Turns remain tenant-isolated in B2. */
      readonly onlyTenantIds: readonly string[] | null;
    };

export function isAuthorizedCloudModelTurn(
  model: CloudRuntimeModelConfig,
  event: { readonly tenantId: string; readonly conversationId: string; readonly turnId: string },
): boolean {
  if (model.kind !== 'enabled') {
    return false;
  }
  if (model.mode === 'fake' || model.tenantScope === 'authenticated_tenants') {
    return true;
  }
  return model.onlyTenantIds?.includes(event.tenantId) ?? false;
}

export function isCloudModelConversationAuthorized(
  model: CloudRuntimeModelConfig,
  event: { readonly tenantId: string; readonly conversationId: string },
): boolean {
  if (model.kind !== 'enabled') {
    return false;
  }
  if (model.mode === 'fake' || model.tenantScope === 'authenticated_tenants') {
    return true;
  }
  return model.onlyTenantIds?.includes(event.tenantId) ?? false;
}

/**
 * Resolve model execution using the same code-owned approvals and budget bounds as the Node Worker.
 * Shared environments fail closed: `fake` is permitted only for local/test validation.
 */
export function resolveCloudRuntimeModelConfig(
  input: unknown,
  executionPurpose: ModelExecutionPurpose = 'resident_worker',
  now: Date = new Date(),
): CloudRuntimeModelConfig {
  const parsed = runtimeEnvSchema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'refused', reason: 'invalid_runtime_configuration' };
  }

  const values = parsed.data;
  const shared =
    values.EMBER_ENV === 'staging' ||
    values.EMBER_ENV === 'production' ||
    values.NODE_ENV === 'staging' ||
    values.NODE_ENV === 'production';

  if (values.EMBER_MODEL_EXECUTION === 'fake' && shared) {
    return { kind: 'refused', reason: 'simulated_execution_in_shared_environment' };
  }

  const stagingAlphaReal =
    values.EMBER_MODEL_EXECUTION === 'real' && executionPurpose === 'staging_alpha';
  if (
    stagingAlphaReal &&
    (values.EMBER_ENV !== 'staging' || values.NODE_ENV?.trim().toLowerCase() === 'production')
  ) {
    return { kind: 'refused', reason: 'staging_alpha_environment_required' };
  }

  const alphaScope = values.EMBER_MODEL_ALPHA_SCOPE;
  const onlyTenantIds = values.EMBER_MODEL_ALPHA_TENANT_IDS;
  if (stagingAlphaReal && alphaScope === 'allowlist' && onlyTenantIds === undefined) {
    return { kind: 'refused', reason: 'staging_alpha_tenant_allowlist_required' };
  }

  const ceilings: Partial<ModelBudgetCeilings> = {
    ...(values.EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD === undefined
      ? {}
      : { perAttemptMicroUsd: values.EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD }),
    ...(values.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD === undefined
      ? {}
      : { principalDailyMicroUsd: values.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD }),
    ...(values.EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD === undefined
      ? {}
      : { tenantDailyMicroUsd: values.EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD }),
    ...(values.EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD === undefined
      ? {}
      : { globalDailyMicroUsd: values.EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD }),
    ...(values.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS === undefined
      ? {}
      : { principalDailyTurns: values.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS }),
  };

  const resolution = resolveModelExecution(
    {
      mode: values.EMBER_MODEL_EXECUTION,
      providerId: values.EMBER_MODEL_PROVIDER,
      modelId: values.EMBER_MODEL_ID,
      apiKey: values.EMBER_MODEL_API_KEY,
      executionPurpose,
      ceilings,
      maxAttempts:
        values.EMBER_MODEL_MAX_ATTEMPTS ?? (stagingAlphaReal ? 1 : MODEL_LIMITS.maxAttemptsPerTurn),
      attemptTimeoutMs: values.EMBER_MODEL_ATTEMPT_TIMEOUT_MS,
      leaseMs: values.EMBER_MODEL_TURN_LEASE_MS,
    },
    undefined,
    now,
  );

  if (!resolution.ok) {
    return { kind: 'refused', reason: resolution.reason };
  }
  if (resolution.mode === 'disabled') {
    return { kind: 'disabled' };
  }

  if (resolution.mode === 'fake') {
    return { kind: 'enabled', mode: 'fake', resolution };
  }

  if (
    stagingAlphaReal &&
    (resolution.executionScope !== 'staging_alpha' || resolution.settings.maxAttempts !== 1)
  ) {
    return { kind: 'refused', reason: 'staging_alpha_authorization_invalid' };
  }

  if (executionPurpose === 'staging_alpha') {
    if (values.EMBER_ENV !== 'staging' || values.NODE_ENV?.trim().toLowerCase() === 'production') {
      return { kind: 'refused', reason: 'staging_alpha_environment_required' };
    }
    if (alphaScope === 'allowlist') {
      if (onlyTenantIds === undefined) {
        return { kind: 'refused', reason: 'staging_alpha_tenant_allowlist_required' };
      }
      return {
        kind: 'enabled',
        mode: 'real',
        resolution,
        tenantScope: 'allowlist',
        onlyTenantIds,
      };
    }
    return {
      kind: 'enabled',
      mode: 'real',
      resolution,
      tenantScope: 'authenticated_tenants',
      onlyTenantIds: null,
    };
  }

  return { kind: 'refused', reason: 'execution_scope_refused' };
}
