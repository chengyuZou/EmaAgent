/**
 * Provider / Model / LLM Adapter 的核心类型。
 *
 * ## V1 实现范围
 *
 * - `ProviderDescriptor` — Provider 配置与健康检查
 * - `ModelDescriptor` / `ModelCapabilities` — 模型元数据与能力矩阵
 * - `ChatCompletionMessage` 联合类型 — LLM 底层消息协议（非前端渲染用）
 * - `ChatCompletionRequest` / `ChatCompletionChunk` — 请求/流式响应协议
 * - `ToolSpec` / `ToolCallChunk` — 工具声明与流式工具调用
 *
 * ## V2 规划
 *
 * - TTS / STT / Embedding / Rerank / ImageGen / Moderation 的完整请求响应协议
 * - V1 只保留类型骨架（接口已定义，实现侧暂时 throw NO_IMPLEMENTATION）
 */

import type { CredentialId, ModelId, ProviderId, RequestId, SessionId, ToolCallId, UnixMs } from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════

/**
 * Provider 的服务大类。
 *
 * V1 仅使用 `llm`。
 * `vision` / `tts` / `stt` / `embedding` / `rerank` / `image_gen` / `moderation` 为 V2 预留。
 */
export type ProviderCategory =
  | "llm"
  | "vision"       // V2
  | "tts"          // V2
  | "stt"          // V2
  | "embedding"    // V2
  | "rerank"       // V2
  | "image_gen"    // V2
  | "moderation"   // V2

/** Provider 的接入协议方式。 */
export type ProviderKind =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openai-compatible"
  | "anthropic-compatible"
  | "ollama"
  | "local-dev"

/** Provider 健康检查快照。 */
export interface ProviderHealthView {
  status: "unknown" | "ok" | "degraded" | "down" | "disabled"
  checkedAt?: UnixMs
  latencyMs?: number
  message?: string
}

/** Provider 管理面板中可用的操作按钮。 */
export interface ProviderAction {
  label: string
  /** 前端路由路径或回调标识。
   * @example "open_settings" | "open_models" | "toggle_enabled"
   */
  action: "open_settings" | "open_models" | "toggle_enabled" | string
  /** 是否为主要 CTA（亮蓝色胶囊按钮）。 */
  primary?: boolean
}

/**
 * Provider 的描述符——注册中心持久化的 Provider 元数据。
 *
 * @example
 * // LLM Provider 实例
 * const openaiProvider: ProviderDescriptor = {
 *   id: asId<ProviderId>("prov_openai"),
 *   displayName: "OpenAI",
 *   category: "llm",
 *   kind: "openai",
 *   enabled: true,
 *   configured: true,
 *   credentialId: asId<CredentialId>("cred_sk_xxx"),
 *   supportsRemoteModels: true,
 * }
 */
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

// ═══════════════════════════════════════════════════════════════
// Model
// ═══════════════════════════════════════════════════════════════

/**
 * 模型的业务角色——决定该模型在哪种 mode 下被选用。
 *
 * @example
 * // binding 配置示例
 * const bindings = {
 *   chat: "gpt-4o",
 *   agent: "claude-sonnet-4-6",
 *   narrative: "deepseek-v4",
 *   title: "gpt-4o-mini",
 * }
 */
export type ModelRole = "chat" | "agent" | "narrative" | "title" | "embedding" | "rerank"

/** 模型能力矩阵——前端据此显示/隐藏功能按钮。 */
export interface ModelCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  structuredOutput: boolean
  promptCache: boolean
  listModels: boolean
}

/**
 * 模型描述符——ModelCatalog 中的单个条目。
 *
 * @example
 * // GPT-4o 静态预设
 * const gpt4o: ModelDescriptor = {
 *   id: asId<ModelId>("gpt-4o"),
 *   displayName: "GPT-4o",
 *   providerId: asId<ProviderId>("prov_openai"),
 *   roles: ["chat", "agent", "narrative", "title"],
 *   capabilities: {
 *     streaming: true, tools: true, vision: true,
 *     structuredOutput: true, promptCache: false, listModels: false,
 *   },
 *   contextWindow: 128_000,
 *   maxOutputTokens: 16_384,
 *   pricing: { inputPer1M: 2.5, outputPer1M: 10 },
 *   source: "static",
 * }
 */
export interface ModelDescriptor {
  id: ModelId
  displayName: string
  providerId: ProviderId
  /** 一个模型可以有多个角色。如 GPT-4o 同时支持 chat、agent、narrative、title。 */
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

// ═══════════════════════════════════════════════════════════════
// LLM 消息协议（底层传输用，非前端渲染用）
// ═══════════════════════════════════════════════════════════════

/**
 * 底层 LLM 消息角色——OpenAI Chat Completions 标准四角色。
 *
 * 前端渲染使用 `MessageRole`（message.ts），两者不是同一概念：
 * - `ChatCompletionMessageRole` 用于组装发往 LLM 的请求体
 * - `MessageRole` 用于前端聊天气泡的角色标签
 */
export type ChatCompletionMessageRole = "system" | "user" | "assistant" | "tool"

/** 多模态消息的内容片段。 */
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string; detail?: "low" | "high" | "auto" } }

/**
 * 工具声明协议——发往 LLM 的 JSON Schema 工具定义。
 *
 * @example
 * // 声明一个 read_file 工具
 * const readFileSpec: ToolSpec = {
 *   name: "read_file",
 *   description: "读取指定路径的文件内容",
 *   parameters: {
 *     type: "object",
 *     properties: { path: { type: "string", description: "文件路径" } },
 *     required: ["path"],
 *   },
 * }
 */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * 流式响应中的工具调用增量片段。
 *
 * 与 `ToolIntent`（agent.ts）的区别：
 * - `ToolCallChunk`：LLM 原始流输出的 argumentsDelta（未解析的 JSON 片段）
 * - `ToolIntent`：解析完成后的结构化意图（完整 args 对象 + risk 预标注）
 *
 * @example
 * // OpenAI 流式 tool_calls 增量
 * const chunk: ToolCallChunk = {
 *   id: asId<ToolCallId>("tcu_001"),
 *   toolName: "read_file",
 *   argumentsDelta: '{"path":',  // 增量 JSON 片段
 *   index: 0,
 * }
 */
export interface ToolCallChunk {
  id: ToolCallId
  toolName: string
  /** 参数 JSON 字符串的增量片段（流式）或完整字符串（非流式）。 */
  argumentsDelta: string
  index?: number
}

// ═══════════════════════════════════════════════════════════════
// ChatCompletionMessage 联合类型
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// LLM 请求 / 响应
// ═══════════════════════════════════════════════════════════════

/**
 * LLM 聊天补全请求——LlmAdapter.stream() 和 LlmAdapter.complete() 的统一入参。
 *
 * @example
 * // Agent mode 的 LLM 请求
 * const req: ChatCompletionRequest = {
 *   requestId: asId<RequestId>("req_001"),
 *   sessionId: asId<SessionId>("ses_001"),
 *   modelId: asId<ModelId>("gpt-4o"),
 *   messages: [
 *     { role: "system", content: "You are Ema..." },
 *     { role: "user", content: "帮我修复 bug" },
 *   ],
 *   stream: true,
 *   tools: [readFileSpec],
 *   maxTokens: 4_096,
 * }
 */
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
  /** 特定提供商的专属高级参数（seed、thinking 等）。 */
  providerOptions?: Record<string, unknown>
}

/**
 * LLM 流式响应的单个文本增量块。
 *
 * @example
 * // Anthropic 流式 text_delta 转换后的归一化格式
 * const chunk: ChatCompletionChunk = {
 *   index: 0,
 *   delta: { content: "你好" },
 *   usage: { inputTokens: 150, outputTokens: 2, totalTokens: 152 },
 * }
 */
export interface ChatCompletionChunk {
  id?: string
  index: number
  delta: { content?: string }
  toolCalls?: ToolCallChunk[]
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "error" | null
  raw?: unknown
}

/**
 * 标准用量视图——所有 LLM 调用的统一 tokens 统计。
 *
 * LLM adapter 返回此结构，`estimateUsageCost()` 在其基础上追加 cost 估算。
 *
 * @example
 * // Anthropic Messages API 返回的 usage
 * const usage: UsageView = {
 *   inputTokens: 1200,
 *   outputTokens: 350,
 *   totalTokens: 1550,
 *   costUsd: 0.0055,
 * }
 */
export interface UsageView {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd?: number
}

// ═══════════════════════════════════════════════════════════════
// V2 预留：多模态协议（V1 不实现）
// ═══════════════════════════════════════════════════════════════

/**
 * V2 — TTS 请求协议。
 *
 * @deprecated V1 不实现，仅保留类型骨架供 V2 对齐。
 */
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

/** @deprecated V1 不实现。 */
export interface TtsChunk {
  id?: string
  index: number
  audioData: ArrayBuffer | Blob
  latencyMs?: number
}

/** @deprecated V1 不实现。 */
export interface TtsResponse {
  audioData: ArrayBuffer | Blob
  durationMs?: number
}

/** @deprecated V1 不实现。 */
export interface SttRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  audioData: ArrayBuffer | Blob
  languageHint?: string
  providerOptions?: Record<string, unknown>
}

/** @deprecated V1 不实现。 */
export interface SttResponse {
  text: string
  durationMs?: number
}

/** @deprecated V1 不实现。 */
export interface EmbeddingRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  input: string | string[]
  providerOptions?: Record<string, unknown>
}

/** @deprecated V1 不实现。 */
export interface EmbeddingResponse {
  embeddings: number[][]
  usage?: { inputTokens: number; totalTokens: number }
}
