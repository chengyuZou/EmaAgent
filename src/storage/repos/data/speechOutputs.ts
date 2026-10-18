import type { SqliteDb } from '../../database/database.js';
import type { TurnStatusRow } from './turns.js';

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

  /** 每个路径对应一份角色音频; 同路径重新生成时替换记录, 不覆盖该轮的其他角色版本. */
  record(output: SpeechOutputInsert): void {
    this.db.prepare(`
      INSERT INTO speech_outputs (
        turn_id, session_id, storage_path, mime_type,
        byte_size, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(storage_path) DO UPDATE SET
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

  listForTurn(turnId: string): SpeechOutputRow[] {
    return this.db.prepare(`
      SELECT * FROM speech_outputs
      WHERE turn_id = ?
      ORDER BY storage_path ASC
    `).all(turnId) as SpeechOutputRow[];
  }

  /** 以 Turn 创建时间分页, 重新生成音频不会改变分页位置, 没有音频的轮次也保留. */
  listPage(sessionId: string, cursor: { createdAt: number; id: string } | undefined, limit: number) {
    const rows = this.db.prepare(`
      SELECT t.id AS turn_id, t.created_at, t.status,
        COUNT(s.storage_path) AS audio_count,
        COALESCE(SUM(s.byte_size), 0) AS total_byte_size,
        COALESCE(SUM(s.duration_ms), 0) AS total_duration_ms
      FROM turns t
      LEFT JOIN speech_outputs s ON s.turn_id = t.id
      WHERE t.session_id = ?
        AND (? IS NULL OR t.created_at < ? OR (t.created_at = ? AND t.id < ?))
      GROUP BY t.id
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?
    `).all(
      sessionId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
      cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1,
    ) as Array<{
      turn_id: string;
      created_at: number;
      status: TurnStatusRow;
      audio_count: number;
      total_byte_size: number;
      total_duration_ms: number;
    }>;
    const items = rows.slice(0, limit).map(row => ({
      turnId: row.turn_id,
      status: row.status,
      audioCount: row.audio_count,
      totalByteSize: row.total_byte_size,
      totalDurationMs: row.total_duration_ms,
      createdAt: row.created_at,
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.turnId } : null,
    };
  }
}
