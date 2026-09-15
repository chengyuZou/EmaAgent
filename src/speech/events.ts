export type SpeechControlEvent =
  | { readonly type: 'sentence_started'; readonly sentenceId: string; readonly mime: string }
  | { readonly type: 'sentence_completed'; readonly sentenceId: string }
  | { readonly type: 'sentence_failed'; readonly sentenceId: string; readonly code: string; readonly message: string }
  | { readonly type: 'speech_completed'; readonly audioAvailable: boolean }
  | { readonly type: 'speech_cancelled' };

/** 音频块只走 WebSocket 二进制帧；其余事件序列化成 JSON 控制帧。 */
export type SpeechStreamEvent =
  | SpeechControlEvent
  | { readonly type: 'audio_chunk'; readonly bytes: Uint8Array };

export type SpeechArchiveEvent = {
  readonly type: 'session_audio_changed';
  readonly sessionId: string;
};
