/**
 * FTS5 全文搜索 — 为 memory_facts 和 attachment_chunks 提供加速索引。
 *
 * SQLite FTS5 虚拟表创建、重建和搜索辅助函数。
 * 替代各 repo 中的 naive LIKE '%keyword%' 搜索。
 */

import type { Database } from "better-sqlite3"

/** 初始化 FTS5 索引（在 migrate 中调用）。 */
export function createFtsIndexes(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
      content,
      kind,
      content='memory_facts',
      content_rowid='rowid'
    )
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS attachment_chunks_fts USING fts5(
      text,
      content='attachment_chunks',
      content_rowid='rowid'
    )
  `)
}

/** 重建 FTS5 索引（数据变更后调用，保持索引同步）。 */
export function rebuildFtsIndexes(db: Database): void {
  db.exec("INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild')")
  db.exec("INSERT INTO attachment_chunks_fts(attachment_chunks_fts) VALUES('rebuild')")
}

/** 使用 FTS5 搜索 memory facts，返回匹配的 rowid 列表（按 rank 排序）。 */
export function searchMemoryFactsFts(db: Database, query: string, limit: number): Array<{ rowid: number; rank: number }> {
  const rows = db.prepare(`
    SELECT rowid, rank
    FROM memory_facts_fts
    WHERE memory_facts_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(escapeFtsQuery(query), limit) as Array<{ rowid: number; rank: number }>

  return rows
}

/** 使用 FTS5 搜索 attachment chunks，返回匹配的 rowid 列表（按 rank 排序）。 */
export function searchAttachmentChunksFts(db: Database, query: string, limit: number): Array<{ rowid: number; rank: number }> {
  const rows = db.prepare(`
    SELECT rowid, rank
    FROM attachment_chunks_fts
    WHERE attachment_chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(escapeFtsQuery(query), limit) as Array<{ rowid: number; rank: number }>

  return rows
}

/**
 * 转义 LIKE 模式的通配符（`%` 和 `_`）。
 * 配合 `ESCAPE '\'` 子句使用，防止用户输入中的通配符被意外解析。
 */
export function escapeLike(query: string): string {
  return query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

/**
 * 转义 FTS5 查询字符串。
 * FTS5 特殊字符需要用双引号包裹或转义。
 */
function escapeFtsQuery(query: string): string {
  // 移除 FTS5 特殊字符，将查询拆分为词，每个词加前缀匹配
  const safe = query.replace(/[^\p{L}\p{N}_-]/gu, " ").trim()
  if (!safe) return '""'
  const terms = safe.split(/\s+/).filter(Boolean)
  return terms.map((t) => `"${t}"*`).join(" ")
}
