export { LlmRouter }                                      from './router.js';
export { ModelsDevCatalog, MODELS_DEV_API_URL }           from './models-dev-catalog.js';
export type { ModelsDevSpec }                             from './models-dev-catalog.js';
export { validateContentParts }                           from './validate.js';
export { computePromptPrefixHash, normalizeToolDefinitions } from './prompt-cache.js';
export { withRetry } from './retry.js';
export type { RetryOptions } from './retry.js';
export { CircuitBreaker, LlmStreamRuntime } from './stream-runtime.js';
export type {
  CircuitBreakerOptions,
  CircuitPermit,
  LlmCompatibilityRecovery,
  LlmStreamRuntimeOptions,
} from './stream-runtime.js';

export type { LlmAdapter }                   from './adapters/base.js';
export { OpenAiResponsesAdapter }            from './adapters/openai-responses.js';
export type { UnsupportedPart }              from './validate.js';

export {
  CircuitOpenError,
  ContextWindowExceededError,
  llmProviderErrorCode,
  LlmProviderResponseError,
  LlmStreamProtocolError,
  LlmToolArgumentsParseError,
  LlmModelCapabilityError,
} from './errors.js';
export type { LlmCapabilityIssue } from './errors.js';
export {
  capabilitiesFromCatalog,
  capabilitiesFromManualVision,
  unknownModelCapabilities,
} from './model-capabilities.js';
export type {
  ModelCapabilitySnapshot,
  ModelCapabilitySource,
  ModelCapabilityState,
} from './model-capabilities.js';
export {
  prepareHistoricalMessageView,
  validateCurrentContent,
  validateMessageCapabilities,
} from './message-compatibility.js';
export { createCompatibilityRecovery } from './compatibility-recovery.js';
export type { CompatibilityRecoveryController } from './compatibility-recovery.js';
export { advanceLlmUsageSnapshot } from './usage.js';
export type {
  CompatibleMessageView,
  InputModality,
  MessageCompatibilityAction,
  MessageCompatibilityIssue,
} from './message-compatibility.js';
export type {
  LlmProtocol,
  LlmTokenUsage,
  StopReason,
  ProviderConfig,
  ThinkingEffort,
  ThinkingMode,
  LlmToolDef,
  LlmMessage,
  LlmRequest,
  LlmStreamChunk,
  LlmContentPart,
  LlmCompletion,
  AssistantBlock,
  UserBlock,
  ProbeResult,
} from './types.js';
