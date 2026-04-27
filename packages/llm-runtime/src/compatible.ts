/**
 * OpenAI-compatible Provider 导入入口。
 *
 * 用于 DeepSeek / OpenRouter / Ollama 这类 `/chat/completions` 兼容服务。
 */

export {
  OpenAICompatibleProvider,
  DeepSeekCompatibleProvider,
  OpenRouterCompatibleProvider,
  OllamaCompatibleProvider,
} from "./adapters/openai-compatible.js";

export type {
  OpenAICompatibleProviderConfig,
  DeepSeekCompatibleProviderConfig,
  OpenRouterCompatibleProviderConfig,
  OllamaCompatibleProviderConfig,
} from "./adapters/openai-compatible.js";
