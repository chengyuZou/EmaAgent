/**
 * Turn 是 EmaAgent 的主执行单位。
 *
 * Session 承载上下文；Turn 记录本轮使用的 mode、模型、步骤、产物和用量。
 *
 * 注意：Repository 接口不放在 core-types，
 * 它属于 storage-sql 或 session 包内部。
 */

import type { ArtifactSummary } from "./artifact.js"
import type { EmaMode } from "./mode.js"
import type { MessagePage } from "./message.js"
import type {
  ArtifactId,
  AttachmentId,
  MessageId,
  ModelId,
  ProviderId,
  RequestId,
  SessionId,
  StepId,
  UnixMs,
} from "./ids.js"

// ==========================================
// Turn 发起
// ==========================================

/** 一轮请求的输入块。 */
export type TurnInputBlock =
  | { type: "text"; text: string }
  | { type: "image_ref"; attachmentId: AttachmentId }
  | { type: "file_ref"; attachmentId: AttachmentId }
  | { type: "artifact_ref"; artifactId: ArtifactId }

/** 发起 turn 的 API 请求体。 */
export interface StartTurnRequest {
  sessionId: SessionId
  mode: EmaMode
  input: TurnInputBlock[]
  /** 兼容旧前端的单文本入口，BFF 会转换成 input[0]。 */
  rawUserQuery?: string
  /** 参与本轮上下文构建的附件 ID。 */
  attachments?: AttachmentId[]
  /** 本轮临时模型覆盖，不写入全局绑定。 */
  modelOverrides?: Partial<{
    chatModelId: ModelId
    agentModelId: ModelId
    narrativeModelId: ModelId
    titleModelId: ModelId
  }>
  /** 客户端能力与区域信息。 */
  client?: {
    locale?: string
    timezone?: string
    supportsMermaid?: boolean
    supportsLatex?: boolean
  }
}

/** 发起 turn 后的响应。 */
export interface StartTurnResponse {
  requestId: RequestId
  sessionId: SessionId
  /** 本轮用户消息 ID，前端可立即插入用户消息占位。 */
  userMessageId: MessageId
  /** 本轮助手消息 ID，后续 text_delta / tool 事件都归到这条消息。 */
  assistantMessageId: MessageId
  acceptedAt: UnixMs
  /** SSE 流地址，前端连接此 URL 接收实时事件。 */
  streamUrl: string
}

// ==========================================
// Turn 状态与步骤
// ==========================================

export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "skipped"

/** 结构化步骤视图，agent 模式使用最频繁。 */
export interface StepView {
  id: StepId
  requestId: RequestId
  type:
    | "context"
    | "thinking"
    | "tool"
    | "diff"
    | "artifact"
    | "response"
    | "narrative_recall"
  status: StepStatus
  title: string
  detail?: string
  startedAt?: UnixMs
  endedAt?: UnixMs
  artifactIds?: ArtifactId[]
}

/** 用量统计。 */
export interface UsageView {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd?: number
}

// ==========================================
// Turn 持久化实体
// ==========================================

/** Turn 持久化实体——storage-sql 落盘 & session 包读写的唯一结构。 */
export interface TurnRecord {
  requestId: RequestId
  sessionId: SessionId
  mode: EmaMode
  status: TurnStatus
  modelId?: ModelId
  providerId?: ProviderId
  startedAt: UnixMs
  endedAt?: UnixMs
  usage?: UsageView
  artifacts?: ArtifactSummary[]
  /** status === "failed" 时的稳定错误码。 */
  errorCode?: string
  /** status === "failed" 时的用户可读错误消息。 */
  errorMessage?: string
}

// ==========================================
// Turn 调试/审计视图
// ==========================================

/**
 * 查看某个 turn 的完整执行记录（调试/审计用），前端 Turn 详情面板使用。
 */
export interface TurnDetailView {
  turn: TurnRecord
  /** 该 turn 产生的消息列表。 */
  messages: MessagePage
  /** 该 turn 产生的所有产物。 */
  artifacts: ArtifactSummary[]
}
