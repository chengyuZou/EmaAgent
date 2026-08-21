// 持久化逐句音频片段与每个 Turn 最终合并音频，不负责文件系统读写。
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

export interface SpeechSegmentRow {
  id: string;
  turn_id: string;
  session_id: string;
  sentence_index: number;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  duration_ms: number | null;
  text: string;
  created_at: number;
}

export interface SpeechSegmentInsert {
  id: string;
  turnId: string;
  sessionId: string;
  sentenceIndex: number;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  durationMs: number | null;
  text: string;
  createdAt: number;
}

export interface SpeechSegmentUsage {
  fileCount: number;
  totalBytes: number;
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

export class SpeechSegmentsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 句子重试会覆盖同一 turn + sentenceIndex，避免留下两份逻辑相同的片段。 */
  record(segment: SpeechSegmentInsert): void {
    this.db.prepare(`
      INSERT INTO speech_segments (
        id, turn_id, session_id, sentence_index, storage_path,
        mime_type, byte_size, duration_ms, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id, sentence_index) DO UPDATE SET
        id = excluded.id,
        storage_path = excluded.storage_path,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        duration_ms = excluded.duration_ms,
        text = excluded.text,
        created_at = excluded.created_at
    `).run(
      segment.id,
      segment.turnId,
      segment.sessionId,
      segment.sentenceIndex,
      segment.storagePath,
      segment.mimeType,
      segment.byteSize,
      segment.durationMs,
      segment.text,
      segment.createdAt,
    );
  }

  usage(): SpeechSegmentUsage {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS file_count, COALESCE(SUM(byte_size), 0) AS total_bytes
      FROM speech_segments
    `).get() as { file_count: number; total_bytes: number };
    return { fileCount: row.file_count, totalBytes: row.total_bytes };
  }

  listOldest(limit: number): SpeechSegmentRow[] {
    return this.db.prepare(`
      SELECT *
      FROM speech_segments
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(limit) as SpeechSegmentRow[];
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM speech_segments WHERE id = ?').run(id);
  }

  deleteTurn(turnId: string): void {
    this.db.prepare('DELETE FROM speech_segments WHERE turn_id = ?').run(turnId);
  }
}
