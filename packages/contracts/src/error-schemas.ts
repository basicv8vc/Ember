import { DOMAIN_ERROR_CODES } from '@ember/domain';
import type { DomainError, DomainErrorCode } from '@ember/domain';
import { z } from 'zod';

export const DomainErrorCodeSchema = z.enum(DOMAIN_ERROR_CODES);

/** Stable HTTP error body. HTTP status mapping is deliberately out of scope for P0B-02. */
export interface ErrorResponse {
  readonly error: {
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly request_id?: string;
  };
}

export const ErrorResponseSchema: z.ZodType<ErrorResponse> = z.strictObject({
  error: z.strictObject({
    code: DomainErrorCodeSchema,
    message: z.string().min(1).max(512),
    request_id: z.string().min(1).max(128).optional(),
  }),
});

/**
 * Serialise a domain error without stack traces, causes, SQL or request input.
 * `requestId` is supplied by the gateway and is not derived from the error.
 */
export function toErrorResponse(error: DomainError, requestId?: string): ErrorResponse {
  const body = { code: error.code, message: error.message };

  return requestId === undefined ? { error: body } : { error: { ...body, request_id: requestId } };
}
