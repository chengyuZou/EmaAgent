export type SpeechGenerateEvent = {
  readonly sessionId: string;
  readonly turnId: string;
} & (
  | { readonly type: 'speech_generate_started' }
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
  | { readonly type: 'speech_generate_unavailable' }
);

/** 连接地址已经绑定 turnId; 命令只明确取消生成, 不报告播放进度. */
export interface SpeechClientCommand {
  readonly type: 'speech_generate_cancel';
}

/** 正式文件与 speech_outputs 记录均已保存, Chat 和 Storage 据此刷新音频状态. */
export interface SpeechArchiveEvent {
  readonly type: 'session_audio_changed';
  readonly sessionId: string;
  readonly turnId: string;
}
