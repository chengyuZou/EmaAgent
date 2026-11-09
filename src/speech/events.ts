import type { AudioSegment, AudioStatus, SpeechAudioIdentity } from './types.js';

/** 终态的 audioAvailable 只表示同一 audioId 是否已 ready, 不表示前端已经播完. */
export type SpeechGenerationEvent =
  | {
      readonly type: 'speech_generate_unavailable';
      readonly audioId: string;
    }
  | (SpeechAudioIdentity & (
      | { readonly type: 'speech_segments'; readonly segments: readonly AudioSegment[] }
      | {
          readonly type: 'speech_generate_warning';
          readonly code: string;
          readonly message: string;
        }
      | {
          readonly type: 'speech_generate_completed' | 'speech_generate_cancelled';
          readonly audioAvailable: boolean;
        }
      | {
          readonly type: 'speech_generate_failed';
          readonly audioAvailable: boolean;
          readonly code: string;
          readonly message: string;
        }
    ));

/** SQL 变更成功后发送. deleted 表示记录已删除, 不作为 SQL 中的状态保存. */
export interface AudioRecordEvent extends SpeechAudioIdentity {
  readonly type: 'session_audio_changed';
  readonly audioStatus: AudioStatus | 'deleted';
}

/** 等待生成结束时只返回这三种事件, 不会把字幕或警告当作完成. */
export type SpeechGenerationResult = Extract<SpeechGenerationEvent, {
  type: 'speech_generate_completed' | 'speech_generate_cancelled' | 'speech_generate_failed';
}>;

export type SpeechEvent = SpeechGenerationEvent | AudioRecordEvent;
