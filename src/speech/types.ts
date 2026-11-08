import type { SpeechSegmentInsert, AudioStatus } from '@ema-agent/storage';
export type { AudioStatus } from '@ema-agent/storage';

export interface SpeechAudioIdentity {
  readonly audioId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly characterName: string;
}

export interface AudioSegment extends Omit<SpeechSegmentInsert, 'endMs'> {
  /** 当前句尚未结束时为 null, 保存段表前必须确定 PCM 结束位置. */
  readonly endMs: number | null;
}

export type SavedAudioSegment = SpeechSegmentInsert;

/** WAV 已关闭并完成改名, 不表示数据库已经允许手动播放. */
export interface CompletedAudioFile extends SpeechAudioIdentity {
  readonly storagePath: string;
  readonly mimeType: 'audio/wav';
  readonly fileSizeBytes: number;
  readonly durationMs: number;
}

export interface AudioSummary {
  readonly audioId: string;
  readonly characterName: string;
  readonly audioStatus: AudioStatus;
  readonly createdAtMs: number;
  /** 尚未保存完成信息时为 null, 前端显示未完成, 不把它显示为 0 ms. */
  readonly durationMs: number | null;
  /** 包含 WAV 头的完整文件大小. 完成信息未入库时为 null, 不代表磁盘上没有文件. */
  readonly fileSizeBytes: number | null;
  readonly failureMessage: string | null;
}

export interface AudioRecord extends SpeechAudioIdentity, AudioSummary {
  readonly storagePath: string;
  readonly mimeType: 'audio/wav';
}

export interface AudioPlayback extends SpeechAudioIdentity {
  readonly segments: readonly AudioSegment[];
}
