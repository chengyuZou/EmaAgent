/**
 * 会话实体与仓储接口。
 *
 * 会话是对话的容器，持有标题、模式偏好、技能配置等元数据。
 * 消息体定义在 message.ts，聚合视图定义在 view.ts。
 */

import type { EmaMode } from "./mode.js" 
import type { ChatMessage, ListMessagesOptions, MessagePage } from "./message.js"
import type { SessionId, UnixMs } from "./ids.js"

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
}

// ==========================================
// 仓储接口
// ==========================================

export interface SessionRepository {
  getById(sessionId: SessionId): Promise<SessionState | null>
  create(input: CreateSessionInput): Promise<SessionState>
  save(session: SessionState): Promise<void>
  list(): Promise<SessionSummary[]>
  listMessages(
    sessionId: SessionId,
    options?: ListMessagesOptions
  ): Promise<MessagePage>
  appendMessage(sessionId: SessionId, message: ChatMessage): Promise<void>
  updateTitle(
    sessionId: SessionId,
    title: string,
    status?: SessionTitleStatus
  ): Promise<void>
  updateLastMode(sessionId: SessionId, mode: EmaMode): Promise<void>
  delete(sessionId: SessionId): Promise<void>
}