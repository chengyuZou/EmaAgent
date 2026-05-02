/**
 * Provider / Model / LLM Adapter 的核心类型。
 *
 * 这里不绑定任何具体 SDK，只定义 registry、catalog、capability probe
 * 和 role binding 之间共享的稳定契约。
 */

import type { CredentialId, ModelId, ProviderId, RequestId, SessionId, ToolCallId, UnixMs } from "./ids.js"

// ==========================================
// Provider
// ==========================================

/** Provider 的服务大类（按功能拆分）。 */
export type ProviderCategory =
  | "llm"
  | "vision"
  | "tts"
  | "stt"
  | "embedding"
  | "rerank"
  | "image_gen"
  | "moderation"

/** Provider 的接入协议方式。 */
export type ProviderKind =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openai-compatible"
  | "anthropic-compatible"
  | "ollama"
  | "local-dev"

export interface ProviderHealthView {
  status: "unknown" | "ok" | "degraded" | "down"
  checkedAt?: UnixMs
  latencyMs?: number
  message?: string
}

export interface ProviderAction {
  label: string
  /** 前端路由路径或回调标识。 */
  action: "open_settings" | "open_models" | "toggle_enabled" | string
  /** 是否为主要 CTA（亮蓝色胶囊按钮）。 */
  primary?: boolean
}

export interface ProviderDescriptor {
  id: ProviderId
  displayName: string
  category: ProviderCategory
  kind: ProviderKind
  website?: string
  icon?: string
  enabled: boolean
  configured: boolean
  credentialId?: CredentialId
  supportsRemoteModels?: boolean
  health?: ProviderHealthView
  actions?: ProviderAction[]
}

// ==========================================
// Model
// ==========================================

export type ModelRole = "chat" | "agent" | "narrative" | "title" | "embedding" | "rerank"

export interface ModelCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  structuredOutput: boolean
  promptCache: boolean
  listModels: boolean
}

export interface ModelDescriptor {
  id: ModelId
  displayName: string
  providerId: ProviderId
  /** 一个模型可以有多个角色
   * @example
   * GPT-4 可以同时支持 chat、agent、narrative 和 title 角色，前端可以根据不同角色的需求选择性展示。
   */
  roles: ModelRole[]
  capabilities: ModelCapabilities
  contextWindow: number
  maxOutputTokens: number
  pricing?: {
    inputPer1M?: number
    outputPer1M?: number
  }
  /** 模型来源：static（系统预设）、remote（Provider 动态获取）、user（用户自定义）。 */
  source?: "static" | "remote" | "user"
  updatedAt?: UnixMs
}

// ==========================================
// LLM 消息协议（底层传输用，非前端渲染用）
// ==========================================

export type ChatCompletionMessageRole = "system" | "user" | "assistant" | "tool"

export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string; detail?: "low" | "high" | "auto" } }

/** 工具声明协议（基于 JSON Schema）。 */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 流式响应中的工具调用片段。 */
export interface ToolCallChunk {
  id: ToolCallId
  toolName: string
  /** 参数 JSON 字符串的增量片段（流式）或完整字符串（非流式）。 */
  argumentsDelta: string
}

// ---- Discriminated Unions ----

export interface SystemMessage {
  role: "system"
  content: string
}

export interface UserMessage {
  role: "user"
  content: string | MessageContentPart[]
}

export interface AssistantMessage {
  role: "assistant"
  content: string | null
  toolCalls?: ToolCallChunk[]
}

export interface ToolMessage {
  role: "tool"
  toolCallId: ToolCallId
  content: string
  toolName?: string
}

export type ChatCompletionMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage

// ==========================================
// LLM 请求 / 响应
// ==========================================

export interface ChatCompletionRequest {
  requestId: RequestId
  sessionId: SessionId
  traceId?: string
  modelId: ModelId
  messages: ChatCompletionMessage[]
  stream?: boolean
  tools?: ToolSpec[]
  temperature?: number
  maxTokens?: number
  topP?: number
  /** 特定提供商的专属高级参数，如 seed、thinking 等。 */
  providerOptions?: Record<string, unknown>
}

/** 流式响应块。 */
export interface ChatCompletionChunk {
  id?: string
  index: number
  delta: { content?: string }
  toolCalls?: ToolCallChunk[]
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | null
}

// ==========================================
// 其他模态协议
// ==========================================

export interface TtsRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  text: string
  speed?: number
  responseFormat?: "mp3" | "wav" | "ogg"
  stream?: boolean
  providerOptions?: Record<string, unknown>
}

export interface TtsChunk {
  id?: string
  index: number
  audioData: ArrayBuffer | Blob
  latencyMs?: number
}

export interface TtsResponse {
  audioData: ArrayBuffer | Blob
  durationMs?: number
}

export interface SttRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  audioData: ArrayBuffer | Blob
  languageHint?: string
  providerOptions?: Record<string, unknown>
}

export interface SttResponse {
  text: string
  durationMs?: number
}

export interface EmbeddingRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  input: string | string[]
  providerOptions?: Record<string, unknown>
}

export interface EmbeddingResponse {
  embeddings: number[][]
  usage?: { inputTokens: number; totalTokens: number }
}
