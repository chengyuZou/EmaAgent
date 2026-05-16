import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId, LlmProvider } from '@ema-agent/contracts';

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

/**
 * Per-turn LLM token usage and cost — the billing/analytics side of telemetry.
 *
 * `turns.usage_input_tokens` / `usage_output_tokens` (in TurnsRepo) still hold
 * the same numbers for fast list display. This table adds model_id, provider,
 * and duration for detailed cost breakdowns.
 *
 * The denormalisation is intentional: turn list views read TurnsRepo only,
 * cost-attribution reports read UsageRepo only. The two-write coordination
 * is owned by the caller (SessionStore.completeTurn).
 */
export class UsageRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: TurnUsageRow): void {
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

  forTurn(turnId: TurnId): TurnUsageRow | undefined {
    return this.db
      .prepare('SELECT * FROM turn_usage WHERE turn_id = ?')
      .get(turnId) as TurnUsageRow | undefined;
  }

  forSession(sessionId: SessionId): TurnUsageRow[] {
    return this.db
      .prepare(
        `SELECT u.* FROM turn_usage u
         JOIN turns t ON t.id = u.turn_id
         WHERE t.session_id = ?
         ORDER BY u.created_at DESC`,
      )
      .all(sessionId) as TurnUsageRow[];
  }
}
