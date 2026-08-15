// 定义逐句语音进入 Turn 事件流时使用的产品事件。
export type SpeechEvent =
  | {
      readonly type: 'tts_chunk';
      readonly sessionId: string;
      readonly turnId: string;
      readonly audio: string;
      readonly sentenceId: string;
      readonly mime: string;
    }
  | {
      readonly type: 'tts_sentence_complete';
      readonly sessionId: string;
      readonly turnId: string;
      readonly sentenceId: string;
    }
  | {
      readonly type: 'tts_warning';
      readonly sessionId: string;
      readonly turnId: string;
      readonly code: string;
      readonly severity: 'warn' | 'error';
      readonly message: string;
    };
