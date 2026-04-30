/**
 * 跨领域聚合视图（只在该文件放真正跨多个领域的视图）。
 *
 * 规则：
 * - Session 强相关的视图（SessionDetailView, SessionListItem）→ session.ts
 * - Artifact 强相关的视图（ArtifactListPanel）→ artifact.ts
 * - Turn 强相关的视图（TurnDetailView）→ turn.ts
 * - 模型选择面板 → model.ts 或保留在此
 * - 首页仪表盘 / 工作区文件浏览 → 保留在此
 */

import type { SessionListItem } from "./session.js"
import type { ArtifactSummary } from "./artifact.js"
import type { ModelDescriptor } from "./model.js"
import type { ModelId, ProviderId, SessionId, UnixMs } from "./ids.js"

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
