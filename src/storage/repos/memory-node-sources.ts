// L0 节点溯源：每个记忆节点的事实来源 Session/Turn，写入即登记，供召回展示与审计。
import type { SqliteDb } from '../database.js';
import { createSqliteIdBatches } from '../sqlite-id-batches.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface MemoryNodeSourceRow {
  node_id:           string;
  source_session_id: string;
  /** 空串表示该来源无法定位到具体 Turn（迁移回填或早期数据）。 */
  source_turn_id:    string;
  created_at:        number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * `memory_node_sources` 关联表。节点经多次提取/lazy update 累积证据，
 * 同一 (node, session, turn) 只保留首次登记时间。
 *
 * 并发：纯 INSERT OR IGNORE，无 read-modify-write，无限并发登记安全。
 */
export class MemoryNodeSourcesRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 幂等登记一条来源；重复登记是 no-op。 */
  record(
    nodeId: string,
    sourceSessionId: string,
    sourceTurnId: string | null,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_node_sources
           (node_id, source_session_id, source_turn_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(nodeId, sourceSessionId, sourceTurnId ?? '', at);
  }

  /** 按登记时间升序返回某节点的全部来源。 */
  listByNode(nodeId: string): MemoryNodeSourceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_node_sources
          WHERE node_id = ?
          ORDER BY created_at ASC, source_session_id ASC, source_turn_id ASC`,
      )
      .all(nodeId) as MemoryNodeSourceRow[];
  }

  /** 批量读取多个节点的来源（召回侧展示用），按登记时间升序。 */
  listByNodes(nodeIds: string[]): MemoryNodeSourceRow[] {
    const batches = createSqliteIdBatches(this.db, nodeIds);
    const rows: MemoryNodeSourceRow[] = [];
    for (const batch of batches) {
      const placeholders = batch.map(() => '?').join(',');
      rows.push(...(this.db
        .prepare(
          `SELECT * FROM memory_node_sources
            WHERE node_id IN (${placeholders})
            ORDER BY created_at ASC, source_session_id ASC, source_turn_id ASC`,
        )
        .all(...batch) as MemoryNodeSourceRow[]));
    }
    return rows;
  }
}
