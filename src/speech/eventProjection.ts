// 把中立音频字节编码成前端可消费的 Turn 语音事件。
import type { SpeechEvent } from './events.js';

export function audioChunkEvent(
  sessionId: string,
  turnId: string,
  sentenceIndex: number,
  bytes: Uint8Array<ArrayBufferLike>,
  mime: string,
): SpeechEvent {
  return {
    type: 'tts_chunk',
    sessionId,
    turnId,
    sentenceId: makeSentenceId(turnId, sentenceIndex),
    audio: Buffer.from(bytes).toString('base64'),
    mime,
  };
}

export function makeSentenceId(turnId: string, sentenceIndex: number): string {
  return `${turnId as string}-${sentenceIndex}`;
}
