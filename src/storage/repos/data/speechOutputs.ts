// 持久化每个 Turn 最终合并音频，不负责文件系统读写。
import type { SqliteDb } from '../../database/database.js';

export interface SpeechOutputRow {
  turn_id: string;
  session_id: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  duration_ms: number | null;
  segment_count: number;
  created_at: number;
}

export interface SpeechOutputInsert {
  turnId: string;
  sessionId: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  durationMs: number | null;
  segmentCount: number;
  createdAt: number;
}

export class SpeechOutputsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 一个 Turn 只有一份最终合并音频；重新生成时以新文件事实覆盖旧行。 */
  record(output: SpeechOutputInsert): void {
    this.db.prepare(`
      INSERT INTO speech_outputs (
        turn_id, session_id, storage_path, mime_type,
        byte_size, duration_ms, segment_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        storage_path = excluded.storage_path,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        duration_ms = excluded.duration_ms,
        segment_count = excluded.segment_count,
        created_at = excluded.created_at
    `).run(
      output.turnId,
      output.sessionId,
      output.storagePath,
      output.mimeType,
      output.byteSize,
      output.durationMs,
      output.segmentCount,
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
