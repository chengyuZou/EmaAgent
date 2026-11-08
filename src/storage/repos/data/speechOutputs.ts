import type { SqliteDb } from '../../database/database.js';
import type { TurnStatusRow } from './turns.js';

export type AudioStatus = 'generating' | 'ready' | 'deleting' | 'failed';

export interface SpeechOutputRow {
  audio_id: string;
  character_name: string;
  turn_id: string;
  session_id: string;
  storage_path: string;
  mime_type: 'audio/wav';
  /** 持久化的音频生命周期, 前端据此决定是否可播, 启动时据此处理上次未收尾的记录. */
  audio_status: AudioStatus;
  /** Data 显示的失败原因; null 表示当前没有已保存的失败原因. */
  failure_message: string | null;
  /** 完整 WAV 的字节数, 包含文件头. 先登记时为 null, 完成信息入库前失败也可保持 null. */
  byte_size: number | null;
  /** 最终 PCM 的毫秒时长. 尚未取得或保存完成信息时为 null, 不使用 0 代替; ready 要求非 null. */
  duration_ms: number | null;
  created_at: number;
}

export interface SpeechOutputInsert {
  audioId: string;
  characterName: string;
  turnId: string;
  sessionId: string;
  storagePath: string;
  mimeType: 'audio/wav';
  audioStatus: AudioStatus;
  failureMessage: string | null;
  /** 创建 generating 记录时传 null; 导入已完成的 WAV 时传真实字节数. */
  byteSize: number | null;
  /** 未完成的音频传 null, 已完成的音频传 PCM 时长, 不包含模型和网络等待. */
  durationMs: number | null;
  createdAt: number;
}

export class SpeechOutputsRepo {
  constructor(private readonly db: SqliteDb) {}

  insertAudio(output: SpeechOutputInsert): void {
    this.db.prepare(`
      INSERT INTO speech_outputs (
        turn_id, session_id, storage_path, mime_type,
        byte_size, duration_ms, created_at, audio_id, character_name,
        audio_status, failure_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      output.turnId,
      output.sessionId,
      output.storagePath,
      output.mimeType,
      output.byteSize,
      output.durationMs,
      output.createdAt,
      output.audioId,
      output.characterName,
      output.audioStatus,
      output.failureMessage,
    );
  }

  findByAudioId(audioId: string): SpeechOutputRow | undefined {
    return this.db.prepare('SELECT * FROM speech_outputs WHERE audio_id = ?').get(audioId) as SpeechOutputRow | undefined;
  }

  findLatestReadyForCharacter(turnId: string, characterName: string): SpeechOutputRow | undefined {
    return this.db.prepare(`SELECT * FROM speech_outputs
      WHERE turn_id = ? AND character_name = ? AND audio_status = 'ready'
      ORDER BY created_at DESC, audio_id DESC LIMIT 1`)
      .get(turnId, characterName) as SpeechOutputRow | undefined;
  }

  listForSession(sessionId: string): SpeechOutputRow[] {
    return this.db.prepare(`
      SELECT *
      FROM speech_outputs
      WHERE session_id = ?
      ORDER BY created_at ASC, turn_id ASC
    `).all(sessionId) as SpeechOutputRow[];
  }

  completeAudio(audioId: string, byteSize: number, durationMs: number): void {
    const completion = this.db.prepare(`UPDATE speech_outputs
      SET audio_status = 'ready', byte_size = ?, duration_ms = ?, failure_message = NULL
      WHERE audio_id = ? AND audio_status = 'generating'`).run(byteSize, durationMs, audioId);
    if (completion.changes !== 1) throw new Error('Audio is no longer generating');
  }

  updateAudioStatus(audioId: string, audioStatus: AudioStatus, failureMessage: string | null): boolean {
    return this.db.prepare('UPDATE speech_outputs SET audio_status = ?, failure_message = ? WHERE audio_id = ?')
      .run(audioStatus, failureMessage, audioId).changes === 1;
  }

  deleteAudio(audioId: string): void {
    this.db.prepare('DELETE FROM speech_outputs WHERE audio_id = ?').run(audioId);
  }

  listAudioSummaries(turnId: string, characterName?: string) {
    return this.db.prepare(`SELECT audio_id, character_name, audio_status,
      created_at, byte_size, duration_ms, failure_message FROM speech_outputs
      WHERE turn_id = ? AND (? IS NULL OR character_name = ?)
      ORDER BY created_at DESC, audio_id DESC`)
      .all(turnId, characterName ?? null, characterName ?? null) as Array<Pick<SpeechOutputRow,
        'audio_id' | 'character_name' | 'audio_status' | 'created_at' | 'byte_size' | 'duration_ms' | 'failure_message'>>;
  }

  markInterruptedAudioRecordsFailed(): SpeechOutputRow[] {
    return this.db.prepare(`UPDATE speech_outputs SET
      failure_message = CASE audio_status WHEN 'generating' THEN '上次生成因程序退出而中断'
        ELSE '上次删除因程序退出而中断' END,
      audio_status = 'failed'
      WHERE audio_status IN ('generating', 'deleting') RETURNING *`).all() as SpeechOutputRow[];
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
