/**
 * `@ember/model-gateway` — the single place in this codebase that can reach a model provider.
 *
 * Deliberately absent, each omission load-bearing:
 * - streaming (B1 T-3 chose polling; a stream is a second wire contract);
 * - tool/function calling (every tool call is a denied egress category);
 * - internal retries (they multiply spend and hide failures; the Turn owns the attempt policy);
 * - a model registry or routing (routing is a cost decision nobody has approved);
 * - a second provider (doubles credential, egress and retention review for zero Alpha value);
 * - response caching (a second copy of the transcript we would then have to delete).
 */
export { MODEL_BUDGET_ABSOLUTE_CEILINGS, MODEL_LIMITS } from './limits.js';
export {
  MODEL_FAILURE_CODES,
  ModelGatewayFailure,
  ModelInputRefused,
  isModelGatewayFailure,
  isRetryableModelFailure,
  type ModelFailureCode,
} from './errors.js';
export type {
  ConversationTurnInput,
  ConversationTurnOutput,
  ModelCallResult,
  ModelExecutionMode,
  ModelGateway,
  ModelMessage,
  ModelOperation,
  ModelProviderId,
  ModelUsage,
} from './types.js';
export {
  CONVERSATION_SYSTEM_PROMPT,
  buildBoundedContext,
  type BoundedContext,
  type ContextRow,
} from './context.js';
export { preflightConversationTurn, type TokenPreflight } from './preflight.js';
export {
  APPROVED_MODEL_PROVIDERS,
  APPROVED_REAL_MODELS,
  MODEL_ID_PLACEHOLDER,
  MODEL_RATE_ROWS,
  estimateCostMicroUsd,
  findRateRow,
  type ApprovedModel,
  type ModelRateRow,
} from './rates.js';
export {
  MODEL_CREDENTIAL_PLACEHOLDER,
  ModelCredential,
  type CredentialRefusal,
} from './credentials.js';
export {
  DEFAULT_MODEL_APPROVAL_REGISTRY,
  DEFAULT_MODEL_CEILINGS,
  isRealExecution,
  resolveModelExecution,
  type ModelApprovalRegistry,
  type ModelBootRefusalReason,
  type ModelBudgetCeilings,
  type ModelExecutionInput,
  type ModelExecutionResolution,
  type ModelExecutionSettings,
} from './config.js';
export {
  FAKE_MODEL_LABEL,
  FAKE_REPLY_PREFIX,
  FakeModelGateway,
  type FakeModelGatewayOptions,
} from './fake.js';
export {
  OPENAI_CHAT_COMPLETIONS_PATH,
  OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_ORIGIN,
  OpenAiModelGateway,
  statusToFailureCode,
  type FetchLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
  type OpenAiGatewayOptions,
} from './providers/openai.js';
export { createModelGateway, type CreateModelGatewayOptions } from './gateway.js';
