import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Layer-0 directed edges. Edge weight in recall is computed as
 * log(1 + mention_count) — heavier mentions float to the top during BFS.
 *
 * Concurrency: UNIQUE(from, to, relation) + ON CONFLICT DO UPDATE makes the
 * upsert+increment atomic, so multiple concurrent extractions can't lose count.
 */
export class MemoryEdgesRepo {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Insert or bump an edge. If the (from, to, relation) tuple already exists,
   * its mention_count is incremented by 1; the `id` argument is ignored when
   * conflicting.
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

  // ── Read ────────────────────────────────────────────────────────────────────

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

  /** All edges touching any of the given node ids (in either direction). */
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

  // ── Delete ──────────────────────────────────────────────────────────────────

  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_edges WHERE id = ?').run(id);
  }
}
