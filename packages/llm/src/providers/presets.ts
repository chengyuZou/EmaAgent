import { asId } from "@ema-agent/core-types"
import type { ProviderId } from "@ema-agent/core-types"

import type { LlmConfig, LlmProviderSpec } from "./spec.js"

type Env = Record<string, string | undefined>

/**
 * 从环境变量生成默认配置，仅用于本地开发。
 * 生产环境走数据库读取，不经过此函数。
 */
export function createDefaultConfig(env: Env = {}): LlmConfig {
  return {
    providers: [
      createOpenAiSpec(env),
      createAnthropicSpec(env),
      createGeminiSpec(env),
      createDeepSeekSpec(env),
      createOpenRouterSpec(env),
      createOllamaSpec(env),
    ],
  }
}

export function createOpenAiSpec(env: Env = {}): LlmProviderSpec {
  return {
    id: pid("openai"),
    kind: "openai",
    displayName: "OpenAI",
    enabled: Boolean(env.OPENAI_API_KEY),
    baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: env.OPENAI_API_KEY,
  }
}

export function createAnthropicSpec(env: Env = {}): LlmProviderSpec {
  return {
    id: pid("anthropic"),
    kind: "anthropic",
    displayName: "Anthropic",
    enabled: Boolean(env.ANTHROPIC_API_KEY),
    baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    apiKey: env.ANTHROPIC_API_KEY,
  }
}

export function createGeminiSpec(env: Env = {}): LlmProviderSpec {
  return {
    id: pid("gemini"),
    kind: "gemini",
    displayName: "Gemini",
    enabled: Boolean(env.GEMINI_API_KEY),
    baseUrl: env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
    apiKey: env.GEMINI_API_KEY,
  }
}

export function createDeepSeekSpec(env: Env = {}): LlmProviderSpec {
  return {
    id: pid("deepseek"),
    kind: "openai-compatible",
    displayName: "DeepSeek",
    enabled: Boolean(env.DEEPSEEK_API_KEY),
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    apiKey: env.DEEPSEEK_API_KEY,
  }
}

export function createOpenRouterSpec(env: Env = {}): LlmProviderSpec {
  return {
    id: pid("openrouter"),
    kind: "openai-compatible",
    displayName: "OpenRouter",
    enabled: Boolean(env.OPENROUTER_API_KEY),
    baseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY,
    headers: {
      ...(env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": env.OPENROUTER_HTTP_REFERER } : {}),
      ...(env.OPENROUTER_APP_TITLE ? { "X-Title": env.OPENROUTER_APP_TITLE } : {}),
    },
  }
}

export function createOllamaSpec(env: Env = {}): LlmProviderSpec {
  return {
    id: pid("ollama"),
    kind: "openai-compatible",
    displayName: "Ollama",
    enabled: env.OLLAMA_ENABLED === "1",
    baseUrl: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    apiKey: env.OLLAMA_API_KEY,
  }
}

function pid(value: string): ProviderId {
  return asId<ProviderId>(value)
}
