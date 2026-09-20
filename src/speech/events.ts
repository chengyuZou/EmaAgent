export type SpeechControlEvent =
  | { readonly type: 'sentence_started'; readonly sentenceId: string; readonly mime: string }
  | { readonly type: 'sentence_completed'; readonly sentenceId: string }
  | { readonly type: 'sentence_failed'; readonly sentenceId: string; readonly code: string; readonly message: string }
  | { readonly type: 'speech_completed'; readonly audioAvailable: boolean }
  | { readonly type: 'speech_cancelled' };

/** 音频块只走 WebSocket 二进制帧; 其余事件序列化成 JSON 控制帧. */
export type SpeechStreamEvent =
  | SpeechControlEvent
  | { readonly type: 'audio_chunk'; readonly bytes: Uint8Array };

/**
 * 一轮语音的合并音频和 speech_outputs 记录已经写入成功.
 * Chat 用它刷新该 Turn 的播放按钮, Storage 用它刷新音频占用;
 * 它不表示用户开始, 暂停或重播音频.
 */
export type SpeechArchiveEvent = {
  readonly type: 'session_audio_changed';
  readonly sessionId: string;
  /** 合并音频和 speech_outputs 记录都写入成功后发送; Chat 据此只刷新这一轮的音频状态. */
  readonly turnId: string;
};
