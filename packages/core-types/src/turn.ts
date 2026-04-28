/**
 * Turn 是 EmaAgent 的主执行单位。
 *
 * Session 承载上下文；Turn 记录本轮使用的 mode、模型、步骤、产物和用量。
 */

import type { ArtifactSummary } from "./artifact.js"
import type { EmaMode } from "./mode.js"
import type {
  ArtifactId,
  AttachmentId,
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
// Turn 持久化
// ==========================================

/** Turn 持久化实体。 */
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
}

// ==========================================
// 仓储
// ==========================================

export interface CreateTurnInput {
  requestId: RequestId
  sessionId: SessionId
  mode: EmaMode
  status?: TurnStatus
  modelId?: ModelId
  providerId?: ProviderId
  startedAt?: UnixMs
}

export interface UpdateTurnInput {
  requestId: RequestId
  status?: TurnStatus
  modelId?: ModelId
  providerId?: ProviderId
  endedAt?: UnixMs
  usage?: UsageView
}

export interface ListTurnsOptions {
  limit?: number
  beforeStartedAt?: UnixMs
}

export interface TurnPage {
  items: TurnRecord[]
  hasMore: boolean
  nextBeforeStartedAt?: UnixMs
}

export interface TurnRepository {
  createTurn(input: CreateTurnInput): Promise<TurnRecord>
  getTurnById(requestId: RequestId): Promise<TurnRecord | null>
  updateTurn(input: UpdateTurnInput): Promise<void>
  listTurnsBySession(
    sessionId: SessionId,
    options?: ListTurnsOptions
  ): Promise<TurnPage>
}