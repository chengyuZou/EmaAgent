import type { ContextBlock, ContextSource, EmaMode, SessionId } from "@ema-agent/core-types"

export type MemoryFactKind = "preference" | "skill" | "habit" | "project" | "note"

export interface MemoryFactRecord {
  id: string
  sessionId: SessionId
  kind: MemoryFactKind
  content: string
  confidence: number
  source: "explicit" | "summary" | "agent" | "import"
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface SessionSummaryRecord {
  sessionId: SessionId
  summaryText: string
  tokenCount: number
  coveredMessageCount: number
  updatedAt: number
}

export interface WriteMemoryFactInput {
  sessionId: SessionId
  kind: MemoryFactKind
  content: string
  confidence?: number
  source?: MemoryFactRecord["source"]
}

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
