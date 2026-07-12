import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId, LlmProtocol } from '@ema-agent/contracts';

export interface TurnUsageRow {
  turn_id: string;
  llm_provider: LlmProtocol;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  created_at: number;
}

/**
 * 每个 turn 的 LLM token 用量和费用 — telemetry 的计费/分析侧。
 *
 * `turns.usage_input_tokens` / `usage_output_tokens` （在 TurnsRepo 中）仍存
 * 相同数值，用于快速列表展示。此表增加 model_id、provider
 * 和 duration，用于详细的费用分解。
 *
 * 此反规范化是有意为之：turn 列表视图只读 TurnsRepo，
 * 费用归因报告只读 UsageRepo。双写协调由
 * 调用方（SessionStore.completeTurn）负责。
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
