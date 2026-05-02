import { asId } from "@ema-agent/core-types"
import type { ProviderId } from "@ema-agent/core-types"

import type { LlmConfigSnapshot, LlmProviderConfig } from "./types.js"

type Env = Record<string, string | undefined>

/**
 * 默认 LLM 配置骨架。
 *
 * 这里只声明 EmaAgent 预期支持哪些 provider。
 * API key、model alias、默认绑定等具体策略后面再补。
 */
export function createDefaultLlmConfig(env: Env = {}): LlmConfigSnapshot {
  return {
    providers: [
      createOpenAiConfig(env),
      createAnthropicConfig(env),
      createGeminiConfig(env),
      createDeepSeekConfig(env),
      createOpenRouterConfig(env),
      createOllamaConfig(env),
    ],
    bindings: {},
  }
}

export function createOpenAiConfig(env: Env = {}): LlmProviderConfig {
  void env
  return {
    id: asProviderId("openai"),
    kind: "openai",
    displayName: "OpenAI",
    enabled: false,
    baseUrl: "",
    staticModels: [],
  }
}

export function createAnthropicConfig(env: Env = {}): LlmProviderConfig {
  void env
  return {
    id: asProviderId("anthropic"),
    kind: "anthropic",
    displayName: "Anthropic",
    enabled: false,
    baseUrl: "",
    staticModels: [],
  }
}

export function createGeminiConfig(env: Env = {}): LlmProviderConfig {
  void env
  return {
    id: asProviderId("gemini"),
    kind: "gemini",
    displayName: "Gemini",
    enabled: false,
    baseUrl: "",
    staticModels: [],
  }
}

export function createDeepSeekConfig(env: Env = {}): LlmProviderConfig {
  void env
  return {
    id: asProviderId("deepseek"),
    kind: "openai-compatible",
    displayName: "DeepSeek",
    enabled: false,
    baseUrl: "",
    staticModels: [],
  }
}

export function createOpenRouterConfig(env: Env = {}): LlmProviderConfig {
  void env
  return {
    id: asProviderId("openrouter"),
    kind: "openai-compatible",
    displayName: "OpenRouter",
    enabled: false,
    baseUrl: "",
    staticModels: [],
  }
}

export function createOllamaConfig(env: Env = {}): LlmProviderConfig {
  void env
  return {
    id: asProviderId("ollama"),
    kind: "openai-compatible",
    displayName: "Ollama",
    enabled: false,
    baseUrl: "",
    staticModels: [],
  }
}

function asProviderId(value: string): ProviderId {
  return asId<ProviderId>(value)
}
