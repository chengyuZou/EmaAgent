// 定义逐句语音进入 Turn 事件流时使用的产品事件。
import type { SessionId, TurnId } from '@ema-agent/ids';

export type SpeechEvent =
  | {
      readonly type: 'tts_chunk';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly audio: string;
      readonly sentenceId: string;
      readonly mime: string;
    }
  | {
      readonly type: 'tts_sentence_complete';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly sentenceId: string;
    }
  | {
      readonly type: 'tts_warning';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly code: string;
      readonly severity: 'warn' | 'error';
      readonly message: string;
    };
