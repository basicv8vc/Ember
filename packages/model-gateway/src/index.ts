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
  CreateProactiveScheduleCall,
  CreateProactiveScheduleToolArguments,
  DeletePersonalMemoryCall,
  DeletePersonalMemoryTarget,
  ModelCallResult,
  ModelExecutionMode,
  ModelGateway,
  ModelMessage,
  ModelOperation,
  ModelProviderId,
  NotesActionItemsInput,
  NotesActionItemsOutput,
  PersonalMemoryContextItem,
  PythonAgentInputFile,
  PythonAgentStepInput,
  PythonAgentStepMessage,
  PythonAgentStepOutput,
  RealModelProviderId,
  SavePersonalMemoryCall,
  ModelUsage,
} from './types.js';
export {
  CONVERSATION_SYSTEM_PROMPT,
  NOTES_ACTION_ITEMS_SYSTEM_PROMPT,
  PERSONAL_MEMORY_CONTEXT_HEADER,
  PERSONAL_MEMORY_SAVE_SYSTEM_INSTRUCTION,
  PROACTIVE_SCHEDULE_CREATE_SYSTEM_INSTRUCTION,
  PYTHON_AGENT_SYSTEM_PROMPT,
  SCHEDULED_BRIEF_SYSTEM_PROMPT,
  WEB_SEARCH_SYSTEM_INSTRUCTION,
  buildBoundedContext,
  buildBoundedPersonalMemoryContext,
  type BoundedContext,
  type BoundedPersonalMemoryContext,
  type ContextRow,
} from './context.js';
export {
  IMAGE_ATTACHMENT_TOKEN_ESTIMATE,
  fitConversationTurnInputToCap,
  preflightConversationTurn,
  preflightNotesActionItems,
  preflightPythonAgentStep,
  type ConversationTurnPreflightInput,
  type TokenPreflight,
} from './preflight.js';
export {
  COMMITTED_MEMORY_DELETED_REPLY,
  COMMITTED_MEMORY_SAVED_REPLY,
  COMMITTED_MEMORY_UPDATED_REPLY,
  CONVERSATION_TOOLS_WITH_MEMORY,
  DELEGATE_NOTES_TOOL_NAME,
  DELEGATE_PYTHON_TOOL_NAME,
  DELEGATION_TOOLS,
  DEFAULT_DELEGATION_ACK_TEXT,
  DEFAULT_MEMORY_DELETE_ACK_TEXT,
  DEFAULT_MEMORY_SAVE_ACK_TEXT,
  DEFAULT_PYTHON_DELEGATION_ACK_TEXT,
  DELETE_PERSONAL_MEMORY_TOOL,
  DELETE_PERSONAL_MEMORY_TOOL_NAME,
  NO_CONVERSATION_TOOLS,
  PYTHON_AGENT_TOOLS,
  RUN_PYTHON_TOOL_NAME,
  SAVE_PERSONAL_MEMORY_TOOL,
  SAVE_PERSONAL_MEMORY_TOOL_NAME,
  WEB_FETCH_TOOL,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_TOOL_NAME,
  formatConversationMessageText,
  getConversationTools,
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
  DEEPSEEK_CHAT_COMPLETIONS_PATH,
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DEEPSEEK_ORIGIN,
  DeepSeekModelGateway,
  type DeepSeekModelGatewayOptions,
} from './providers/deepseek.js';
export {
  OPENROUTER_CHAT_COMPLETIONS_PATH,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OPENROUTER_ORIGIN,
  OpenRouterModelGateway,
  type OpenRouterModelGatewayOptions,
} from './providers/openrouter.js';
export { createModelGateway, type CreateModelGatewayOptions } from './gateway.js';
export {
  EXA_CONTENTS_PATH,
  EXA_CONTENTS_URL,
  EXA_SEARCH_ORIGIN,
  EXA_SEARCH_PATH,
  EXA_SEARCH_URL,
  ExaWebSearchClient,
  WEB_FETCH_LIMITS,
  WEB_SEARCH_LIMITS,
  formatWebFetchToolOutput,
  formatWebSearchToolOutput,
  sanitizePublicWebUrl,
  validateWebFetchUrl,
  validateWebSearchQueryPrivacy,
  type ExaWebSearchClientOptions,
  type WebFetchRequest,
  type WebFetchResponse,
  type WebFetchValidationReason,
  type WebFetchValidationResult,
  type WebSearchPort,
  type WebSearchPrivacyViolationReason,
  type WebSearchQueryPrivacyContext,
  type WebSearchQueryPrivacyResult,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResultItem,
} from './web-search.js';
export {
  WEB_EVIDENCE_COLLECTOR_LIMITS,
  WebEvidenceCollector,
  canonicalizeWebEvidenceUrl,
  extractDomainFromUrl,
  type FetchEvidenceResultInput,
  type SearchEvidenceResultInput,
  type WebEvidence,
  type WebEvidenceStatus,
  type WebSource,
} from './web-evidence.js';
export {
  FakeStreamingModelGateway,
  FAKE_STREAM_MAX_REPLY_CHARS,
  FAKE_V2_RATE_VERSION,
  type FakeConversationJob,
  type FakeConversationJobStatus,
  type FakeConversationJobStore,
  type FakeConversationStreamEvent,
  type FakeConversationStreamRequest,
  type FakeConversationUsageStatus,
} from './fake-stream.js';
export { LoopbackFakeModelGateway } from './fake-loopback.js';
