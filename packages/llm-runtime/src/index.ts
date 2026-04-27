export type { LlmProvider, EmbeddingProvider, Reranker } from "./provider.js";
export {
  registerLlmProvider,
  listProviders,
  listModelsByProvider,
  resolveProviderByModelId,
  streamComplete,
  completeText,
} from "./router.js";

export {
  OPENAI_NATIVE_MODELS,
  ANTHROPIC_NATIVE_MODELS,
  GEMINI_NATIVE_MODELS,
  DEEPSEEK_COMPATIBLE_MODELS,
  OPENROUTER_COMPATIBLE_MODELS,
  OLLAMA_COMPATIBLE_MODELS,
} from "./catalog.js";

export {
  OpenAINativeProvider,
  OpenAIProvider,
  AnthropicNativeProvider,
  GeminiNativeProvider,
  OpenAICompatibleProvider,
  DeepSeekCompatibleProvider,
  OpenRouterCompatibleProvider,
  OllamaCompatibleProvider,
} from "./adapters/index.js";

export type {
  OpenAINativeProviderConfig,
  AnthropicNativeProviderConfig,
  GeminiNativeProviderConfig,
  OpenAICompatibleProviderConfig,
  DeepSeekCompatibleProviderConfig,
  OpenRouterCompatibleProviderConfig,
  OllamaCompatibleProviderConfig,
} from "./adapters/index.js";

export {
  LlmProviderError,
  missingApiKeyError,
  responseToProviderError,
  unknownToProviderError,
  isRetryableCode,
} from "./errors.js";

export type {
  ProviderErrorCode,
  LlmProviderErrorOptions,
} from "./errors.js";

export {
  estimateTokens,
  normalizeOpenAIUsage,
  normalizeAnthropicUsage,
  normalizeGeminiUsage,
  normalizeOpenAICompatibleUsage,
  mergeUsage,
} from "./usage.js";

export type {
  TokenUsage,
} from "./usage.js";

export type {
  NativeProviderConfig,
  ProviderHealthCheckResult,
  ProviderRuntimeIntrospection,
  RuntimeFetch,
} from "./types.js";
