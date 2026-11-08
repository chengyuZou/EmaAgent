import type { AudioSegment, AudioStatus, SpeechAudioIdentity } from './types.js';

/** 终态的 audioAvailable 只表示同一 audioId 是否已 ready, 不表示前端已经播完. */
export type SpeechGenerationEvent = SpeechAudioIdentity & (
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
);

export type SpeechGenerateEvent = SpeechGenerationEvent | {
  readonly type: 'speech_generate_unavailable';
  readonly sessionId: string;
  readonly turnId: string;
};

/** SQL 变更成功后发送. deleted 表示记录已删除, 不作为 SQL 中的状态保存. */
export interface AudioRecordEvent extends SpeechAudioIdentity {
  readonly type: 'session_audio_changed';
  readonly audioStatus: AudioStatus | 'deleted';
}

/** 一次生成的结果; audioAvailable 只对应本次 audioId, 其他已保存音频另从目录选择. */
export type SpeechGenerationResult = SpeechAudioIdentity & (
  | { readonly status: 'completed'; readonly audioAvailable: boolean }
  | { readonly status: 'cancelled'; readonly audioAvailable: boolean }
  | {
      readonly status: 'failed';
      readonly audioAvailable: boolean;
      readonly code: string;
      readonly message: string;
    }
);

export type SpeechEvent = SpeechGenerationEvent | AudioRecordEvent;
