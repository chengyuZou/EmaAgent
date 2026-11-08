import type { SqliteDb } from '../../database/database.js';

export interface SpeechSegmentRow {
  audio_id: string;
  segment_index: number;
  text_for_tts: string;
  start_ms: number;
  end_ms: number;
}

export interface SpeechSegmentInsert {
  segmentIndex: number;
  /** 实际提交给 TTS 的文本. 请求中断时, 对应音频可能只包含这段文本的前半部分. */
  textForTTS: string;
  /** PCM 音频时间轴中的毫秒位置, 不包含模型请求或网络等待时间. */
  startMs: number;
  endMs: number;
}

export class SpeechSegmentsRepo {
  constructor(private readonly database: SqliteDb) {}

  listForAudio(audioId: string): SpeechSegmentRow[] {
    return this.database.prepare('SELECT * FROM speech_output_segments WHERE audio_id = ? ORDER BY segment_index')
      .all(audioId) as SpeechSegmentRow[];
  }

  /** AudioStore.saveCompletedAudio 或 SessionBackupRestorer.restoreSession 的事务中调用, 本方法不另开事务. */
  insertForAudio(audioId: string, segments: readonly SpeechSegmentInsert[]): void {
    const insertSegment = this.database.prepare(`
      INSERT INTO speech_output_segments (audio_id, segment_index, text_for_tts, start_ms, end_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const segment of segments) {
      insertSegment.run(audioId, segment.segmentIndex, segment.textForTTS, segment.startMs, segment.endMs);
    }
  }
}
