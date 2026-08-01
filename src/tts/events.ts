// 定义合成音频进入 Turn 流时使用的 TTS 业务事件。
import type { SessionId, TurnId } from '@ema-agent/ids';

export type TtsEvent =
  | { type: 'tts_chunk'; sessionId: SessionId; turnId: TurnId; audio: string; sentenceId: string }
  | { type: 'tts_sentence_complete'; sessionId: SessionId; turnId: TurnId; sentenceId: string }
  | {
      type: 'tts_warning';
      sessionId: SessionId;
      turnId: TurnId;
      code: string;
      severity: 'warn' | 'error';
      message: string;
    };
