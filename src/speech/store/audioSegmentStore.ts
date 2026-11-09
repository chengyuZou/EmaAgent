import { SpeechSegmentsRepo, type Database } from '@ema-agent/storage';
import type { AudioSegment, SavedAudioSegment, CharacterTag } from '../types.js';

export class AudioSegmentStore {
  /** 生成中的段按 audioId 分开保存. 音频保存或丢弃后移除, 历史读取改查数据库. */
  private readonly generatingSegmentsByAudioId = new Map<string, AudioSegment[]>();

  private readonly segmentStorage: SpeechSegmentsRepo;

  constructor(database: Database) {
    this.segmentStorage = new SpeechSegmentsRepo(database.sqlite);
  }

  /** AudioStore.saveCompletedAudio 的事务中调用, 段表必须与 ready 状态一起提交. */
  saveSegments(audioId: string, segments: readonly SavedAudioSegment[]): void {
    this.segmentStorage.insertForAudio(audioId, segments);
  }

  beginGeneration(audioId: string): void {
    this.generatingSegmentsByAudioId.set(audioId, []);
  }

  /**
   * 有正文时在第一块 PCM 写入后登记, startMs 是这块写入前的位置.
   * textForTTS 为 null 时仅交付流中的标签, 不创建音频样本, 结束位置等于开始位置.
   */
  beginSegment(
    audioId: string,
    textForTTS: string | null,
    startMs: number,
    tags: readonly CharacterTag[] | null = null,
  ): AudioSegment {
    const segments = this.generatingSegmentsByAudioId.get(audioId)!;
    const segment: AudioSegment = {
      segmentIndex: segments.length, textForTTS, startMs,
      endMs: textForTTS === null ? startMs : null, tags,
    };
    segments.push(segment);
    return segment;
  }

  finishSegment(audioId: string, segmentIndex: number, endMs: number): AudioSegment {
    const segments = this.generatingSegmentsByAudioId.get(audioId)!;
    const segment: AudioSegment = { ...segments[segmentIndex]!, endMs };
    segments[segmentIndex] = segment;
    return segment;
  }

  getSegments(audioId: string): readonly AudioSegment[] {
    const generating = this.generatingSegmentsByAudioId.get(audioId);
    if (generating) return generating;
    return this.segmentStorage.listForAudio(audioId).map(segment => ({
      segmentIndex: segment.segment_index,
      textForTTS: segment.text_for_tts,
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      tags: null,
    }));
  }

  /** 生成器先结束当前段, 再取得同一事务要保存的所有段. */
  getCompletedSegments(audioId: string): readonly SavedAudioSegment[] {
    // 标签项没有 PCM, 不保存为字幕. 保存时重新连续编号, 重播只读取声音和字幕.
    const completedSegments: SavedAudioSegment[] = [];
    for (const segment of this.getSegments(audioId)) {
      if (segment.textForTTS === null) continue;
      if (segment.endMs === null) throw new Error('Cannot save an unfinished audio segment');
      completedSegments.push({
        segmentIndex: completedSegments.length, textForTTS: segment.textForTTS,
        startMs: segment.startMs, endMs: segment.endMs,
      });
    }
    return completedSegments;
  }

  releaseGeneration(audioId: string): void {
    this.generatingSegmentsByAudioId.delete(audioId);
  }
}
