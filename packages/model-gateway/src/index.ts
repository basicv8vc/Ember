/**
 * `@ember/model-gateway` — the single place in this codebase that can reach a model provider.
 *
 * Deliberately absent, each omission load-bearing:
 * - streaming (B1 T-3 chose polling; a stream is a second wire contract);
 * - tool/function calling (every tool call is a denied egress category);
 * - internal retries (they multiply spend and hide failures; the Turn owns the attempt policy);
 * - model fallback or caller-selected routing (the exact model and route are approval-bound);
 * - provider hosts selected by configuration (the OpenAI and OpenRouter adapters pin their origins);
 * - response caching (a second copy of the transcript we would then have to delete).
 */
export {
  MODEL_BUDGET_ABSOLUTE_CEILINGS,
  MODEL_LIMITS,
  estimateTokensConservative,
  serializationOverheadTokens,
} from './limits.js';
export {
  MODEL_FAILURE_CODES,
  ModelGatewayFailure,
  ModelInputRefused,
  ModelAuthorizationRefused,
  isModelAuthorizationRefused,
  isModelGatewayFailure,
  isRetryableModelFailure,
  type ModelFailureCode,
  type ModelGatewayFailureDiagnostic,
} from './errors.js';
export type {
  ConversationAttachmentMetadata,
  ConversationDelegationCall,
  ConversationTurnInput,
  ConversationTurnOutput,
  ModelCallResult,
  ModelExecutionMode,
  ModelGateway,
  ModelMessage,
  ModelOperation,
  ModelProviderId,
  NotesActionItemsInput,
  NotesActionItemsOutput,
  PythonAgentInputFile,
  PythonAgentStepInput,
  PythonAgentStepMessage,
  PythonAgentStepOutput,
  RealModelProviderId,
  ModelUsage,
} from './types.js';
export {
  CONVERSATION_SYSTEM_PROMPT,
  NOTES_ACTION_ITEMS_SYSTEM_PROMPT,
  PYTHON_AGENT_SYSTEM_PROMPT,
  buildBoundedContext,
  type BoundedContext,
  type ContextRow,
} from './context.js';
export {
  preflightConversationTurn,
  preflightNotesActionItems,
  preflightPythonAgentStep,
  type TokenPreflight,
} from './preflight.js';
export {
  DELEGATE_NOTES_TOOL_NAME,
  DELEGATE_PYTHON_TOOL_NAME,
  DELEGATION_TOOLS,
  DEFAULT_DELEGATION_ACK_TEXT,
  DEFAULT_PYTHON_DELEGATION_ACK_TEXT,
  PYTHON_AGENT_TOOLS,
  RUN_PYTHON_TOOL_NAME,
  formatConversationMessageText,
} from './providers/shared.js';
export {
  APPROVED_MODEL_PROVIDERS,
  APPROVED_REAL_MODELS,
  MODEL_ID_PLACEHOLDER,
  MODEL_RATE_ROWS,
  PENDING_MODEL_CANDIDATES,
  estimateCostMicroUsd,
  evaluateApproval,
  findRateRow,
  isPastShutdown,
  utcDay,
  type ApprovalValidity,
  type ApprovedModel,
  type ModelApprovalBudgetCeilings,
  type ModelApprovalRecord,
  type ModelCandidate,
  type ModelRateRow,
  type ModelReasoningEffort,
  type OpenRouterRoutingPolicy,
  type StagingAlphaModelAuthorization,
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
  isModelExecutionAuthorized,
  resolveModelExecution,
  type ModelApprovalRegistry,
  type ModelBootRefusalReason,
  type ModelBudgetCeilings,
  type ModelExecutionInput,
  type ModelExecutionPurpose,
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
export {
  OPENROUTER_CHAT_COMPLETIONS_PATH,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OPENROUTER_ORIGIN,
  OpenRouterModelGateway,
  type OpenRouterModelGatewayOptions,
} from './providers/openrouter.js';
export { createModelGateway, type CreateModelGatewayOptions } from './gateway.js';
