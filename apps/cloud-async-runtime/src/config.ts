import { resolveModelExecution, type ModelExecutionResolution } from '@ember/model-gateway';
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
  EMBER_MODEL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(2).default(2),
  EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD: z.coerce
    .number()
    .int()
    .min(1)
    .max(5_000)
    .default(5_000),
  EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD: z.coerce
    .number()
    .int()
    .min(0)
    .max(250_000)
    .default(250_000),
  EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .default(1_000_000),
  EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD: z.coerce
    .number()
    .int()
    .min(0)
    .max(5_000_000)
    .default(5_000_000),
  EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS: z.coerce.number().int().min(0).max(60).default(60),
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
    };

/**
 * Resolve model execution using the same code-owned approvals and budget bounds as the Node Worker.
 * Shared environments fail closed: `fake` is permitted only for local/test validation.
 */
export function resolveCloudRuntimeModelConfig(input: unknown): CloudRuntimeModelConfig {
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

  const resolution = resolveModelExecution({
    mode: values.EMBER_MODEL_EXECUTION,
    providerId: values.EMBER_MODEL_PROVIDER,
    modelId: values.EMBER_MODEL_ID,
    apiKey: values.EMBER_MODEL_API_KEY,
    ceilings: {
      perAttemptMicroUsd: values.EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD,
      principalDailyMicroUsd: values.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD,
      tenantDailyMicroUsd: values.EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD,
      globalDailyMicroUsd: values.EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD,
      principalDailyTurns: values.EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS,
    },
    maxAttempts: values.EMBER_MODEL_MAX_ATTEMPTS,
    attemptTimeoutMs: values.EMBER_MODEL_ATTEMPT_TIMEOUT_MS,
    leaseMs: values.EMBER_MODEL_TURN_LEASE_MS,
  });

  if (!resolution.ok) {
    return { kind: 'refused', reason: resolution.reason };
  }
  if (resolution.mode === 'disabled') {
    return { kind: 'disabled' };
  }

  if (resolution.mode === 'fake') {
    return { kind: 'enabled', mode: 'fake', resolution };
  }

  return { kind: 'enabled', mode: 'real', resolution };
}
