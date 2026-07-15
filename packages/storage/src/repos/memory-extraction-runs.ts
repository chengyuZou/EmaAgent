import type { SqliteDb } from '../database.js';

export interface MemoryExtractionRunRow {
  run_id:             string;
  session_id:         string;
  source_turn_id:     string;
  note_delta:         string;
  nodes_count:        number;
  edges_count:        number;
  items_count:        number;
  lazy_updates_count: number;
  committed_at:       number;
}

export interface MemoryExtractionRunInsert {
  runId:             string;
  sessionId:         string;
  sourceTurnId:      string;
  noteDelta:         string;
  nodesCount:        number;
  edgesCount:        number;
  itemsCount:        number;
  lazyUpdatesCount:  number;
  committedAt:       number;
}

/**
 * Memory 提取的跨数据库恢复标记。
 *
 * 它不是长期任务历史：profile 写入成功时创建，data 写入成功后删除。
 * 若进程在两者之间退出，同一 task/run ID 的重试可据此跳过 profile 重写。
 */
export class MemoryExtractionRunsRepo {
  constructor(private readonly db: SqliteDb) {}

  findById(runId: string): MemoryExtractionRunRow | undefined {
    return this.db
      .prepare('SELECT * FROM memory_extraction_runs WHERE run_id = ?')
      .get(runId) as MemoryExtractionRunRow | undefined;
  }

  insert(run: MemoryExtractionRunInsert): void {
    this.db
      .prepare(
        `INSERT INTO memory_extraction_runs
           (run_id, session_id, source_turn_id, note_delta,
            nodes_count, edges_count, items_count, lazy_updates_count, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.sessionId,
        run.sourceTurnId,
        run.noteDelta,
        run.nodesCount,
        run.edgesCount,
        run.itemsCount,
        run.lazyUpdatesCount,
        run.committedAt,
      );
  }

  delete(runId: string): void {
    this.db.prepare('DELETE FROM memory_extraction_runs WHERE run_id = ?').run(runId);
  }

  deleteCommittedBefore(cutoff: number): number {
    const result = this.db
      .prepare('DELETE FROM memory_extraction_runs WHERE committed_at < ?')
      .run(cutoff);
    return result.changes;
  }
}
