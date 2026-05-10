import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId, LlmProvider } from '@ema-agent/contracts';

export interface TelemetryEventRow {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  kind: string;
  payload_json: string;
  created_at: number;
}

export interface TurnUsageRow {
  turn_id: string;
  llm_provider: LlmProvider;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  created_at: number;
}

export class TelemetryRepo {
  constructor(private readonly db: SqliteDb) {}

  insertEvent(row: Omit<TelemetryEventRow, never>): void {
    this.db
      .prepare(
        `INSERT INTO telemetry_events (id, session_id, turn_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.session_id, row.turn_id, row.kind, row.payload_json, row.created_at);
  }

  insertTurnUsage(row: TurnUsageRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turn_usage
           (turn_id, llm_provider, model_id, input_tokens, output_tokens, cost_usd, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.turn_id, row.llm_provider, row.model_id,
        row.input_tokens, row.output_tokens, row.cost_usd, row.duration_ms, row.created_at,
      );
  }

  listEvents(kind: string, limit = 100): TelemetryEventRow[] {
    return this.db
      .prepare(
        'SELECT * FROM telemetry_events WHERE kind = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(kind, limit) as TelemetryEventRow[];
  }

  usageForSession(sessionId: SessionId): TurnUsageRow[] {
    return this.db
      .prepare(
        `SELECT u.* FROM turn_usage u
         JOIN turns t ON t.id = u.turn_id
         WHERE t.session_id = ?`,
      )
      .all(sessionId) as TurnUsageRow[];
  }

  usageForTurn(turnId: TurnId): TurnUsageRow | undefined {
    return this.db
      .prepare('SELECT * FROM turn_usage WHERE turn_id = ?')
      .get(turnId) as TurnUsageRow | undefined;
  }
}
