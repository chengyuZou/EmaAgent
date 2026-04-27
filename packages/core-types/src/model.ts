/**
 * Provider / Model / LLM Adapter 的核心类型。
 *
 * 这里不绑定任何具体 SDK，只定义 registry、catalog、capability probe 和 role binding
 * 之间共享的稳定契约。
 */

/** Provider 的接入方式。 */
export type ProviderKind =
  | "openai-native"
  | "anthropic-native"
  | "gemini-native"
  | "openai-compatible"
  | "anthropic-compatible"
  | "ollama"
  | "local-dev";

/** 模型能力矩阵，来自文档中的 capability 层。 */
export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  promptCache: boolean;
  listModels: boolean;
}

/** 模型角色绑定。 */
export type ModelRole = "chat" | "agent" | "narrative" | "title" | "embedding" | "rerank";

/** 模型提供方描述信息。 */
export interface ProviderDescriptor {
  /** 全局唯一标识符。 */
  id: string;
  /** 展示名称。 */
  displayName: string;
  /** Provider 接入方式。 */
  kind: ProviderKind | "llm" | "embedding" | "reranker" | "tts" | "stt" | "vision";
  /** 官网链接。 */
  website?: string;
  /** 图标 URL。 */
  icon?: string;
  /** 是否启用。 */
  enabled: boolean;
  /** 是否已正确配置。 */
  configured: boolean;
  /** 是否支持远端列模。 */
  supportsRemoteModels?: boolean;
  /** 最近一次健康检查结果。 */
  health?: ProviderHealthView;
}

/** Provider 健康状态。 */
export interface ProviderHealthView {
  status: "unknown" | "ok" | "degraded" | "down";
  checkedAt?: number;
  latencyMs?: number;
  message?: string;
}

/** 模型注册信息。 */
export interface ModelDescriptor {
  /** 全局唯一模型标识。 */
  id: string;
  /** 模型提供方 ID。 */
  providerId: string;
  /** 展示名称。 */
  displayName: string;
  /** 最大上下文长度。 */
  contextWindow: number;
  /** 最大输出 token 数。 */
  maxOutputTokens: number;
  /** 统一能力矩阵。 */
  capabilities?: ModelCapabilities;
  /** 是否支持流式输出，兼容旧代码。 */
  supportsStreaming: boolean;
  /** 是否支持工具调用，兼容旧代码。 */
  supportsTools: boolean;
  /** 是否支持 vision，兼容旧代码。 */
  supportsVision: boolean;
  /** 定价信息，每百万 token 的价格，单位美元。 */
  pricing?: {
    inputPer1M?: number
    outputPer1M?: number
  }
  /** 元数据来源。 */
  source?: "static" | "remote" | "user";
  /** 元数据更新时间。 */
  updatedAt?: number;
}

/** LLM 消息角色 */
export type ChatCompletionMessageRole = "system" | "user" | "assistant" | "tool";

/** LLM 请求消息 */
export interface ChatCompletionMessage {
  role: ChatCompletionMessageRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCallChunk[];
}

/** LLM 非流式请求缓存配置。默认不启用。 */
export interface ChatCompletionCachePolicy {
  enabled: boolean;
  ttlMs?: number;
  key?: string;
}

/** LLM 请求统一结构。 */
export interface ChatCompletionRequest {
  /** 请求 ID，用于事件流与日志关联。 */
  requestId?: string;
  /** Trace ID，用于跨 runtime 追踪。 */
  traceId?: string;
  /** 会话 ID，用于日志追踪。 */
  sessionId: string;
  /** 消息列表。 */
  messages: ChatCompletionMessage[];
  /** 可用工具列表。 */
  tools?: ToolSpec[];
  /** 是否启用流式输出。 */
  stream?: boolean;
  /** 温度参数。 */
  temperature?: number;
  /** 最大输出 token 数。 */
  maxTokens?: number;
  /** 模型标识。 */
  modelId: string;
  /** 可选缓存策略，仅适用于非流式 chat / completeText。 */
  cache?: ChatCompletionCachePolicy;
}

/** 工具声明协议 */
export interface ToolSpec {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** JSON Schema 参数定义 */
  parameters: Record<string, unknown>;
}

/** 流式响应中的工具调用片段 */
export interface ToolCallChunk {
  id: string;
  toolName: string;
  /** 参数 JSON 字符串的增量片段 */
  argumentsDelta: string;
}

/** LLM 流式响应统一块。 */
export interface ChatCompletionChunk {
  /** 块索引（从 0 开始） */
  index: number;
  /** 增量文本内容 */
  delta: { content?: string };
  /** token 文本增量（普通流式输出时） */
  token?: string;
  /** 工具调用增量（function calling 流式输出时） */
  toolCalls?: ToolCallChunk[];
  /** 使用量统计（通常只在最后一块） */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** 结束原因 */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
}
