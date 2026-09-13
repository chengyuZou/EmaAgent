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

/** keyset 游标:created_at 主序,id 同刻决胜(与 messages 分页同款,新数据插入不位移)。 */
export interface UsageRecordPageCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface UsageRecordPage {
  readonly items: readonly UsageRecordRow[];
  readonly nextCursor: UsageRecordPageCursor | null;
}

export interface UsageRecordListFilter {
  readonly sessionId?: string;
  readonly capability?: UsageRecord['capability'];
  readonly cursor?: UsageRecordPageCursor;
  readonly limit?: number;
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

  /**
   * 库级明细查询:参数在才过滤(sessionId/capability 可空),
   * created_at DESC 倒序 + keyset 游标向回翻。供存储库浏览与未来的用量统计页共用。
   */
  list(filter: UsageRecordListFilter): UsageRecordPage {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.capability) {
      conditions.push('capability = ?');
      params.push(filter.capability);
    }
    if (filter.cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(filter.cursor.createdAt, filter.cursor.createdAt, filter.cursor.id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM usage_records
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit + 1) as UsageRecordRow[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
    };
  }

  /** 删除早于 cutoffMs 的记录，返回删除行数；由启动一次性保留清理调用。 */
  deleteOlderThan(cutoffMs: number): number {
    const result = this.db.prepare(
      'DELETE FROM usage_records WHERE created_at < ?',
    ).run(cutoffMs);
    return result.changes;
  }
}
