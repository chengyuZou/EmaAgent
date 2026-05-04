/**
 * Agent Workspace 产物协议。
 *
 * Artifact 是 Agent 生成的结构化产出物——代码、表格、图表、Diff 等。
 * 轻量 `ArtifactSummary` 用于聊天流卡片，`ArtifactDetail` 用于右侧面板完整渲染。
 */

import type { ArtifactId, RequestId, SessionId, UnixMs } from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// 基础枚举
// ═══════════════════════════════════════════════════════════════

/** Workspace 中可管理的产物类型——UI 据此选择渲染器。 */
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

/** 产物生命周期状态——前端据此显示"草稿/就绪/已应用"等标签。 */
export type ArtifactStatus =
  | "draft"       // 生成中，未完成
  | "ready"       // 已完成，等待用户操作
  | "applied"     // 已应用到工作区（patch 被 accept）
  | "rejected"    // 被拒绝（patch 被 reject）
  | "superseded"  // 被更新的版本替代
  | "failed"      // 生成失败

// ═══════════════════════════════════════════════════════════════
// 文件差异
// ═══════════════════════════════════════════════════════════════

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

/** 产物杂项特征参数——供列表摘要快速渲染，无需加载完整 content。 */
export interface ArtifactParams {
  language?: string
  diff?: DiffMeta
  extra?: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════
// 列表摘要（聊天流轻量卡片）
// ═══════════════════════════════════════════════════════════════

/** 产物摘要——聊天流中的轻量卡片，足够渲染列表但不含完整内容。 */
export interface ArtifactSummary {
  id: ArtifactId
  sessionId: SessionId
  requestId: RequestId
  kind: ArtifactKind
  /** 用户友好的标题，如"重新设计 Router 错误拦截"。 */
  title: string
  description?: string
  mime: string
  /** 产物涉及的本地文件路径（patch / code 类型）。 */
  targetPaths?: string[]
  params?: ArtifactParams
  status: ArtifactStatus
  createdAt: UnixMs
  updatedAt: UnixMs
}

export interface ListArtifactsOptions {
  limit?: number
  /** 基于 createdAt 的游标分页。 */
  beforeCreatedAt?: UnixMs
  /** 与 beforeCreatedAt 配套的稳定游标——避免同毫秒产物翻页丢项。 */
  beforeArtifactId?: ArtifactId
  kinds?: ArtifactKind[]
  statuses?: ArtifactStatus[]
}

export interface ArtifactPage {
  items: ArtifactSummary[]
  hasMore: boolean
  nextBeforeCreatedAt?: UnixMs
  nextBeforeArtifactId?: ArtifactId
}

// ═══════════════════════════════════════════════════════════════
// 内容详情（右侧面板完整渲染）
// ═══════════════════════════════════════════════════════════════

/** 产物内容的引用方式：内联文本、本地文件路径、或 DB key。 */
export type ArtifactPayloadRef =
  | { type: "inline"; content: string }
  | { type: "file"; path: string }
  | { type: "db"; key: string }

/** 产物完整详情——右侧面板渲染所需的所有数据。 */
export interface ArtifactDetail {
  summary: ArtifactSummary
  payload: ArtifactPayloadRef
  /** 二进制内容（base64 DataURL 或本地地址——不可序列化 ArrayBuffer）。 */
  binaryBase64?: string
  /** 内容哈希——前端用于检测数据是否过期。 */
  contentHash?: string
}

// ═══════════════════════════════════════════════════════════════
// 产物面板视图
// ═══════════════════════════════════════════════════════════════

/** 产物列表面板——对应 WorkspacePane 中的产物列表（胶囊形卡片 + 打开按钮）。 */
export interface ArtifactListPanel {
  sessionId: SessionId
  page: ArtifactPage
}
