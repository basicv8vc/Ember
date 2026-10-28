import { TASK_INPUT_LIMITS } from '@ember/contracts';
import { DomainError, InvalidArgumentError } from '@ember/domain';
import { sha256Hex } from './crypto.js';

/** Whitelisted deterministic compute operations. Anything else is rejected. */
export const SUPPORTED_COMPUTE_OPERATIONS = ['sha256'] as const;

export type ComputeOperation = (typeof SUPPORTED_COMPUTE_OPERATIONS)[number];

export interface MockComputeResult {
  readonly operation: ComputeOperation;
  /** Lowercase hexadecimal digest of the UTF-8 encoded input. */
  readonly value: string;
  /** UTF-8 byte length of the input (not the character count). */
  readonly bytes: number;
}

/**
 * Reject an operation that is not on the compute allowlist.
 *
 * @throws {DomainError} `POLICY_DENIED` — a stable code that never echoes the input value.
 */
export function assertSupportedComputeOperation(operation: unknown): ComputeOperation {
  if (
    typeof operation !== 'string' ||
    !(SUPPORTED_COMPUTE_OPERATIONS as readonly string[]).includes(operation)
  ) {
    throw new DomainError(
      'POLICY_DENIED',
      'compute operation is not on the deterministic allowlist',
    );
  }

  return operation as ComputeOperation;
}

/**
 * Deterministic UTF-8 SHA-256.
 *
 * Pure and in-process: no shell, no file, no network, no clock. An empty string is a valid
 * input (it hashes to the well-known empty digest) and the same text always produces the
 * same lowercase hexadecimal value.
 */
export function computeSha256(text: string): MockComputeResult {
  if (typeof text !== 'string') {
    throw new InvalidArgumentError([{ path: 'text', code: 'invalid_type' }]);
  }

  if (text.length > TASK_INPUT_LIMITS.computeTextMaxChars) {
    // Length only: the rejected content is never copied into the error.
    throw new InvalidArgumentError([{ path: 'text', code: 'too_big' }]);
  }

  return Object.freeze({
    operation: 'sha256',
    value: sha256Hex(text),
    bytes: Buffer.byteLength(text, 'utf8'),
  });
}

/** Dispatch a validated compute input. Unknown operations fail closed before any work. */
export function runMockCompute(operation: unknown, text: string): MockComputeResult {
  const validated = assertSupportedComputeOperation(operation);

  switch (validated) {
    case 'sha256':
      return computeSha256(text);
  }
}
