/**
 * 跨领域聚合视图——组装多个领域实体后的前端渲染数据。
 *
 * ## 归属规则
 *
 * - Session 强相关视图（SessionDetailView, SessionListItem）→ session.ts
 * - Artifact 强相关视图（ArtifactListPanel）→ artifact.ts
 * - Turn 强相关视图（TurnDetailView）→ turn.ts
 * - 首页仪表盘 / 模型选择面板 / 工作区文件浏览 → 保留在此
 */

import type { SessionListItem } from "./session.js"
import type { ArtifactSummary } from "./artifact.js"
import type { ModelDescriptor } from "./model.js"
import type { ModelId, ProviderId, SessionId, UnixMs } from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// 首页仪表盘
// ═══════════════════════════════════════════════════════════════

/**
 * 首页/仪表盘聚合视图——对应 Panel ① 两栏卡片网格 + Provider 健康概览。
 *
 * @example
 * // GET /api/dashboard 的响应体
 * const dashboard: DashboardView = {
 *   recentSessions: [{ id: "ses_001", title: "修 bug 中...", updatedAt: 1700000000000 }],
 *   providerHealth: [{ providerId: "prov_openai", displayName: "OpenAI", status: "ok" }],
 *   recentArtifacts: [],
 * }
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

// ═══════════════════════════════════════════════════════════════
// 模型选择面板
// ═══════════════════════════════════════════════════════════════

/**
 * 模型下拉选择器的完整数据——按角色分组展示可选模型，并标记当前选择。
 *
 * @example
 * // 设置面板 → 模型选择 Tab 的数据
 * const picker: ModelPickerView = {
 *   providers: [{ id: "prov_openai", displayName: "OpenAI" }],
 *   modelsByRole: {
 *     chat: [gpt4o],
 *     agent: [gpt4o, claudeSonnet],
 *     narrative: [deepseekV4],
 *     title: [gpt4oMini],
 *   },
 *   selected: { chat: "gpt-4o", agent: "claude-sonnet-4-6" },
 * }
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
  /** 当前绑定（session 级或全局默认）。 */
  selected: {
    chat?: ModelId
    agent?: ModelId
    narrative?: ModelId
    title?: ModelId
  }
}

// ═══════════════════════════════════════════════════════════════
// 工作区文件浏览
// ═══════════════════════════════════════════════════════════════

/**
 * 工作区单个文件条目（非 diff，纯文件列表浏览）。
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
 * 当前 session 的工作区完整文件列表。
 * 对应 Panel ⑦ 侧边抽屉式文件管理模块。
 *
 * @example
 * // 工作区文件列表 API 响应
 * const fileList: WorkspaceFileListView = {
 *   sessionId: asId<SessionId>("ses_001"),
 *   files: [
 *     { path: "/workspace/src/app.ts", name: "app.ts", sizeBytes: 2048, modifiedAt: 1700000000000, language: "typescript" },
 *   ],
 * }
 */
export interface WorkspaceFileListView {
  sessionId: SessionId
  files: WorkspaceFileEntry[]
}
