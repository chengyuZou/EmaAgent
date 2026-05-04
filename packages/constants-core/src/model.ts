/**
 * Model / Provider 常量 — 角色全集、Provider 类型、能力矩阵、默认模型、定价。
 */

import type {
  ModelRole,
  ProviderCategory,
  ProviderKind,
  ChatCompletionMessageRole,
} from "@ema-agent/core-types"

// ═══════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════

/** Provider 服务大类全集。 */
export const PROVIDER_CATEGORIES = [
  "llm",
  "vision",
  "tts",
  "stt",
  "embedding",
  "rerank",
  "image_gen",
  "moderation",
] as const satisfies readonly ProviderCategory[]

/** Provider 接入协议类型全集。 */
export const PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "gemini",
  "openai-compatible",
  "anthropic-compatible",
  "ollama",
  "local-dev",
] as const satisfies readonly ProviderKind[]

/** Provider 健康状态全集。 */
export const PROVIDER_HEALTH_STATUSES = ["unknown", "ok", "degraded", "down", "disabled"] as const

/** Provider 选择优先级（高→低）。 */
export const PROVIDER_PRIORITY: readonly ProviderKind[] = [
  "openai",
  "anthropic",
  "gemini",
  "openai-compatible",
  "anthropic-compatible",
  "ollama",
  "local-dev",
] as const

// ═══════════════════════════════════════════════════════════════
// Model Role
// ═══════════════════════════════════════════════════════════════

/** 全部 11 种 ModelRole。 */
export const MODEL_ROLES = [
  "chat",
  "agent",
  "narrative",
  "title",
  "embedding",
  "rerank",
  "tts",
  "stt",
  "image_gen",
  "vision",
  "moderation",
] as const satisfies readonly ModelRole[]

/** LLM 消息四角色（OpenAI Chat Completions 标准）。 */
export const CHAT_MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const satisfies readonly ChatCompletionMessageRole[]

// ═══════════════════════════════════════════════════════════════
// 默认上下文窗口 & 输出限制
// ═══════════════════════════════════════════════════════════════

/** 各 Provider 默认上下文窗口。 */
export const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  openai: 128_000,
  anthropic: 200_000,
  gemini: 128_000,
  openrouter: 128_000,
  deepseek: 128_000,
  ollama: 16_000,
  "local-dev": 16_000,
}

/** 各 Provider 默认最大输出 token。 */
export const DEFAULT_MAX_OUTPUT_TOKENS: Record<string, number> = {
  openai: 16_384,
  anthropic: 8_192,
  gemini: 8_192,
  openrouter: 8_192,
  deepseek: 8_192,
  ollama: 2_048,
  "local-dev": 2_048,
}

/** 上下文窗口 fallback（未知 provider 时使用）。 */
export const FALLBACK_CONTEXT_WINDOW = 128_000
export const FALLBACK_MAX_OUTPUT_TOKENS = 8_192

// ═══════════════════════════════════════════════════════════════
// 默认模型 ID
// ═══════════════════════════════════════════════════════════════

/** 各 Provider 的默认模型。 */
export const DEFAULT_MODEL_IDS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
  gemini: "gemini-1.5-pro",
  deepseek: "deepseek-chat",
  openrouter: "openai/gpt-4o-mini",
  ollama: "llama3.1",
  "local-dev": "local-dev/default-chat",
}

// ═══════════════════════════════════════════════════════════════
// 默认定价（USD per 1M tokens）
// ═══════════════════════════════════════════════════════════════

/** 默认模型定价（输入/输出 USD per 1M tokens）。 */
export const DEFAULT_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "gpt-4o-mini":          { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o":               { inputPer1M: 2.5,  outputPer1M: 10 },
  "claude-3-5-sonnet":   { inputPer1M: 3,    outputPer1M: 15 },
  "claude-3-5-haiku":    { inputPer1M: 1.25, outputPer1M: 5 },
  "gemini-1.5-pro":      { inputPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-chat":       { inputPer1M: 0.14, outputPer1M: 0.28 },
}
