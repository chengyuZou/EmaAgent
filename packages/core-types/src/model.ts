/**
 * Provider / Model / LLM Adapter / 多模态 的核心类型。
 *
 * ## 实现范围
 *
 * - `ProviderDescriptor` — Provider 配置与健康检查
 * - `ModelDescriptor` / `ModelCapabilities` — 模型元数据与能力矩阵
 * - `ChatCompletionMessage` 联合类型 — LLM 底层消息协议
 * - `ChatCompletionRequest` / `ChatCompletionChunk` — 请求/流式响应协议
 * - `ToolSpec` / `ToolCallChunk` — 工具声明与流式工具调用
 * - TTS / STT / ImageGen / Vision / Embedding / Moderation — 完整多模态协议
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

/**
 * Provider 的接入协议方式——决定走哪个 LlmEngine 实现。
 *
 * 注意：这是"协议归类"，不是"产品身份"。
 * - DeepSeek / OpenRouter / Ollama 都用 OpenAI 协议，所以 kind 都是 `openai-compatible`，
 *   但它们的 ProviderId 仍然各自独立（`deepseek` / `openrouter` / `ollama`）。
 * - 不再保留 `anthropic-compatible`（生态太小）和 `ollama`（已合并到 openai-compatible）。
 */
export type ProviderKind =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openai-compatible"
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
 * 模型的业务角色——编排层用于绑定"某个 mode 用哪个模型"的配置概念。
 * LLM 执行层（LlmClient）不感知此类型，仅数据库实体和编排层使用。
 */
export type ModelRole =
  | "chat"
  | "agent"
  | "narrative"
  | "title"
  | "embedding"
  | "rerank"
  | "tts"
  | "stt"
  | "image_gen"
  | "vision"
  | "moderation"

/** 模型能力矩阵——前端据此显示/隐藏功能按钮。 */
export interface ModelCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  structuredOutput: boolean
  promptCache: boolean
  listModels: boolean
  /** TTS 语音合成。 */
  tts: boolean
  /** STT 语音识别。 */
  stt: boolean
  /** 图片生成。 */
  imageGen: boolean
  /** 视频生成（V2+）。 */
  videoGen: boolean
  /** 内容审核。 */
  moderation: boolean
}

/**
 * 模型描述符——ModelCatalog 中的单个条目。
 * 描述模型本身的能力与规格，不含业务角色（角色绑定由编排层负责）。
 *
 * @example
 * const gpt4o: ModelDescriptor = {
 *   id: asId<ModelId>("gpt-4o"),
 *   displayName: "GPT-4o",
 *   providerId: asId<ProviderId>("openai"),
 *   capabilities: { streaming: true, tools: true, vision: true, ... },
 *   contextWindow: 128_000,
 *   maxOutputTokens: 16_384,
 *   pricing: { inputPer1M: 2.5, outputPer1M: 10 },
 *   source: "remote",
 * }
 */
export interface ModelDescriptor {
  id: ModelId
  displayName: string
  providerId: ProviderId
  capabilities?: Partial<ModelCapabilities>
  contextWindow: number
  maxOutputTokens: number
  pricing?: {
    inputPer1M?: number
    outputPer1M?: number
  }
  /** 模型来源：remote（Provider 动态拉取）、user（用户自定义添加）。 */
  source?: "remote" | "user"
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
 * 标准用量视图——所有 LLM / 多模态调用的统一 tokens 统计。
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
// 多模态协议——完整请求/响应类型
// ═══════════════════════════════════════════════════════════════

// ---- Embedding / Rerank ----

/** Embedding 向量化请求。 */
export interface EmbeddingRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  /** 单条或多条输入文本——批量向量化。 */
  input: string | string[]
  /** 向量维度（部分模型支持截断，如 OpenAI text-embedding-3）。 */
  dimensions?: number
  providerOptions?: Record<string, unknown>
}

/** Embedding 向量化响应。 */
export interface EmbeddingResponse {
  /** 向量列表（与 input 顺序一致）。 */
  embeddings: number[][]
  /** 模型实际输出的向量维度。 */
  dimensions?: number
  usage?: { inputTokens: number; totalTokens: number }
}

/** Rerank 重排序请求——对候选文档按语义相关性重新排序。 */
export interface RerankRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  query: string
  /** 候选文档列表。 */
  documents: string[]
  /** 返回前 N 条（默认全部）。 */
  topN?: number
  providerOptions?: Record<string, unknown>
}

/** Rerank 重排序响应。 */
export interface RerankResponse {
  /** 按相关性降序排列的结果。 */
  results: Array<{
    index: number
    document: string
    relevanceScore: number
  }>
  usage?: { totalTokens: number }
}

// ---- TTS（Text-to-Speech）----
// 详细类型定义在 multimodal.ts，此处仅保留 model.ts 自身需要的骨干

/** TTS 非流式请求（简版——完整版在 multimodal.ts）。 */
export interface TtsRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  text: string
  voiceId?: string
  speed?: number
  pitch?: number
  responseFormat?: "mp3" | "wav" | "ogg" | "opus" | "pcm"
  stream?: boolean
  includePhonemes?: boolean
  providerOptions?: Record<string, unknown>
}

/** TTS 非流式响应。 */
export interface TtsResponse {
  /** 完整音频（base64 编码）。 */
  audioBase64: string
  durationMs?: number
  format?: string
}

// ---- STT（Speech-to-Text）----

/** STT 非流式请求。 */
export interface SttRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  /** 音频数据（base64 编码）。 */
  audioBase64: string
  audioFormat?: string
  languageHint?: string
  providerOptions?: Record<string, unknown>
}

/** STT 非流式响应。 */
export interface SttResponse {
  text: string
  confidence?: number
  detectedLanguage?: string
  durationMs?: number
}

// ---- Image Generation ----

/** 图片生成请求。 */
export interface ImageGenRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  prompt: string
  negativePrompt?: string
  size?: string
  quality?: "standard" | "hd" | "ultra"
  n?: number
  seed?: number
  providerOptions?: Record<string, unknown>
}

/** 图片生成响应。 */
export interface ImageGenResponse {
  images: Array<{
    url?: string
    base64?: string
    mimeType: string
    width: number
    height: number
    revisedPrompt?: string
  }>
  durationMs: number
  usage?: { imageCount: number; costUsd?: number }
}

// ---- Vision ----

/** 视觉分析请求。 */
export interface VisionRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  images: Array<{
    url?: string
    base64?: string
    mimeType?: string
    detail?: "low" | "high" | "auto"
  }>
  question?: string
  maxTokens?: number
  providerOptions?: Record<string, unknown>
}

/** 视觉分析响应。 */
export interface VisionResponse {
  text: string
  moderationFlags?: string[]
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
}

// ---- Moderation ----

/** 内容审核请求。 */
export interface ModerationRequest {
  requestId: RequestId
  sessionId: SessionId
  modelId: ModelId
  text?: string
  imageBase64?: string
  imageUrl?: string
  providerOptions?: Record<string, unknown>
}

/** 内容审核响应。 */
export interface ModerationResponse {
  flagged: boolean
  flags: Array<{
    category: string
    flagged: boolean
    confidence: number
  }>
  modelVersion?: string
}

// ═══════════════════════════════════════════════════════════════
// 持久化实体（storage-sql 表行投影）
// ═══════════════════════════════════════════════════════════════

/** Provider 配置持久化行——`provider_configs` 表。 */
export interface ProviderConfigRecord {
  id: ProviderId
  displayName: string
  category: ProviderCategory
  kind: ProviderKind
  enabled: boolean
  configured: boolean
  credentialId?: CredentialId
  baseUrl?: string
  apiKeyEncrypted?: string
  headersJson?: string
  createdAt: UnixMs
  updatedAt: UnixMs
}

/** Model 角色绑定持久化行——`model_bindings` 表。 */
export interface ModelBindingRecord {
  id: string
  role: ModelRole
  providerId: ProviderId
  modelId: ModelId
  createdAt: UnixMs
  updatedAt: UnixMs
}


