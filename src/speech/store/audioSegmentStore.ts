import { SpeechSegmentsRepo, type Database } from '@ema-agent/storage';
import type { AudioSegment, SavedAudioSegment } from '../types.js';

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

  /** 第一块 PCM 写入成功后才建段, startMs 使用这一块写入前的音频位置. */
  beginSegment(audioId: string, textForTTS: string, startMs: number): AudioSegment {
    const segments = this.generatingSegmentsByAudioId.get(audioId)!;
    const segment: AudioSegment = { segmentIndex: segments.length, textForTTS, startMs, endMs: null };
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
    }));
  }

  /** 生成器先结束当前段, 再取得同一事务要保存的所有段. */
  getCompletedSegments(audioId: string): readonly SavedAudioSegment[] {
    return this.getSegments(audioId).map(segment => {
      if (segment.endMs === null) throw new Error('Cannot save an unfinished audio segment');
      return { ...segment, endMs: segment.endMs };
    });
  }

  releaseGeneration(audioId: string): void {
    this.generatingSegmentsByAudioId.delete(audioId);
  }
}
