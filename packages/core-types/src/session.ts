/**
 * 会话实体、摘要与前端的聚合视图。
 *
 * 会话是对话的容器，持有标题、模式偏好、技能配置等元数据。
 * 消息体定义在 message.ts，Turn 定义在 turn.ts。
 *
 * 注意：Repository 接口不放在 core-types，
 * 它属于 storage-sql 或 session-runtime 内部。
 */

import type { EmaMode } from "./mode.js"
import type { MessagePage } from "./message.js"
import type { ArtifactPage } from "./artifact.js"
import type { RequestId, SessionId, UnixMs } from "./ids.js"

// ==========================================
// 会话实体
// ==========================================

export type SessionTitleStatus =
  | "default"
  | "pending"
  | "generated"
  | "fallback"
  | "manual"
  | "failed"

export interface SessionState {
  id: SessionId
  title: string
  createdAt: UnixMs
  updatedAt: UnixMs
  /** 最后一次成功执行 turn 所用的模式，供 UI 恢复默认焦点。 */
  lastMode: EmaMode
  fullAccess: boolean
  activeSkills: string[]
  titleStatus: SessionTitleStatus
  titleUpdatedAt?: UnixMs
}

export interface CreateSessionInput {
  id: SessionId
  title?: string
  lastMode?: EmaMode
  createdAt?: UnixMs
}

// ==========================================
// 会话摘要（列表页使用）
// ==========================================

export interface SessionSummary {
  id: SessionId
  title: string
  messageCount: number
  updatedAt: UnixMs
  lastMode: EmaMode
  /** 最新一条用户消息的纯文本截断（用于侧边栏预览）。 */
  lastMessagePreview?: string
}

// ==========================================
// 会话详情页聚合视图
// ==========================================

/**
 * 打开一个会话时，前端需要的完整视图。
 * 包含会话元数据 + 首屏消息分页 + 产物摘要 + 最近 turn 状态。
 */
export interface SessionDetailView {
  session: SessionState
  /** 首屏消息（通常最新 20 条）。 */
  initialMessages: MessagePage
  /** 最近一次 turn 的请求 ID（用于恢复 SSE 或重试）。 */
  lastRequestId?: RequestId
  /** 该 session 下的产物摘要（第一版可选）。 */
  artifacts?: ArtifactPage
}

// ==========================================
// 会话列表项（侧边栏）
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
