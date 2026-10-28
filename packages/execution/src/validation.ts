import { TASK_INPUT_SCHEMAS, TaskKindSchema, toInvalidArgumentError } from '@ember/contracts';
import { InvalidArgumentError, type MockTaskInput, type TaskKind } from '@ember/domain';
import type { z } from 'zod';

/**
 * Re-validate a task kind at the execution boundary.
 *
 * Persisted rows and IPC payloads are not type-checked at runtime, so an unknown kind must
 * be rejected instead of being routed to a default execution path.
 */
export function parseTaskKind(value: unknown): TaskKind {
  const parsed = TaskKindSchema.safeParse(value);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

/**
 * Re-validate a task input against the schema that belongs to its kind.
 *
 * The `strictObject` schemas reject unknown keys, so a forged payload cannot smuggle an
 * execution-path, tenant, policy or budget field into the executor.
 */
export function parseTaskInput(kind: TaskKind, input: unknown): MockTaskInput {
  const schema: z.ZodType<MockTaskInput> = TASK_INPUT_SCHEMAS[kind];
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw toInvalidArgumentError(parsed.error);
  }

  return parsed.data;
}

/** Validate a trusted policy version.
 *
 * The value always originates server-side (a gateway-derived `AuthContext` or the persisted
 * agent row). A negative, fractional or non-numeric value is rejected rather than coerced.
 */
export function parsePolicyVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentError([{ path: 'policyVersion', code: 'invalid_policy_version' }]);
  }

  return value;
}
