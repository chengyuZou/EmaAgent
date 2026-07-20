// 持久化各类模型的调用级用量，并按 Turn 或 Session 提供确定性查询。
import type { SessionId, TurnId } from '@ema-agent/contracts';
import type { UsageRecord } from '@ema-agent/usage';
import type { SqliteDb } from '../database.js';

export interface UsageRecordRow {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  provider_id: string;
  model_id: string;
  capability: UsageRecord['capability'];
  status: UsageRecord['status'];
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  quantity: number | null;
  unit: string | null;
  cost_usd: number | null;
  duration_ms: number;
  error_code: string | null;
  created_at: number;
}

export class UsageRecordsRepo {
  constructor(private readonly db: SqliteDb) {}

  record(record: UsageRecord): void {
    this.db.prepare(`
      INSERT INTO usage_records (
        id, session_id, turn_id, provider_id, model_id, capability, status,
        input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
        quantity, unit, cost_usd, duration_ms, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        turn_id = excluded.turn_id,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        capability = excluded.capability,
        status = excluded.status,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        cache_write_input_tokens = excluded.cache_write_input_tokens,
        quantity = excluded.quantity,
        unit = excluded.unit,
        cost_usd = excluded.cost_usd,
        duration_ms = excluded.duration_ms,
        error_code = excluded.error_code,
        created_at = excluded.created_at
      WHERE usage_records.status = 'failed' AND excluded.status = 'completed'
    `).run(
      record.id, record.sessionId, record.turnId, record.providerId, record.modelId,
      record.capability, record.status, record.inputTokens, record.outputTokens,
      record.cacheReadInputTokens, record.cacheWriteInputTokens, record.quantity,
      record.unit, record.costUsd, record.durationMs, record.errorCode, record.createdAt,
    );
  }

  forTurn(turnId: TurnId): UsageRecordRow[] {
    return this.db.prepare(`
      SELECT * FROM usage_records
      WHERE turn_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(turnId) as UsageRecordRow[];
  }

  forSession(sessionId: SessionId): UsageRecordRow[] {
    return this.db.prepare(`
      SELECT * FROM usage_records
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as UsageRecordRow[];
  }
}
