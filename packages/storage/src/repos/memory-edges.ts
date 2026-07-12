import type { SqliteDb } from '../database.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface MemoryEdgeRow {
  id:                  string;
  from_node_id:        string;
  to_node_id:          string;
  relation:            string;
  mention_count:       number;
  created_at:          number;
  last_referenced_at:  number;
}

export interface MemoryEdgeUpsert {
  id:           string;
  fromNodeId:   string;
  toNodeId:     string;
  relation:     string;
  at:           number;
}

export interface MemoryEdgeStats {
  total: number;
  avg_mention_count: number | null;
  max_mention_count: number | null;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Layer-0 有向边。召回时边权重计算为
 * log(1 + mention_count)-提及次数多的在 BFS 中浮到顶部。
 *
 * 并发：UNIQUE(from, to, relation) + ON CONFLICT DO UPDATE 使
 * upsert+自增原子化，多个并发 extraction 不会丢失计数。
 */
export class MemoryEdgesRepo {
  constructor(private readonly db: SqliteDb) {}

  /**
   * 插入或自增一条边。若 (from, to, relation) 三元组已存在，
   * 其 mention_count 自增 1；冲突时 `id` 参数被忽略。
   */
  upsert(e: MemoryEdgeUpsert): void {
    this.db
      .prepare(
        `INSERT INTO memory_edges
           (id, from_node_id, to_node_id, relation, mention_count, created_at, last_referenced_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(from_node_id, to_node_id, relation) DO UPDATE SET
           mention_count      = mention_count + 1,
           last_referenced_at = excluded.last_referenced_at`,
      )
      .run(e.id, e.fromNodeId, e.toNodeId, e.relation, e.at, e.at);
  }

  // ── 读取 ────────────────────────────────────────────────────────────────────

  listOutFrom(nodeId: string): MemoryEdgeRow[] {
    return this.db
      .prepare(
        'SELECT * FROM memory_edges WHERE from_node_id = ? ORDER BY mention_count DESC',
      )
      .all(nodeId) as MemoryEdgeRow[];
  }

  listInTo(nodeId: string): MemoryEdgeRow[] {
    return this.db
      .prepare(
        'SELECT * FROM memory_edges WHERE to_node_id = ? ORDER BY mention_count DESC',
      )
      .all(nodeId) as MemoryEdgeRow[];
  }

  /** 触及任一给定 node id 的所有边（任一方向）。 */
  listForNodes(nodeIds: string[]): MemoryEdgeRow[] {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM memory_edges
         WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})
         ORDER BY mention_count DESC`,
      )
      .all(...nodeIds, ...nodeIds) as MemoryEdgeRow[];
  }

  touchReferenced(ids: string[], at: number): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`UPDATE memory_edges SET last_referenced_at = ? WHERE id IN (${placeholders})`)
      .run(at, ...ids);
  }

  stats(): MemoryEdgeStats {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                AVG(mention_count) AS avg_mention_count,
                MAX(mention_count) AS max_mention_count
           FROM memory_edges`,
      )
      .get() as MemoryEdgeStats;
  }

  // ── 删除 ──────────────────────────────────────────────────────────────────

  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_edges WHERE id = ?').run(id);
  }
}
