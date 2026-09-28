import {
  UsageRecordsRepo,
  type Database,
  type UsageRecordRow,
  type UsageRecordListFilter,
  type UsageRecordPageCursor,
} from '@ema-agent/storage';
import type { UsageRecord } from './types.js';

export class UsageRecorder {
  private readonly repo: UsageRecordsRepo;

  constructor(db: Database) {
    this.repo = new UsageRecordsRepo(db.sqlite);
  }

  record(record: UsageRecord): void {
    const row: UsageRecordRow = {
      id: record.id,
      session_id: record.sessionId,
      turn_id: record.turnId,
      provider_id: record.providerId,
      model_id: record.modelId,
      capability: record.capability,
      status: record.status,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      cache_read_input_tokens: record.cacheReadInputTokens,
      cache_write_input_tokens: record.cacheWriteInputTokens,
      quantity: record.quantity,
      unit: record.unit,
      duration_ms: record.durationMs,
      error_code: record.errorCode,
      created_at: record.createdAt,
    };
    try {
      this.repo.record(row);
    } catch (error) {
      console.warn('[usage] Record write failed:', error);
      return;
    }
  }

  list(filter: UsageRecordListFilter): {
    items: UsageRecord[];
    nextCursor: UsageRecordPageCursor | null;
  } {
    const page = this.repo.list(filter);
    return {
      items: page.items.map(row => this.fromRow(row)),
      nextCursor: page.nextCursor,
    };
  }

  forTurn(turnId: string): UsageRecord[] {
    return this.repo.forTurn(turnId).map(row => this.fromRow(row));
  }

  private fromRow(row: UsageRecordRow): UsageRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      capability: row.capability,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      cacheWriteInputTokens: row.cache_write_input_tokens,
      quantity: row.quantity,
      unit: row.unit,
      durationMs: row.duration_ms,
      errorCode: row.error_code,
      createdAt: row.created_at,
    };
  }
}
