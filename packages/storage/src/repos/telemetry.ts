// 持久化有界诊断事件，不承载模型用量记录。
import type { SqliteDb } from '../database.js';

export interface TelemetryEventRow {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  kind: string;
  payload_json: string;
  created_at: number;
}

/**
 * 通用事件流 sink — hook、错误、状态转换。
 * 模型 Token、费用和耗时指标属于 UsageRecordsRepo，不在此处。
 */
export class TelemetryRepo {
  constructor(private readonly db: SqliteDb) {}

  insertEvent(row: TelemetryEventRow): void {
    this.db
      .prepare(
        `INSERT INTO telemetry_events (id, session_id, turn_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.session_id, row.turn_id, row.kind, row.payload_json, row.created_at);
  }

  listEvents(kind: string, limit = 100): TelemetryEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM telemetry_events
          WHERE kind = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(kind, limit) as TelemetryEventRow[];
  }

  /**
   * 按全局事件时间清理过期遥测。单批数量有硬上限，避免大量历史数据在一次
   * DELETE 中长期占用 SQLite 写锁。调度频率和保留时间由 TelemetryRecorder
   * Facade 决定，Storage 只保证清理原子、有界且顺序确定。
   */
  deleteOlderThan(olderThan: number, limit = 500): number {
    if (!Number.isFinite(olderThan)) {
      throw new RangeError('olderThan must be a finite timestamp');
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RangeError('limit must be an integer between 1 and 1000');
    }

    const info = this.db
      .prepare(
        `DELETE FROM telemetry_events
          WHERE id IN (
            SELECT id FROM telemetry_events
             WHERE created_at < ?
             ORDER BY created_at ASC, id ASC
             LIMIT ?
          )`,
      )
      .run(olderThan, limit);
    return info.changes;
  }
}
