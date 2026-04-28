/**
 * SSE 流事件协议。
 *
 * 后端在 turn 执行过程中通过 Server-Sent Events 实时推送这些事件，
 * 前端 EventSource 按 event.type 派发到对应渲染器。
 *
 * 设计原则：
 * - 每个事件自包含，前端无需关联查询即可渲染。
 * - 事件是 append-only 流，前端按到达顺序追加到消息的 contentBlocks。
 */
import type { EmaMode } from "./mode.js"
import type { ArtifactSummary } from "./artifact.js"
import type {
  ArtifactId,
  MessageId,
  RequestId,
  SessionId,
  StepId,
  ToolCallId,
  UnixMs,
} from "./ids.js"

// ==========================================
// 用户回传协议（HTTP POST，非 SSE）
// ==========================================

/** 用户对权限请求的响应（前端 → 后端）。 */
export interface UserPermissionResponse {
  type: "user_permission_response"
  requestId: RequestId
  toolCallId: ToolCallId
  allowed: boolean
}

// ==========================================
// SSE Event 联合类型
// ==========================================

export type SseEvent =
  // --- 文本流 ---
  | TextDeltaEvent
  | TextDoneEvent

  // --- 工具调用 ---
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent

  // --- 工具结果 ---
  | ToolResultEvent

  // --- 权限请求 ---
  | PermissionRequestEvent

  // --- 步骤（Agent 模式专用）---
  | StepStartEvent
  | StepProgressEvent
  | StepEndEvent

  // --- 产物 ---
  | ArtifactCreateEvent
  | ArtifactDeltaEvent
  | ArtifactFinalizeEvent

  // --- 错误 ---
  | ErrorEvent

  // --- 图片 ---
  | ImageEvent

  // --- 生命周期 ---
  | TurnStartedEvent
  | TurnCompletedEvent

export interface BaseEvent {
  requestId: RequestId
  sessionId: SessionId
  at: UnixMs
}

// ==========================================
// 文本事件
// ==========================================

export interface TextDeltaEvent extends BaseEvent {
  type: "text_delta"
  messageId: MessageId
  /** 增量文本片段。 */
  delta: string
  blockId: string
}

export interface TextDoneEvent extends BaseEvent {
  type: "text_done"
  messageId: MessageId
  /** 完整文本（用于落盘校验）。 */
  fullText: string
  blockId: string
}

// ==========================================
// 工具调用事件
// ==========================================

export interface ToolCallStartEvent extends BaseEvent {
  type: "tool_call_start"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
}

export interface ToolCallArgsEvent extends BaseEvent {
  type: "tool_call_args"
  messageId: MessageId
  toolCallId: ToolCallId
  /** 参数 JSON 增量。 */
  argsDelta: string
}

export interface ToolCallEndEvent extends BaseEvent {
  type: "tool_call_end"
  messageId: MessageId
  toolCallId: ToolCallId
  /** 完整参数 JSON 字符串。 */
  args: Record<string, unknown>
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  success: boolean
  /** 工具返回结果字符串。 */
  resultStr: string
  durationMs: number
}

// ==========================================
// 权限请求
// ==========================================

export interface PermissionRequestEvent extends BaseEvent {
  type: "permission_request"
  messageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  /** 需要用户确认的操作摘要。 */
  summary: string
  risk: "low" | "medium" | "high"
}

// ==========================================
// 步骤事件（Agent 模式专用）
// ==========================================

export interface StepStartEvent extends BaseEvent {
  type: "step_start"
  stepId: StepId
  stepType: "context" | "thinking" | "tool" | "diff" | "artifact" | "response" | "narrative_recall"
  title: string
}

export interface StepProgressEvent extends BaseEvent {
  type: "step_progress"
  stepId: StepId
  detail: string
}

export interface StepEndEvent extends BaseEvent {
  type: "step_end"
  stepId: StepId
  status: "completed" | "failed" | "skipped"
  artifactIds?: ArtifactId[]
}

// ==========================================
// 产物事件
// ==========================================

// 创建 更新 完成
export interface ArtifactCreateEvent extends BaseEvent {
  type: "artifact_create"
  artifactId: ArtifactId
  /** 产物摘要信息，供前端列表渲染。 */
  summary: ArtifactSummary
}

export interface ArtifactDeltaEvent extends BaseEvent {
  type: "artifact_delta"
  artifactId: ArtifactId
  /** 增量文本内容。 */
  delta: string
}

export interface ArtifactFinalizeEvent extends BaseEvent {
  type: "artifact_finalize"
  artifactId: ArtifactId
  /** 产物内容已完成，提供完整摘要供前端更新列表。 */
  summary: ArtifactSummary
}


// ==========================================
// 错误
// ==========================================

export interface ErrorEvent extends BaseEvent {
  type: "error"
  code: string
  message: string
  /** 是否可重试。 */
  retryable: boolean
}

// ==========================================
// 图片事件（模型回复中的图片，如生成的图表、截图等）
// ==========================================

export interface ImageEvent extends BaseEvent {
  type: "image"
  messageId: MessageId
  /** 图片 URL（data URL 或本地地址）。 */
  url: string
  mimeType?: string
  /** 辅助文本说明。 */
  alt?: string
}

// ==========================================
// 生命周期
// ==========================================

export interface TurnStartedEvent extends BaseEvent {
  type: "turn_started"
  mode: EmaMode
  messageId: MessageId
}

export interface TurnCompletedEvent extends BaseEvent {
  type: "turn_completed"
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd?: number
  }
}