/**
 * Closed failure taxonomy of the gateway.
 *
 * Provider status codes, bodies, URLs and exception text never leave an adapter: everything is
 * mapped here first, so no caller can log or persist provider detail by accident. The codes are the
 * same strings the attempt ledger stores, which keeps one vocabulary for "what happened".
 */
export const MODEL_FAILURE_CODES = Object.freeze([
  /** The attempt deadline elapsed, or the request was aborted, with the request possibly sent. */
  'model_timeout',
  /** Transport reset or provider 5xx. */
  'model_unavailable',
  /** Provider 429. */
  'model_rate_limited',
  /** Provider 401/403. Never retried; an operator must see it. */
  'model_auth_failed',
  /** A 2xx whose body could not be parsed into the contract shape. */
  'model_invalid_output',
  /** The worker stopped, or the Turn was cancelled, while the request was in flight. */
  'client_cancelled',
  /** The request provably never left the process. */
  'not_sent',
] as const);

export type ModelFailureCode = (typeof MODEL_FAILURE_CODES)[number];

/** Codes a second attempt may help with. Everything else is final on the first attempt. */
const RETRYABLE: ReadonlySet<ModelFailureCode> = new Set<ModelFailureCode>([
  'model_timeout',
  'model_unavailable',
  'model_rate_limited',
]);

export function isRetryableModelFailure(code: ModelFailureCode): boolean {
  return RETRYABLE.has(code);
}

/**
 * A gateway failure carries only a closed code. `message` is fixed per code and therefore safe to
 * place in an internal log line, but it is still never returned to a client.
 */
export class ModelGatewayFailure extends Error {
  override readonly name = 'ModelGatewayFailure';
  readonly code: ModelFailureCode;
  readonly retryable: boolean;

  constructor(code: ModelFailureCode) {
    super(`model gateway failure: ${code}`);
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}

/**
 * A real-provider request refused at the final egress boundary because its dated approval expired.
 * It reuses `not_sent`: no provider bytes left the process, so the reservation is safe to release.
 */
export class ModelAuthorizationRefused extends ModelGatewayFailure {
  readonly reason = 'approval_expired' as const;

  constructor() {
    super('not_sent');
  }
}

export function isModelAuthorizationRefused(value: unknown): value is ModelAuthorizationRefused {
  return value instanceof ModelAuthorizationRefused;
}

export function isModelGatewayFailure(value: unknown): value is ModelGatewayFailure {
  return value instanceof ModelGatewayFailure;
}

/**
 * A caller-side refusal: the request was never built, so zero bytes left the process. It is not a
 * provider failure and must not be recorded as a billed attempt.
 */
export class ModelInputRefused extends Error {
  override readonly name = 'ModelInputRefused';
  readonly reason:
    | 'context_too_large'
    | 'context_invalid'
    | 'input_tokens_over_cap'
    | 'max_output_invalid'
    | 'no_context'
    /**
     * The worst-case cost of this request is larger than the per-attempt reservation cap.
     *
     * The refusal exists because the alternative is truncating the reservation to the cap and then
     * sending the request anyway, which spends money the ledger was never told about. The cap is a
     * spend bound, so exceeding it must stop the call.
     */
    | 'reservation_cap_exceeded';

  constructor(reason: ModelInputRefused['reason']) {
    super(`model input refused: ${reason}`);
    this.reason = reason;
  }
}
