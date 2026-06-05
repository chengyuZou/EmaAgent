import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryNodeLazyUpdateRow {
  id:                 string;
  node_id:            string;
  fragment:           string;
  source_session_id:  string | null;
  source_turn_id:     string | null;
  created_at:         number;
}

export interface MemoryNodeLazyUpdateInsert {
  id:                string;
  nodeId:            string;
  fragment:          string;
  sourceSessionId?:  string;
  sourceTurnId?:     string;
  createdAt:         number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Append-only buffer of pending fragments for each node. Consolidation drains
 * them by primary key (not by node_id) so updates arriving during the LLM
 * round-trip are not accidentally dropped.
 *
 * Concurrency: pure INSERT — no read-modify-write — so unlimited concurrent
 * appends are safe.
 */
export class MemoryLazyUpdatesRepo {
  constructor(private readonly db: SqliteDb) {}

  append(u: MemoryNodeLazyUpdateInsert): void {
    this.db
      .prepare(
        `INSERT INTO memory_node_lazy_updates
           (id, node_id, fragment, source_session_id, source_turn_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(u.id, u.nodeId, u.fragment, u.sourceSessionId ?? null, u.sourceTurnId ?? null, u.createdAt);
  }

  listByNode(nodeId: string): MemoryNodeLazyUpdateRow[] {
    return this.db
      .prepare(
        'SELECT * FROM memory_node_lazy_updates WHERE node_id = ? ORDER BY created_at ASC',
      )
      .all(nodeId) as MemoryNodeLazyUpdateRow[];
  }

  /** All nodes that currently have at least one pending fragment. */
  listNodesWithPending(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT node_id FROM memory_node_lazy_updates')
      .all() as Array<{ node_id: string }>;
    return rows.map(r => r.node_id);
  }

  countAll(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memory_node_lazy_updates')
      .get() as { n: number };
    return row.n;
  }

  /**
   * Delete a specific set of update rows. Use the ids returned from listByNode
   * — fragments arriving between listByNode and this call survive.
   */
  deleteByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM memory_node_lazy_updates WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  /** Orphan cleanup — should be a no-op given ON DELETE CASCADE. */
  cleanOrphans(): number {
    const info = this.db
      .prepare(
        `DELETE FROM memory_node_lazy_updates
          WHERE node_id NOT IN (SELECT id FROM memory_nodes)`,
      )
      .run();
    return info.changes;
  }
}
