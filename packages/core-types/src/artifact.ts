/**
 * Agent Workspace 产物协议。
 *
 * Artifact 是 Agent 生成的结构化产出物——代码、表格、图表、Patch 等。
 * 轻量摘要用于聊天流卡片，Detail 用于右侧画布/弹窗完整渲染。
 *
 * 注意：Repository 接口不放在 core-types，
 * 它属于 storage-sql 或 session-runtime 内部。
 */

import type { ArtifactId, RequestId, SessionId, UnixMs } from "./ids.js"

// ==========================================
// 基础枚举
// ==========================================

/** Workspace 中可管理的产物类型。 */
export type ArtifactKind =
  | "code"
  | "table"
  | "mermaid"
  | "math"
  | "html_report"
  | "chart"
  | "image"
  | "file"
  | "patch"
  | "dataset"
  | "notebook"
  | "log"

/** 产物当前的生命周期状态。 */
export type ArtifactStatus =
  | "draft"
  | "ready"
  | "applied"
  | "rejected"
  | "superseded"
  | "failed"

// ==========================================
// 文件差异元数据
// ==========================================

export interface FileDiffSummary {
  path: string
  language?: string
  changeType: "added" | "modified" | "deleted" | "renamed"
  oldPath?: string
  baseHash?: string
  headHash?: string
  stats: {
    additions: number
    deletions: number
  }
}

export interface DiffMeta {
  files: FileDiffSummary[]
  commitHash?: string
}

/** 产物杂项特征参数，供列表摘要快速渲染。 */
export interface ArtifactParams {
  language?: string
  diff?: DiffMeta
  /** 收拢未知属性，防止与官方字段冲突。 */
  extra?: Record<string, unknown>
}

// ==========================================
// 列表摘要层（聊天流轻量卡片）
// ==========================================

export interface ArtifactSummary {
  id: ArtifactId
  /** 会话级追踪 ID（用于全链路）。 */
  sessionId: SessionId
  /** 产生此产物的 API Request ID。 */
  requestId: RequestId
  /** 产物类型，UI 据此派发渲染器。 */
  kind: ArtifactKind
  /** 用户友好的标题，如 "重新设计 Router 错误拦截"。 */
  title: string
  /** 一句话描述，用于卡片列表副标题。 */
  description?: string
  /** MIME 类型。 */
  mime: string
  /** 当产物涉及本地文件时，目标路径列表。 */
  targetPaths?: string[]
  /** 轻量结构化参数，无需加载完整 content。 */
  params?: ArtifactParams
  status: ArtifactStatus
  createdAt: UnixMs
  updatedAt: UnixMs
}

export interface ListArtifactsOptions {
  limit?: number
  /** 下一页游标：基于 createdAt 的时间戳分页。 */
  beforeCreatedAt?: UnixMs
  
  /** 
   * 按产物类型过滤。如果不传，则返回所有类型。
   * 比如只想要代码和图表：["code", "chart"]
   */
  kinds?: ArtifactKind[]
  
  /** 
   * 按产物状态过滤。
   * 比如只看已准备好或被采纳的：["ready", "applied"]
   */
  statuses?: ArtifactStatus[]
}

export interface ArtifactPage {
  items: ArtifactSummary[]
  hasMore: boolean
  /** 下一页游标：beforeCreatedAt（基于 createdAt 的时间戳分页）。 */
  nextBeforeCreatedAt?: UnixMs
}

// ==========================================
// 内容详情载荷（右侧面板完整渲染）
// ==========================================

export type ArtifactPayloadRef =
  | { type: "inline"; content: string }
  | { type: "file"; path: string }
  | { type: "db"; key: string }

export interface ArtifactDetail {
  /** 关联的摘要数据。 */
  summary: ArtifactSummary
  /**
   * 产物的原始文本内容。
   * 大量源码、Unified Diff、MathJax 字符都在此字段。
   */
  payload: ArtifactPayloadRef
  /**
   * 二进制内容，必须是 base64 DataURL 或本地可访问地址。
   * 禁止使用 ArrayBuffer（不可序列化）。
   */
  binaryBase64?: string
  /** 内容哈希签名，防止串流时数据过期。 */
  contentHash?: string
}

// ==========================================
// 产物面板视图
// ==========================================

/**
 * 在当前 session/turn 中打开"产物列表"面板时展示的视图。
 * 对应 Panel ⑧ 模型组件列表（胶囊形卡片 + 打开按钮）。
 */
export interface ArtifactListPanel {
  sessionId: SessionId
  page: ArtifactPage
}
