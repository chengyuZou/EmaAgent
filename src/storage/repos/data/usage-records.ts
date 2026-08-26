// 持久化各类模型的调用级用量，并按 Turn 或 Session 提供确定性查询。
import type { UsageRecord } from '@ema-agent/usage';
import type { SqliteDb } from '../../database/database.js';

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
        quantity, unit, duration_ms, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.sessionId, record.turnId, record.providerId, record.modelId,
      record.capability, record.status, record.inputTokens, record.outputTokens,
      record.cacheReadInputTokens, record.cacheWriteInputTokens, record.quantity,
      record.unit, record.durationMs, record.errorCode, record.createdAt,
    );
  }

  forTurn(turnId: string): UsageRecordRow[] {
    return this.db.prepare(`
      SELECT * FROM usage_records
      WHERE turn_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(turnId) as UsageRecordRow[];
  }

  forSession(sessionId: string): UsageRecordRow[] {
    return this.db.prepare(`
      SELECT * FROM usage_records
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as UsageRecordRow[];
  }

  /** 删除早于 cutoffMs 的记录，返回删除行数；由启动一次性保留清理调用。 */
  deleteOlderThan(cutoffMs: number): number {
    const result = this.db.prepare(
      'DELETE FROM usage_records WHERE created_at < ?',
    ).run(cutoffMs);
    return result.changes;
  }
}
