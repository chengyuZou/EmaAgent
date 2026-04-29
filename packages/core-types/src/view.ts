/**
 * 前端/API 聚合视图。
 *
 * 这些类型不是持久化实体，而是多个实体 join 后的只读投影，
 * 专供前端列表页、详情页、侧边栏等场景使用。
 *
 * 规则：
 * - 字段来自已定义的实体类型，不重复声明。
 * - 视图只做"拼装"，不做业务计算。
 */

import type { ArtifactSummary, ArtifactPage } from "./artifact.js"
import type { EmaMode } from "./mode.js"
import type { MessagePage } from "./message.js" 
import type { SessionSummary } from "./session.js"
import type { TurnRecord } from "./turn.js"
import type { ModelDescriptor } from "./model.js"
import type {
  ModelId,
  ProviderId,
  RequestId,
  SessionId,
  UnixMs,
} from "./ids.js"

// ==========================================
// 会话详情页聚合
// ==========================================

/**
 * 打开一个会话时，前端需要的完整视图。
 * 包含会话元数据 + 首屏消息分页 + 关联的模型信息。
 */
export interface SessionDetailView {
  session: {
    id: SessionId
    title: string
    lastMode: EmaMode
    createdAt: UnixMs
    updatedAt: UnixMs
  }
  /** 首屏消息（通常最新 20 条）。 */
  initialMessages: MessagePage
  /** 最近一次 turn 的请求 ID（用于恢复 SSE 或重试）。 */
  lastRequestId?: RequestId
  /** 该会话绑定的默认模型。 */
  models: {
    chat?: ModelDescriptor
    agent?: ModelDescriptor
    narrative?: ModelDescriptor
  }
}

// ==========================================
// 会话列表页
// ==========================================

/**
 * 侧边栏会话列表聚合。
 * 列表摘要 + 可选的最新消息预览（用于 hover 气泡）。
 */
export interface SessionListItem {
  summary: SessionSummary
  /** 最新一条用户消息的纯文本截断（用于侧边栏预览）。 */
  lastMessagePreview?: string
}

// ==========================================
// 产物面板
// ==========================================

/**
 * 在当前 session 中打开"产物列表"时，展示所有产物的摘要。
 */
export interface ArtifactListPanel {
  sessionId: SessionId
  page: ArtifactPage
}

// ==========================================
// Turn 调试/审计页
// ==========================================

/**
 * 查看某个 turn 的完整执行记录（调试/审计用）。
 */
export interface TurnDetailView {
  turn: TurnRecord
  /** 该 turn 产生的消息列表。 */
  messages: MessagePage
  /** 该 turn 产生的所有产物。 */
  artifacts: ArtifactSummary[]
}

// ==========================================
// 模型选择面板
// ==========================================

/**
 * 模型下拉选择器的数据。
 */
export interface ModelPickerView {
  /** 所有可用 Provider。 */
  providers: {
    id: ProviderId
    displayName: string
  }[]
  /** 按角色分组的模型列表。 */
  modelsByRole: {
    chat: ModelDescriptor[]
    agent: ModelDescriptor[]
    narrative: ModelDescriptor[]
    title: ModelDescriptor[]
  }
  /** 当前选择。 */
  selected: {
    chat?: ModelId
    agent?: ModelId
    narrative?: ModelId
    title?: ModelId
  }
}

// ==========================================
// 首页仪表盘
// ==========================================

/**
 * 首页/仪表盘聚合视图。
 * 对应 Panel ① 两栏卡片网格 + Provider 健康概览。
 */
export interface DashboardView {
  recentSessions: SessionListItem[]
  /** 当前挂载的 Provider 健康状态。 */
  providerHealth: {
    providerId: ProviderId
    displayName: string
    status: "ok" | "degraded" | "down"
  }[]
  /** 最近产物速览。 */
  recentArtifacts: ArtifactSummary[]
}

// ==========================================
// 工作区文件浏览
// ==========================================

/**
 * 工作区文件条目（非 diff，纯文件列表浏览）。
 * 对应 Panel ⑦ 文件清单浮窗。
 */
export interface WorkspaceFileEntry {
  path: string
  name: string
  /** 文件大小（字节）。 */
  sizeBytes: number
  modifiedAt: UnixMs
  language?: string
}

/**
 * 当前 session 的工作区文件列表。
 * 对应 Panel ⑦ 侧边抽屉式文件管理模块。
 */
export interface WorkspaceFileListView {
  sessionId: SessionId
  files: WorkspaceFileEntry[]
}
