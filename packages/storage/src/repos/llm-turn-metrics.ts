import type { LlmProtocol, SessionId, TurnId } from '@ema-agent/contracts';
import type { SqliteDb } from '../database.js';

export interface LlmTurnMetricsRow {
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
 * 每个 Turn 的 LLM 观测指标，包括 Token、成本、模型归因和调用耗时。
 *
 * `turns.usage_input_tokens` / `usage_output_tokens` 仍保留相同数值，供会话列表
 * 快速展示；本表服务于详细的模型指标与成本分析。双写协调由上层 Session
 * Facade 负责，Storage 不跨 Repo 隐式修改 Turn。
 */
export class LlmTurnMetricsRepo {
  constructor(private readonly db: SqliteDb) {}

  upsert(row: LlmTurnMetricsRow): void {
    this.db
      .prepare(
        `INSERT INTO llm_turn_metrics
           (turn_id, llm_provider, model_id, input_tokens, output_tokens, cost_usd, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(turn_id) DO UPDATE SET
           llm_provider = excluded.llm_provider,
           model_id = excluded.model_id,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cost_usd = excluded.cost_usd,
           duration_ms = excluded.duration_ms,
           created_at = excluded.created_at`,
      )
      .run(
        row.turn_id,
        row.llm_provider,
        row.model_id,
        row.input_tokens,
        row.output_tokens,
        row.cost_usd,
        row.duration_ms,
        row.created_at,
      );
  }

  forTurn(turnId: TurnId): LlmTurnMetricsRow | undefined {
    return this.db
      .prepare('SELECT * FROM llm_turn_metrics WHERE turn_id = ?')
      .get(turnId) as LlmTurnMetricsRow | undefined;
  }

  forSession(sessionId: SessionId): LlmTurnMetricsRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM llm_turn_metrics m
         JOIN turns t ON t.id = m.turn_id
         WHERE t.session_id = ?
         ORDER BY m.created_at DESC, m.turn_id DESC`,
      )
      .all(sessionId) as LlmTurnMetricsRow[];
  }
}
