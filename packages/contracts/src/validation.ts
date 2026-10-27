import { InvalidArgumentError } from '@ember/domain';
import type { z } from 'zod';

/**
 * Convert a Zod validation failure into a stable domain error.
 *
 * Only the field path and Zod's rule code are copied. Rejected values, messages that may
 * embed them, and the original input object are deliberately discarded.
 */
export function toInvalidArgumentError(error: z.ZodError): InvalidArgumentError {
  return new InvalidArgumentError(
    error.issues.map((issue) => ({
      path: issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.'),
      code: issue.code,
    })),
  );
}
