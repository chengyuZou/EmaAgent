/**
 * Turn 生命周期协议——EmaAgent 的主执行单位。
 *
 * ## Turn vs Session vs Message
 *
 * - **Session**：容器——持有会话元数据和完整消息历史
 * - **Turn**：一次 API 请求的执行记录——记录 mode、模型、步骤、用量
 * - **Message**：对话气泡——user/assistant/system 三种角色
 *
 * 一个 Session 包含多个 Turn，一个 Turn 产生若干条 Message。
 */

import type { ArtifactSummary } from "./artifact.js"
import type { EmaMode } from "./mode.js"
import type { UsageView } from "./model.js"
import type { MessagePage } from "./message.js"
import type {
  ArtifactId,
  AttachmentId,
  MessageId,
  ModelId,
  ProviderId,
  RequestId,
  SessionId,
  UnixMs,
} from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// Turn 发起
// ═══════════════════════════════════════════════════════════════

/** 一轮请求的输入块——支持文本、图片引用、文件引用、产物引用。 */
export type TurnInputBlock =
  | { type: "text"; text: string }
  | { type: "image_ref"; attachmentId: AttachmentId }
  | { type: "file_ref"; attachmentId: AttachmentId }
  | { type: "artifact_ref"; artifactId: ArtifactId }

/**
 * 发起 turn 的 API 请求体——POST /api/turns。
 *
 * @example
 * // chat 模式
 * const req: StartTurnRequest = {
 *   sessionId: asId<SessionId>("ses_001"),
 *   mode: "chat",
 *   input: [{ type: "text", text: "Ema，今天天气怎么样？" }],
 * }
 *
 * @example
 * // agent 模式，带附件和模型覆盖
 * const req: StartTurnRequest = {
 *   sessionId: asId<SessionId>("ses_001"),
 *   mode: "agent",
 *   input: [{ type: "text", text: "分析这份代码并修复 bug" }],
 *   attachments: [asId<AttachmentId>("att_001")],
 *   modelOverrides: { agentModelId: asId<ModelId>("claude-sonnet-4-6") },
 * }
 */
export interface StartTurnRequest {
  sessionId: SessionId
  mode: EmaMode
  input: TurnInputBlock[]
  /** 兼容旧前端的单文本入口——BFF 会将其转换为 input[0]（text 类型）。 */
  rawUserQuery?: string
  /** 参与本轮上下文构建的附件 ID 列表。 */
  attachments?: AttachmentId[]
  /** 本轮临时模型覆盖——不写入全局 model_bindings 表。 */
  modelOverrides?: Partial<{
    chatModelId: ModelId
    agentModelId: ModelId
    narrativeModelId: ModelId
    titleModelId: ModelId
  }>
  /** 客户端能力与区域信息——BFF 据此调整输出格式。 */
  client?: {
    locale?: string
    timezone?: string
    supportsMermaid?: boolean
    supportsLatex?: boolean
  }
}

/**
 * 发起 turn 后的即时响应——前端据此连接 SSE 流。
 *
 * @example
 * // 前端收到响应后连接 SSE
 * const resp: StartTurnResponse = await fetch("/api/turns", { ... }).then(r => r.json())
 * const stream = new EventSource(resp.streamUrl)
 * // 可立即插入用户消息占位和助手消息占位
 * insertPlaceholder(resp.userMessageId, "user")
 * insertPlaceholder(resp.assistantMessageId, "assistant")
 */
export interface StartTurnResponse {
  requestId: RequestId
  sessionId: SessionId
  /** 已落盘的用户消息 ID——前端可立即插入用户气泡。 */
  userMessageId: MessageId
  /** 助手消息 ID——后续 SSE 事件（text_delta / tool_call_start 等）都归属此消息。 */
  assistantMessageId: MessageId
  acceptedAt: UnixMs
  /** SSE 流地址——前端 EventSource 连接此 URL 接收实时事件。 */
  streamUrl: string
}

// ═══════════════════════════════════════════════════════════════
// Turn 状态
// ═══════════════════════════════════════════════════════════════

/** Turn 的整体执行状态。 */
export type TurnStatus =
  | "queued"              // 已入队，等待执行
  | "running"             // 正在执行
  | "waiting_permission"  // 等待用户确认工具调用
  | "completed"           // 执行成功
  | "failed"              // 执行失败
  | "cancelled"           // 用户取消

/** 单个步骤的执行状态。 */
export type StepStatus =
  | "pending"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "skipped"

// ═══════════════════════════════════════════════════════════════
// Turn 持久化实体
// ═══════════════════════════════════════════════════════════════

/** Turn 持久化实体——`turns` 表的类型投影。storage-sql 和 session 包的读写契约。 */
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
  /** status === "failed" 时的稳定错误码——前端据此展示对应 UI 文案。 */
  errorCode?: string
  /** status === "failed" 时的用户可读错误消息。 */
  errorMessage?: string
}

// ═══════════════════════════════════════════════════════════════
// Turn 调试/审计视图
// ═══════════════════════════════════════════════════════════════

/** 单个 turn 的完整执行记录——前端 Turn 详情面板使用。 */
export interface TurnDetailView {
  turn: TurnRecord
  /** 该 turn 产生的消息列表。 */
  messages: MessagePage
  /** 该 turn 产生的所有产物。 */
  artifacts: ArtifactSummary[]
}
