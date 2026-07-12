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
 * token 用量和费用属于 UsageRepo，不在此处。
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
        'SELECT * FROM telemetry_events WHERE kind = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(kind, limit) as TelemetryEventRow[];
  }
}
