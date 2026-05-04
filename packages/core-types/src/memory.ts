/**
 * 记忆与召回的核心类型 — V1 记忆模型。
 *
 * ## 当前实现范围（V1）
 *
 * V1 只实现了 V0.4 级别的记忆能力：
 * - `MemoryFactRecord`：用户偏好/技能/习惯事实（SQLite 表 `memory_facts`）
 * - `SessionSummaryRecord`：会话滚动摘要
 * - `ContextBlock`：注入 system prompt 的标准化文本块
 * - `MemoryPlanner` 的 recall → budget → assemble 管线
 *
 * ## V2 规划（Python Bridge 接入后生效）
 *
 * - 4 层记忆模型：L1 工作记忆 → L2 会话摘要 → L3 身份档案 → L4 跨会话画像
 * - Narrative 剧情记忆走 Python LightRAG，TS 侧只做格式转换
 * - GraphRAG 检索（保留 schema 占位）
 *
 * ## 关键原则
 *
 * 1. 所有记忆最终转换为 `ContextBlock`，按 priority 排序后注入 system prompt
 * 2. 原始 user query 永远不被污染（输入信封隔离）
 * 3. 两套记忆（通用 memory + narrative）互相不知道对方存在，由 orchestrator 合并
 */

import type { EmaMode } from "./mode.js"
import type { SessionId, UnixMs } from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// 统一召回层（所有 Mode 共享）
// ═══════════════════════════════════════════════════════════════

/** 上下文来源标识——决定 ContextBlock 在 system prompt 中的语义角色。 */
export type ContextSource =
  | "system_prompt"
  | "rolling_summary"
  | "recent_messages"
  | "working_scratchpad"
  | "user_profile"
  | "semantic_fact"
  | "narrative_world"
  | "attachment_chunk"
  | "vision_frame"
  | "vision_gallery"

/** 上下文块——所有记忆的最终形态，直接注入 system prompt。 */
export interface ContextBlock {
  source: ContextSource
  /** 优先级（budget 不足时按 priority 降序截断）。 */
  priority: number
  content: string
  tokenEstimate: number
}

// ═══════════════════════════════════════════════════════════════
// 记忆事实（V1，SQLite 表 `memory_facts`）
// ═══════════════════════════════════════════════════════════════

export type MemoryFactKind = "preference" | "skill" | "habit" | "project" | "note"

export interface MemoryFactRecord {
  id: string
  sessionId: SessionId
  kind: MemoryFactKind
  content: string
  confidence: number
  source: "explicit" | "summary" | "agent" | "import"
  createdAt: UnixMs
  updatedAt: UnixMs
  lastUsedAt?: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 会话摘要
// ═══════════════════════════════════════════════════════════════

export interface SessionSummaryRecord {
  sessionId: SessionId
  summaryText: string
  tokenCount: number
  coveredMessageCount: number
  updatedAt: UnixMs
}

// ═══════════════════════════════════════════════════════════════
// 上下文预算与召回
// ═══════════════════════════════════════════════════════════════

export interface ContextBudget {
  maxTokens: number
  reservedOutputTokens: number
  usedTokens: number
  remainingTokens: number
  compacted: boolean
}

export interface ContextRadarView {
  sessionId: SessionId
  mode: EmaMode
  query: string
  budget: ContextBudget
  blocks: ContextBlock[]
  summary?: SessionSummaryRecord
  sourceStats: Partial<Record<ContextSource, { count: number; tokens: number }>>
}

export interface RecallPlannerInput {
  sessionId: SessionId
  mode: EmaMode
  query: string
  maxTokens?: number
}

export interface WriteMemoryFactInput {
  sessionId: SessionId
  kind: MemoryFactKind
  content: string
  confidence?: number
  source?: MemoryFactRecord["source"]
}

// ═══════════════════════════════════════════════════════════════
// Narrative Bridge（Python LightRAG）
// ═══════════════════════════════════════════════════════════════

/** Python Narrative Bridge 查询参数。 */
export interface NarrativeBridgeQuery {
  worldId: string
  sceneContext: string
  query: string
  characterIds?: string[]
}

/** Python Narrative Bridge 返回结果（LightRAG 查询后，TS 侧转换前）。 */
export interface NarrativeBridgeResult {
  chunks: Array<{
    text: string
    relevance: number
    source: string
  }>
  deduped: boolean
  durationMs: number
}
