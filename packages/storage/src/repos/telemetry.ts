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
 * Generic event-stream sink — hooks, errors, state transitions.
 * Token usage and cost belong in UsageRepo, not here.
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
