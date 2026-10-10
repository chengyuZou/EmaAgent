// 保存已完成写入的整轮 WAV, 取消后保留的音频也使用同一份记录.
import type { SqliteDb } from '../../database/database.js';

export interface SpeechOutputRow {
  turn_id: string;
  session_id: string;
  storage_path: string;
  mime_type: 'audio/wav';
  byte_size: number;
  duration_ms: number;
  created_at: number;
}

export interface SpeechOutputInsert {
  turnId: string;
  sessionId: string;
  storagePath: string;
  mimeType: 'audio/wav';
  byteSize: number;
  durationMs: number;
  createdAt: number;
}

export class SpeechOutputsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 每个 Turn 对应一份正式音频文件. */
  record(output: SpeechOutputInsert): void {
    this.db.prepare(`
      INSERT INTO speech_outputs (
        turn_id, session_id, storage_path, mime_type,
        byte_size, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        storage_path = excluded.storage_path,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        duration_ms = excluded.duration_ms,
        created_at = excluded.created_at
    `).run(
      output.turnId,
      output.sessionId,
      output.storagePath,
      output.mimeType,
      output.byteSize,
      output.durationMs,
      output.createdAt,
    );
  }

  listForSession(sessionId: string): SpeechOutputRow[] {
    return this.db.prepare(`
      SELECT *
      FROM speech_outputs
      WHERE session_id = ?
      ORDER BY created_at ASC, turn_id ASC
    `).all(sessionId) as SpeechOutputRow[];
  }
}
