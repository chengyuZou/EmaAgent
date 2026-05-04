/**
 * SSE 流事件协议 — EmaAgent 前后端实时通信的唯一契约。
 *
 * ## 协议模型
 *
 * 后端在 turn 执行过程中通过 `text/event-stream` 推送结构化事件。
 * 前端 `EventSource` 按 `event.type` 分发到对应渲染处理器。
 *
 * ## 设计约束
 *
 * 1. **自包含** — 每个事件携带渲染所需的全部字段，前端无需回查 API
 * 2. **append-only** — 事件流是单向追加的，前端按到达顺序处理
 * 3. **终态关闭** — 收到 `turn_completed` / `turn_failed` / `turn_cancelled` 后 SSE 连接关闭
 * 4. **严禁日志解析** — 前端永远只消费结构化 event，绝对禁止从日志字符串提取信息
 *
 * ## 事件时序（agent 模式典型流程）
 *
 * ```
 * turn_started
 *   → step_start(thinking) → text_delta* → text_done → step_end(thinking)
 *   → step_start(tool)
 *     → tool_call_start → tool_call_args* → tool_call_end
 *     → [permission_request]  // 仅高风险工具
 *     → tool_result
 *   → step_end(tool)
 *   → tool_call_start → ... → tool_result  // 串行工具逐个执行
 *   → step_start(thinking) → ... (下一轮 ReAct)
 * turn_completed
 * ```
 */

import type {
  ArtifactId,
  MessageId,
  RequestId,
  SessionId,
  StepId,
  ToolCallId,
  UnixMs,
} from "./ids.js"
import type { EmaMode } from "./mode.js"
import type { ArtifactSummary } from "./artifact.js"

// ═══════════════════════════════════════════════════════════════
// 用户回传协议（HTTP POST，非 SSE）
// ═══════════════════════════════════════════════════════════════

/** 用户对权限询问的响应——前端 POST 回 BFF，非 SSE 流内事件。 */
export interface UserPermissionResponse {
  type: "user_permission_response"
  requestId: RequestId
  toolCallId: ToolCallId
  allowed: boolean
}

// ═══════════════════════════════════════════════════════════════
// Event 基类
// ═══════════════════════════════════════════════════════════════

/** 所有 SSE 事件的公共字段。 */
export interface BaseEvent {
  /** 关联的 API 请求 ID——前端据此将事件归属到当前 turn。 */
  requestId: RequestId
  /** 关联的会话 ID。 */
  sessionId: SessionId
  /** 事件生成时间（Unix 毫秒）。 */
  at: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// SseEvent — 顶层联合类型
// ═══════════════════════════════════════════════════════════════

/**
 * 所有可能的 SSE 事件的联合类型。
 *
 * 前端收到事件后，通过 `event.type` 判别并分发到对应渲染器。
 * 后端通过此联合类型确保 emit 的每个事件都有 type 字段的类型安全。
 */
export type SseEvent =
  // --- 生命周期 ---
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent

  // --- 文本流 ---
  | TextDeltaEvent
  | TextDoneEvent

  // --- 工具调用（ReAct act 阶段）---
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolResultEvent

  // --- 权限请求 ---
  | PermissionRequestEvent

  // --- ReAct 步骤（Agent 模式专用）---
  | StepStartEvent
  | StepProgressEvent
  | StepEndEvent

  // --- 检索（Narrative / Attachment）---
  | RetrievalStartEvent
  | RetrievalDeltaEvent
  | RetrievalEndEvent

  // --- 上下文压缩 ---
  | CompressionNotifyEvent

  // --- 产物 ---
  | ArtifactCreateEvent
  | ArtifactDeltaEvent
  | ArtifactFinalizeEvent

  // --- 媒体 ---
  | ImageEvent

  // --- 舞台提示（Live2D 表情/动作）---
  | StageCueEvent

  // --- 错误 ---
  | ErrorEvent

// ═══════════════════════════════════════════════════════════════
// 生命周期事件
// ═══════════════════════════════════════════════════════════════

/** turn 启动——前端收到后开始渲染助手消息占位。 */
export interface TurnStartedEvent extends BaseEvent {
  type: "turn_started"
  mode: EmaMode
  /** 已落盘的用户消息 ID——前端可据此插入用户消息气泡。 */
  userMessageId: MessageId
  /** 助手消息 ID——后续所有 text_delta / tool 事件归属到此消息。 */
  assistantMessageId: MessageId
}

/** turn 正常完成——前端停止 loading 动画，刷新用量显示。 */
export interface TurnCompletedEvent extends BaseEvent {
  type: "turn_completed"
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd?: number
  }
}

/** turn 执行失败——前端展示错误信息，启用重试按钮。 */
export interface TurnFailedEvent extends BaseEvent {
  type: "turn_failed"
  /** 稳定错误码，前端据此展示对应 UI 文案。 */
  code: string
  message: string
  retryable: boolean
  /** 失败时已产生的产物 ID 列表（不丢失已完成的工作）。 */
  artifactIds?: ArtifactId[]
}

/** turn 被用户取消——前端停止动画，不显示重试按钮。 */
export interface TurnCancelledEvent extends BaseEvent {
  type: "turn_cancelled"
  /** 取消前最后一步的 stepId（用于 UI 高亮）。 */
  lastStepId?: StepId
}

// ═══════════════════════════════════════════════════════════════
// 文本流事件
// ═══════════════════════════════════════════════════════════════

/** 增量文本片段——前端追加到对应消息气泡末尾。 */
export interface TextDeltaEvent extends BaseEvent {
  type: "text_delta"
  messageId: MessageId
  /** 增量文本（可能是单个 token 或多个字符）。 */
  delta: string
  /** 文本块的稳定标识——一个消息可能有多个文本块（如被 tool_call 分隔）。 */
  blockId: string
}

/** 文本块完成——前端可将 block 标记为完整，用于落盘校验。 */
export interface TextDoneEvent extends BaseEvent {
  type: "text_done"
  messageId: MessageId
  /** 该文本块的完整内容。 */
  fullText: string
  blockId: string
}

// ═══════════════════════════════════════════════════════════════
// 工具调用事件（ReAct act 阶段核心）
// ═══════════════════════════════════════════════════════════════

/** 开始工具调用——前端在消息气泡中插入 tool_call 卡片（状态: running）。 */
export interface ToolCallStartEvent extends BaseEvent {
  type: "tool_call_start"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  /** 工具来源：local（TS 侧内置工具）或 mcp（MCP 服务器工具）。 */
  source?: "local" | "mcp"
}

/** 工具调用参数增量（流式传递 JSON 片段）。 */
export interface ToolCallArgsEvent extends BaseEvent {
  type: "tool_call_args"
  messageId: MessageId
  toolCallId: ToolCallId
  /** 参数 JSON 增量片段。 */
  argsDelta: string
}

/** 工具调用参数完成——前端展示完整参数。 */
export interface ToolCallEndEvent extends BaseEvent {
  type: "tool_call_end"
  messageId: MessageId
  toolCallId: ToolCallId
  /** 完整解析后的参数对象。 */
  args: Record<string, unknown>
}

/** 工具执行结果——前端更新 tool_call 卡片状态（success / failure）。 */
export interface ToolResultEvent extends BaseEvent {
  type: "tool_result"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  success: boolean
  /** 工具返回的字符串结果（截断后的预览）。 */
  resultStr: string
  durationMs: number
}

// ═══════════════════════════════════════════════════════════════
// 权限请求
// ═══════════════════════════════════════════════════════════════

/**
 * 权限请求——前端弹出确认对话框。
 *
 * 仅对高风险工具（terminal / code exec / file write）发出。
 * 低风险只读工具（search / read file）无需此事件，直接执行。
 * 用户通过 `POST /api/turns/:id/permission` 回复。
 */
export interface PermissionRequestEvent extends BaseEvent {
  type: "permission_request"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  /** 人类可读的操作摘要，如 "删除文件 /tmp/test.txt"。 */
  summary: string
  /** 风险级别——前端据此改变确认按钮的颜色和文案。 */
  risk: "low" | "medium" | "high" | "critical"
}

// ═══════════════════════════════════════════════════════════════
// ReAct 步骤事件（Agent 模式专用）
// ═══════════════════════════════════════════════════════════════

/** ReAct 步骤开始——前端在时间线中插入步骤节点。 */
export interface StepStartEvent extends BaseEvent {
  type: "step_start"
  stepId: StepId
  /** 步骤语义类型——前端据此选择图标和颜色。 */
  stepType:
    | "context"           // 上下文组装
    | "thinking"          // LLM 推理（think 阶段）
    | "tool"              // 工具执行（act 阶段）
    | "diff"              // 差异生成
    | "artifact"          // 产物创建
    | "response"          // 最终回复生成
    | "narrative_recall"  // 剧情召回
  title: string
}

/** ReAct 步骤进度——前端更新步骤节点的副文本。 */
export interface StepProgressEvent extends BaseEvent {
  type: "step_progress"
  stepId: StepId
  detail: string
}

/** ReAct 步骤完成——前端标记步骤节点状态。 */
export interface StepEndEvent extends BaseEvent {
  type: "step_end"
  stepId: StepId
  status: "completed" | "failed" | "skipped"
  /** 该步骤产出的产物 ID 列表。 */
  artifactIds?: ArtifactId[]
}

// ═══════════════════════════════════════════════════════════════
// 检索事件（Narrative / Attachment 查询）
// ═══════════════════════════════════════════════════════════════

export interface RetrievalStartEvent extends BaseEvent {
  type: "retrieval_start"
  messageId: MessageId
  /** 检索来源描述：narrative / attachments / memory。 */
  source: string
}

export interface RetrievalDeltaEvent extends BaseEvent {
  type: "retrieval_delta"
  messageId: MessageId
  source: string
  delta: string
}

export interface RetrievalEndEvent extends BaseEvent {
  type: "retrieval_end"
  messageId: MessageId
  content: string
  source: string
}

// ═══════════════════════════════════════════════════════════════
// 压缩通知
// ═══════════════════════════════════════════════════════════════

/** 上下文压缩完成通知——前端可展示"已压缩上下文"提示。 */
export interface CompressionNotifyEvent extends BaseEvent {
  type: "compression_notify"
  messageId: MessageId
  originalTokens: number
  compressedTokens: number
  content: string
}

// ═══════════════════════════════════════════════════════════════
// 产物事件
// ═══════════════════════════════════════════════════════════════

export interface ArtifactCreateEvent extends BaseEvent {
  type: "artifact_create"
  artifactId: ArtifactId
  /** 产物摘要——前端据此渲染列表卡片。 */
  summary: ArtifactSummary
}

export interface ArtifactDeltaEvent extends BaseEvent {
  type: "artifact_delta"
  artifactId: ArtifactId
  delta: string
}

export interface ArtifactFinalizeEvent extends BaseEvent {
  type: "artifact_finalize"
  artifactId: ArtifactId
  summary: ArtifactSummary
}

// ═══════════════════════════════════════════════════════════════
// 媒体事件
// ═══════════════════════════════════════════════════════════════

/** 图片内容——前端在消息气泡中渲染图片。 */
export interface ImageEvent extends BaseEvent {
  type: "image"
  messageId: MessageId
  /** 图片地址（data URL 或本地文件路径）。 */
  url: string
  mimeType?: string
  alt?: string
}

// ═══════════════════════════════════════════════════════════════
// 舞台提示（Live2D 控制）
// ═══════════════════════════════════════════════════════════════

/**
 * Live2D 舞台提示——后端根据当前上下文推断 Ema 应展示的表情和动作。
 *
 * 前端 Live2D 控制器收到此事件后，将队列中的表情/动作应用到模型。
 * 此事件不与任何 messageId 绑定——它是全局的舞台指令。
 */
export interface StageCueEvent extends BaseEvent {
  type: "stage_cue"
  cue: {
    /** 触发源——用于前端决定 cue 的视觉优先级。 */
    source: "act" | "step" | "tool" | "artifact" | "system"
    /** 表情：neutral（默认）、happy（愉悦）、thinking（思考）、sad（悲伤）、surprised（惊讶）、curious（好奇）。 */
    expression?: "neutral" | "curious" | "happy" | "thinking" | "sad" | "surprised"
    /** 动作：idle（待机）、lean_forward（前倾）、nod（点头）、look_left/right（左右看）。 */
    motion?: "idle" | "lean_forward" | "nod" | "look_left" | "look_right"
    /** 口型：idle（闭嘴）、speaking（说话对口型）。 */
    mouth?: "idle" | "speaking"
    /** 优先级——数值越大越优先，用于合并多个 cue。 */
    priority?: number
    /** 持续时间（毫秒），0 表示一次性触发。 */
    durationMs?: number
  }
}

// ═══════════════════════════════════════════════════════════════
// 错误事件（流内）
// ═══════════════════════════════════════════════════════════════

/** 流内错误——不中断 SSE 连接，前端展示内联错误提示。 */
export interface ErrorEvent extends BaseEvent {
  type: "error"
  code: string
  message: string
  retryable: boolean
}
