/**
 * 会话实体、摘要与前端的聚合视图。
 *
 * 会话是对话的容器——持有标题、模式偏好、技能配置等元数据。
 * 消息体定义在 `message.ts`，Turn 定义在 `turn.ts`。
 *
 * 注意：Repository 接口不放在 core-types——它属于 storage-sql 或 session 包内部实现。
 */

import type { EmaMode } from "./mode.js"
import type { MessagePage } from "./message.js"
import type { ArtifactPage } from "./artifact.js"
import type { RequestId, SessionId, UnixMs } from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// 会话实体
// ═══════════════════════════════════════════════════════════════

/** 会话标题的生成/编辑状态——前端据此决定是否显示"生成中"动画。 */
export type SessionTitleStatus =
  | "default"     // 未生成过标题，使用占位符
  | "pending"     // LLM 正在生成标题
  | "generated"   // LLM 已生成标题
  | "fallback"    // LLM 生成失败，使用前 30 字截断
  | "manual"      // 用户手动编辑过
  | "failed"      // 标题生成彻底失败

/** 会话持久化实体——数据库 `sessions` 表的类型投影。 */
export interface SessionState {
  id: SessionId
  title: string
  createdAt: UnixMs
  updatedAt: UnixMs
  /** 最后一次成功执行 turn 所用的 mode——供 UI 输入区恢复默认焦点。 */
  lastMode: EmaMode
  /** 是否允许 Agent 全功能访问（false 时仅 chat 可用）。 */
  fullAccess: boolean
  /** 当前激活的技能模块列表（如 ["file_search", "web_browse"]）。 */
  activeSkills: string[]
  titleStatus: SessionTitleStatus
  titleUpdatedAt?: UnixMs
}

/** 创建会话的输入——BFF 在 POST /api/sessions 时使用。 */
export interface CreateSessionInput {
  id: SessionId
  title?: string
  lastMode?: EmaMode
  createdAt?: UnixMs
  fullAccess?: boolean
  activeSkills?: string[]
}

// ═══════════════════════════════════════════════════════════════
// 会话摘要（列表页使用）
// ═══════════════════════════════════════════════════════════════

/** 侧边栏会话列表的单条摘要——字段足够渲染卡片，无需加载完整 SessionState。 */
export interface SessionSummary {
  id: SessionId
  title: string
  messageCount: number
  updatedAt: UnixMs
  lastMode: EmaMode
  /** 最新一条 user 消息的纯文本截断——侧边栏 hover 预览用。 */
  lastMessagePreview?: string
}

// ═══════════════════════════════════════════════════════════════
// 侧边栏列表项
// ═══════════════════════════════════════════════════════════════

/** 侧边栏会话列表的聚合项——列表摘要 + 可选的消息预览。 */
export interface SessionListItem {
  summary: SessionSummary
  /** 最新一条 user 消息的纯文本截断——侧边栏 hover 气泡用。 */
  lastMessagePreview?: string
}

// ═══════════════════════════════════════════════════════════════
// 会话详情页聚合视图
// ═══════════════════════════════════════════════════════════════

/**
 * 打开一个会话时，前端需要的完整视图。
 *
 * 包含会话元数据 + 首屏消息分页 + 产物摘要 + 最近 turn 状态。
 * BFF 在 GET /api/sessions/:id 时组装此视图。
 *
 * @example
 * // 前端打开会话
 * const view: SessionDetailView = await fetch(`/api/sessions/${sessionId}`).then(r => r.json())
 * // view.initialMessages.items → 首屏消息（最新 20 条）
 * // view.lastRequestId → 用于连接 SSE 恢复流或重试
 */
export interface SessionDetailView {
  session: SessionState
  /** 首屏消息（通常最新 20 条）。 */
  initialMessages: MessagePage
  /** 最近一次 turn 的请求 ID——用于恢复 SSE 或重试。 */
  lastRequestId?: RequestId
  /** 该 session 下的产物摘要（第一版可选）。 */
  artifacts?: ArtifactPage
}
