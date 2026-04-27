/**
 * Provider / Model / LLM Adapter 的核心类型。
 *
 * 这里不绑定任何具体 SDK，只定义 registry、catalog、capability probe 和 role binding
 * 之间共享的稳定契约。
 */

// ==========================================
// 1. 服务类目与提供商 (Provider) 
// ==========================================

/** * Provider 的服务大类 (完全按功能拆分)。
 * 注意：此处的 "llm" 对应 UI 上的 "Chat" 面板 (即文本生成模型，如 Claude/GPT)，
 * 请勿与执行策略 EmaMode 中的 "chat" 混淆。
 */
export type ProviderCategory = 
  | "llm"         // 文本生成 (GPT, Claude 等)
  | "vision"      // 视觉理解 (识别图片内容)
  | "tts"         // 语音合成 (Text-to-Speech)
  | "stt"         // 语音识别 (Speech-to-Text)
  | "embedding"   // 向量化 (RAG 核心)
  | "rerank"      // 重排序 (RAG 核心)
  | "image_gen"   // 图像生成 (备用)
  | "moderation"; // 内容审查 (备用)


/** Provider 的接入协议方式 (底层到底怎么连)。 */
export type ProviderKind =
  | "openai-native"
  | "anthropic-native"
  | "gemini-native"
  | "openai-compatible"
  | "anthropic-compatible"
  | "ollama"
  | "local-dev";

/** Provider 健康状态。 */
export interface ProviderHealthView {
  status: "unknown" | "ok" | "degraded" | "down";
  checkedAt?: number;
  latencyMs?: number;
  message?: string;
}

/** * 按功能高度垂直的 Provider 描述。 
 * 对应 UI 里模型服务的每一个小黑块
 */
export interface ProviderDescriptor {
    /** Provider 的唯一标识符，格式不限，但建议包含模型名称以便调试和埋点分析。
     * @example "gpt-4.5-turbo"
     */
    id: string; 
    /** Provider 在 UI 中显示的名称。
     * @example "GPT-4.5 Turbo"
     */
    displayName: string;
    /** 功能面板 */
    category: ProviderCategory;
    /** 接入协议 */
    kind: ProviderKind;
    /** 网址 */
    website?: string;
    /** 图标 */
    icon?: string;
    /** 是否启用（由用户设置控制） */
    enabled: boolean;
    /** 是否已配置好（如 API Key 已填） */
    configured: boolean;
    /** 修复：绑定凭证 ID，没有它系统拿不到 API Key */
    credentialId?: string;
    /** 是否支持远程调用（即非本地开发环境） */
    supportsRemoteModels?: boolean;
    /** 健康状态 */
    health?: ProviderHealthView;
}

// ==========================================
// 2. 模型能力 (Model) 
// ==========================================

/** 模型角色绑定 。
 * @example `chat` 下用适当模型 `title`自动生成标题的模型用个小的
 */
export type ModelRole = "chat" | "agent" | "narrative" | "title" | "embedding" | "rerank";

/** * 统一的模型能力矩阵。 */
export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  promptCache: boolean;
  listModels: boolean;
}

/** 模型描述信息。 */
export interface ModelDescriptor {
    /** 模型的唯一标识符，格式不限，但建议包含模型名称以便调试和埋点分析。
     * @example "gpt-4.5-turbo"
     * 注意：如果一个 Provider 提供多个模型，建议在 id 中包含模型名称以区分不同模型的能力和使用场景。
     */
    id: string;
    /** 模型在 UI 中显示的名称。
     * @example "GPT-4.5 Turbo"
     */
    displayName: string;
    /** 模型所属的 Provider ID。 */
    providerId: string;
    /** 模型能力矩阵。 */
    capabilities: ModelCapabilities;
    /** 最大上下文窗口大小。 */
    contextWindow: number;
    /** 最大输出长度限制。 */
    maxOutputTokens: number;
    /** 价格信息（可选）。 */
    pricing?: {
        inputPer1M?: number
        outputPer1M?: number
    }
    /** 模型来源
     * - `static`: 由系统预设的模型（如内置的 GPT-4.5），通常不变更。
     * - `remote`: 通过 Provider 的 listModels 接口动态获取的模型，可能会变更。
     * - `user`: 用户自定义添加的模型（如 Ollama 本地模型），可能会变更。
     */
    source?: "static" | "remote" | "user";
    updatedAt?: number;
}

// ==========================================
// 3. LLM 消息与多模态 (Vision / Tool)
// ==========================================

export type ChatCompletionMessageRole = "system" | "user" | "assistant" | "tool";

/** 消息内容分块（支持普通文本和 Vision 多模态） */
export type MessageContentPart = 
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string; detail?: "low" | "high" | "auto" } };

/** 工具声明协议 (基于 JSON Schema规范) */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

/** 流式响应中的工具调用片段  */
export interface ToolCallChunk {
  /** 工具调用的唯一标识 (由 LLM 生成) */
  id: string;
  toolName: string;
  /** 参数 JSON 字符串的增量片段 (流式时用到) 或完整字符串 (非流式时) */
  argumentsDelta: string;
}

// ------------------------------------------
// 区分角色的 Message 细分定义 (Discriminated Unions)
// ------------------------------------------

/** System 消息：系统设定 */
export interface SystemMessage {
  role: "system";
  content: string; // 通常系统 prompt 只是字符串
}

/** User 消息：用户输入，支持文本或多模态（图片） */
export interface UserMessage {
  role: "user";
  content: string | MessageContentPart[];
}

/** Assistant 消息：LLM 的回复或工具调用请求 */
export interface AssistantMessage {
  role: "assistant";
  content: string | null; 
  /** LLM 发起的工具调用列表 */
  toolCalls?: ToolCallChunk[];
}

/** Tool 消息：工具执行的结果（返回给 LLM） */
export interface ToolMessage {
  role: "tool";
  /** 此结果对应的是哪一次 ToolCall */
  toolCallId: string; 
  /** 工具执行的返回值，通常是 stringified JSON */
  content: string; 
  /** (可选) 业务侧使用的工具名称，有助于调试 */
  toolName?: string; 
}

/** 
 * 传给 LLM 的通用消息联合类型。
 * TypeScript 会根据 role 字段自动推导并严格校验对应的必需字段。
 */
export type ChatCompletionMessage = 
  | SystemMessage 
  | UserMessage 
  | AssistantMessage 
  | ToolMessage;

/** llm请求结构 */
export interface ChatCompletionRequest {
    requestId: string;
    /** 用于内部日志、计费和流中断，发送给 LLM 时会被 Adapter 忽略
     * @example 点击发送之后用户切到了另一个`session` 这时就可以用来识别并通知完成后之前那个 `session` 的请求
     */
    sessionId: string;
    /** 用于关联这一轮对话的所有请求和响应，方便日志分析和调试。由系统生成并传递给 Adapter，Adapter 再原样传回 LLM。
     * @example "trace-12345" 这个 traceId 可以在日志中关联这一整轮对话的所有请求和响应，方便调试和分析
     */
    traceId?: string; 
    modelId: string;
    messages: ChatCompletionMessage[];
    stream?: boolean;
    tools?: ToolSpec[];
    temperature?: number;
    maxTokens?: number;
    /* 其他参数（如 top_p）可以根据需要添加 */
    topP?: number;

    /**
     * 特定提供商的专属高级参数。
     * 当你需要使用某个模型独有的功能时，把它们塞在这里。
     * @example { "seed": 42, "response_format": { "type": "json_object" } }
     * @example { "thinking": { "type": "enabled", "budget_tokens": 1024 } }
     */
    providerOptions?: Record<string, unknown>;
}

/** 流式相应块 */
export interface ChatCompletionChunk {
    id?: string;
    index: number;
    delta: { content?: string};
    toolCalls?: ToolCallChunk[];
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

// ==========================================
// 5. 其他模态协议 (TTS / STT / Embedding)
// ==========================================

export interface TtsRequest {
    requestId: string;
    sessionId: string;
    modelId: string;
    text: string;
    speed?: number;
    responseFormat?: "mp3" | "wav" | "ogg";
    stream?: boolean;
    providerOptions?: Record<string, unknown>;
}

export interface TtsChunk {
    id?: string;
    index: number;
    audioData: ArrayBuffer | Blob;
     /* 其他参数（如 latencyMs）可以根据需要添加 */
    latencyMs?: number;
}

export interface TtsResponse {
    /* 直接返回音频数据的二进制内容，格式由请求中的 responseFormat 决定 */
    audioData: ArrayBuffer | Blob;
    durationMs?: number;
}

export interface SttRequest {
    requestId: string;
    sessionId: string;
    modelId: string;
    audioData: ArrayBuffer | Blob;
    languageHint?: string;
    providerOptions?: Record<string, unknown>;
}

export interface SttResponse {
    text: string;
    durationMs?: number;
}

export interface EmbeddingRequest {
    requestId: string;
    sessionId: string;
    modelId: string;
    input: string | string[];
    providerOptions?: Record<string, unknown>;
}

export interface EmbeddingResponse {
    embeddings: number[][];
    usage?: { inputTokens: number; totalTokens: number };
}