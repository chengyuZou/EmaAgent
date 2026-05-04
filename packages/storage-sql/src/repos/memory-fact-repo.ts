/**
 * Memory Fact 仓储 — memory_facts + session_summaries 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type { SessionId } from "@ema-agent/core-types"
import { MEMORY_RECALL_LIMIT, DEFAULT_FACT_CONFIDENCE } from "@ema-agent/constants-core"
import { escapeLike } from "../fts.js"

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

export interface MemoryRepository {
  upsertFact(input: Omit<MemoryFactRecord, "createdAt" | "updatedAt" | "lastUsedAt">): Promise<MemoryFactRecord>
  listFacts(sessionId: SessionId): Promise<MemoryFactRecord[]>
  searchFacts(sessionId: SessionId, query: string, limit?: number): Promise<MemoryFactRecord[]>
  saveSummary(input: Omit<SessionSummaryRecord, "updatedAt">): Promise<SessionSummaryRecord>
  getSummary(sessionId: SessionId): Promise<SessionSummaryRecord | null>
}

interface FactRow {
  id: string
  session_id: string
  kind: string
  content: string
  confidence: number
  source: string
  created_at: number
  updated_at: number
  last_used_at: number | null
}

interface SummaryRow {
  session_id: string
  summary_text: string
  token_count: number
  covered_message_count: number
  updated_at: number
}

function rowToFact(row: FactRow): MemoryFactRecord {
  return {
    id: row.id,
    sessionId: row.session_id as SessionId,
    kind: row.kind as MemoryFactKind,
    content: row.content,
    confidence: row.confidence,
    source: row.source as MemoryFactRecord["source"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
  }
}

function rowToSummary(row: SummaryRow): SessionSummaryRecord {
  return {
    sessionId: row.session_id as SessionId,
    summaryText: row.summary_text,
    tokenCount: row.token_count,
    coveredMessageCount: row.covered_message_count,
    updatedAt: row.updated_at,
  }
}

export function createMemoryRepository(db: Database): MemoryRepository {
  return {
    async upsertFact(input) {
      const now = Date.now()
      db.prepare(`
        INSERT INTO memory_facts (id, session_id, kind, content, confidence, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind, content = excluded.content,
          confidence = excluded.confidence, source = excluded.source,
          updated_at = excluded.updated_at
      `).run(input.id, input.sessionId, input.kind, input.content, input.confidence ?? DEFAULT_FACT_CONFIDENCE, input.source, now, now)

      const row = db.prepare("SELECT * FROM memory_facts WHERE id = ?").get(input.id) as FactRow
      return rowToFact(row)
    },

    async listFacts(sessionId) {
      const rows = db.prepare(
        "SELECT * FROM memory_facts WHERE session_id = ? ORDER BY confidence DESC, updated_at DESC"
      ).all(sessionId) as FactRow[]
      return rows.map(rowToFact)
    },

    async searchFacts(sessionId, query, limit = MEMORY_RECALL_LIMIT) {
      const likePattern = `%${escapeLike(query.toLowerCase())}%`
      const rows = db.prepare(
        "SELECT * FROM memory_facts WHERE session_id = ? AND lower(content) LIKE ? ESCAPE '\\' ORDER BY confidence DESC, updated_at DESC LIMIT ?"
      ).all(sessionId, likePattern, limit) as FactRow[]

      const facts = rows.map(rowToFact)
      const touch = db.prepare("UPDATE memory_facts SET last_used_at = ? WHERE id = ?")
      for (const fact of facts) {
        touch.run(Date.now(), fact.id)
      }
      return facts
    },

    async saveSummary(input) {
      const now = Date.now()
      db.prepare(`
        INSERT INTO session_summaries (session_id, summary_text, token_count, covered_message_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          summary_text = excluded.summary_text, token_count = excluded.token_count,
          covered_message_count = excluded.covered_message_count, updated_at = excluded.updated_at
      `).run(input.sessionId, input.summaryText, input.tokenCount, input.coveredMessageCount, now)

      return { ...input, updatedAt: now }
    },

    async getSummary(sessionId) {
      const row = db.prepare("SELECT * FROM session_summaries WHERE session_id = ?").get(sessionId) as SummaryRow | undefined
      return row ? rowToSummary(row) : null
    },
  }
}
