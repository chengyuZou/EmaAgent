import type { SqliteDb } from '../database.js';
import { createSqliteIdBatches } from '../sqlite-id-batches.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

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
 * 每个 node 的 pending fragment 的只追加缓冲区。Consolidation 按
 * 主键（非 node_id）消费，使 LLM 往返期间到达的更新不被意外丢弃。
 *
 * 并发：纯 INSERT-无 read-modify-write-故无限并发追加是安全的。
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
        `SELECT * FROM memory_node_lazy_updates
          WHERE node_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(nodeId) as MemoryNodeLazyUpdateRow[];
  }

  /** 当前至少有一个 pending fragment 的所有 node。 */
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
   * 删除指定集合的更新行。使用 listByNode 返回的 id-
   * 在 listByNode 和此调用之间到达的 fragment 会保留。
   */
  deleteByIds(ids: string[]): void {
    const batches = createSqliteIdBatches(this.db, ids);
    this.db.transaction(() => {
      for (const batch of batches) {
        const placeholders = batch.map(() => '?').join(',');
        this.db
          .prepare(`DELETE FROM memory_node_lazy_updates WHERE id IN (${placeholders})`)
          .run(...batch);
      }
    })();
  }

  /** 孤儿清理-有 ON DELETE CASCADE 时应为 no-op。 */
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
