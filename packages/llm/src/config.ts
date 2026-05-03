import { asId } from "@ema-agent/core-types"
import type { ModelDescriptor, ModelId, ModelRole, ProviderId } from "@ema-agent/core-types"

import type { LlmConfigSnapshot, LlmProviderConfig, ModelBinding } from "./types.js"
import { TEXT_MODEL_CAPABILITIES, TOOL_MODEL_CAPABILITIES } from "./types.js"

type Env = Record<string, string | undefined>

/**
 * 从环境变量生成默认 LLM 配置。
 *
 * V1 是本地单人软件，所以这里先走“环境变量/进程内注入”的简单方案：
 * - 不在这里持久化 key。
 * - 不读取用户数据库。
 * - 后续接 Tauri secret store 时，只需要替换这一层配置来源。
 */
export function createDefaultLlmConfig(env: Env = {}): LlmConfigSnapshot {
  const providers = [
    createOpenAiConfig(env),
    createAnthropicConfig(env),
    createGeminiConfig(env),
    createDeepSeekConfig(env),
    createOpenRouterConfig(env),
    createOllamaConfig(env),
  ]

  return {
    providers,
    bindings: createDefaultBindings(),
  }
}

export function createOpenAiConfig(env: Env = {}): LlmProviderConfig {
  return {
    id: providerId("openai"),
    kind: "openai",
    displayName: "OpenAI",
    enabled: Boolean(env.OPENAI_API_KEY),
    baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: env.OPENAI_API_KEY,
    staticModels: [
      model("openai/gpt-4o-mini", "gpt-4o-mini", "openai", ["chat", "agent", "narrative", "title"], "tool"),
    ],
    modelAliases: {
      "openai/default-chat": env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
      "openai/default-agent": env.OPENAI_AGENT_MODEL ?? env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
      "openai/default-title": env.OPENAI_TITLE_MODEL ?? env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
    },
  }
}

export function createAnthropicConfig(env: Env = {}): LlmProviderConfig {
  return {
    id: providerId("anthropic"),
    kind: "anthropic",
    displayName: "Anthropic",
    enabled: Boolean(env.ANTHROPIC_API_KEY),
    baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    apiKey: env.ANTHROPIC_API_KEY,
    staticModels: [
      model("anthropic/claude-3-5-sonnet-latest", "claude-3-5-sonnet-latest", "anthropic", ["chat", "agent", "narrative"], "tool"),
    ],
    modelAliases: {
      "anthropic/default-chat": env.ANTHROPIC_CHAT_MODEL ?? "claude-3-5-sonnet-latest",
      "anthropic/default-agent": env.ANTHROPIC_AGENT_MODEL ?? env.ANTHROPIC_CHAT_MODEL ?? "claude-3-5-sonnet-latest",
    },
  }
}

export function createGeminiConfig(env: Env = {}): LlmProviderConfig {
  return {
    id: providerId("gemini"),
    kind: "gemini",
    displayName: "Gemini",
    enabled: Boolean(env.GEMINI_API_KEY),
    baseUrl: env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
    apiKey: env.GEMINI_API_KEY,
    staticModels: [
      model("gemini/gemini-1.5-pro", "gemini-1.5-pro", "gemini", ["chat", "agent", "narrative", "title"], "tool"),
    ],
    modelAliases: {
      "gemini/default-chat": env.GEMINI_CHAT_MODEL ?? "gemini-1.5-pro",
      "gemini/default-agent": env.GEMINI_AGENT_MODEL ?? env.GEMINI_CHAT_MODEL ?? "gemini-1.5-pro",
    },
  }
}

export function createDeepSeekConfig(env: Env = {}): LlmProviderConfig {
  return {
    id: providerId("deepseek"),
    kind: "openai-compatible",
    displayName: "DeepSeek",
    enabled: Boolean(env.DEEPSEEK_API_KEY),
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
    apiKey: env.DEEPSEEK_API_KEY,
    staticModels: [
      model("deepseek/deepseek-chat", "deepseek-chat", "deepseek", ["chat", "narrative", "title"], "text"),
    ],
    modelAliases: {
      "deepseek/default-chat": env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat",
    },
  }
}

export function createOpenRouterConfig(env: Env = {}): LlmProviderConfig {
  return {
    id: providerId("openrouter"),
    kind: "openai-compatible",
    displayName: "OpenRouter",
    enabled: Boolean(env.OPENROUTER_API_KEY),
    baseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY,
    headers: {
      ...(env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": env.OPENROUTER_HTTP_REFERER } : {}),
      ...(env.OPENROUTER_APP_TITLE ? { "X-Title": env.OPENROUTER_APP_TITLE } : {}),
    },
    staticModels: [
      model("openrouter/openai/gpt-4o-mini", "openai/gpt-4o-mini", "openrouter", ["chat", "agent", "narrative"], "tool"),
    ],
    modelAliases: {
      "openrouter/default-chat": env.OPENROUTER_CHAT_MODEL ?? "openai/gpt-4o-mini",
      "openrouter/default-agent": env.OPENROUTER_AGENT_MODEL ?? env.OPENROUTER_CHAT_MODEL ?? "openai/gpt-4o-mini",
    },
  }
}

export function createOllamaConfig(env: Env = {}): LlmProviderConfig {
  return {
    id: providerId("ollama"),
    kind: "openai-compatible",
    displayName: "Ollama",
    enabled: env.OLLAMA_ENABLED === "1",
    baseUrl: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    apiKey: env.OLLAMA_API_KEY,
    staticModels: [
      model("ollama/llama3.1", "llama3.1", "ollama", ["chat", "agent", "narrative", "title"], "text"),
    ],
    modelAliases: {
      "ollama/default-chat": env.OLLAMA_CHAT_MODEL ?? "llama3.1",
      "ollama/default-agent": env.OLLAMA_AGENT_MODEL ?? env.OLLAMA_CHAT_MODEL ?? "llama3.1",
    },
  }
}

function createDefaultBindings(): Record<ModelRole, ModelBinding> {
  return {
    chat: binding("chat", "openai", "openai/default-chat"),
    agent: binding("agent", "openai", "openai/default-agent"),
    narrative: binding("narrative", "deepseek", "deepseek/default-chat"),
    title: binding("title", "openai", "openai/default-title"),
    embedding: binding("embedding", "openai", "openai/default-chat"),
    rerank: binding("rerank", "openai", "openai/default-chat"),
  }
}

function binding(role: ModelRole, provider: string, modelIdValue: string): ModelBinding {
  return {
    role,
    providerId: providerId(provider),
    modelId: modelId(modelIdValue),
  }
}

function model(
  id: string,
  displayName: string,
  provider: string,
  roles: ModelRole[],
  capability: "text" | "tool",
  contextWindow = 128_000,
  maxOutputTokens = 8_192,
  source: "static" | "remote" = "static",
): ModelDescriptor {
  return {
    id: modelId(id),
    displayName,
    providerId: providerId(provider),
    roles,
    capabilities: capability === "tool" ? TOOL_MODEL_CAPABILITIES : TEXT_MODEL_CAPABILITIES,
    contextWindow,
    maxOutputTokens,
    source,
  }
}

function providerId(value: string): ProviderId {
  return asId<ProviderId>(value)
}

function modelId(value: string): ModelId {
  return asId<ModelId>(value)
}
