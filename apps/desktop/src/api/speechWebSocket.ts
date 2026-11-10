import type {
  SpeechGenerationEvent, CharacterTag,
} from '@ema-agent/speech';
import { serverClient } from './client.js';

export interface SpeechSocketHandlers {
  readonly onControl: (event: SpeechGenerationEvent) => void;
  readonly onClosed: () => void;
}

export interface SpeechSocketHandle {
  /** 只离开状态通知连接, 不停止生成. */
  close(): void;
}

export async function openSpeechSocket(
  audioId: string,
  handlers: SpeechSocketHandlers,
): Promise<SpeechSocketHandle> {
  const url = await serverClient.webSocketUrl(`/api/ws/speech/${encodeURIComponent(audioId)}`);
  const socket = new WebSocket(url);
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    const control = parseSpeechControl(event.data);
    if (control?.audioId === audioId) {
      handlers.onControl(control);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => {
      reject(new Error('语音状态连接失败'));
    }, { once: true });
    socket.addEventListener('close', () => {
      handlers.onClosed();
      // 握手前关闭也要结束等待; 握手已成功时, reject 不会改变已完成的 Promise.
      reject(new Error('语音状态连接已关闭'));
    }, { once: true });
  });
  return {
    close() {
      socket.close(1000, 'speech_subscription_closed');
    },
  };
}

function parseSpeechControl(source: string): SpeechGenerationEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const event = value as SpeechGenerationEvent;
  if (typeof event.audioId !== 'string') return null;
  if (event.type === 'speech_generate_unavailable') return event;
  if (typeof event.sessionId !== 'string' || typeof event.turnId !== 'string' || typeof event.characterName !== 'string') return null;
  switch (event.type) {
    case 'speech_segments':
      return Array.isArray(event.segments) && event.segments.every(segment => (
        segment && Number.isInteger(segment.segmentIndex) && segment.segmentIndex >= 0
        && (segment.textForTTS === null || typeof segment.textForTTS === 'string')
        && Number.isFinite(segment.startMs) && segment.startMs >= 0
        && (segment.endMs === null || (Number.isFinite(segment.endMs) && segment.endMs >= segment.startMs))
        && (segment.tags === null || (Array.isArray(segment.tags) && segment.tags.every((tag: CharacterTag) => (
          tag && ((tag.type === 'emotion' && typeof tag.emotion === 'string')
            || (tag.type === 'motion' && typeof tag.motion === 'string'))
        ))))
      )) ? event : null;
    case 'speech_generate_warning':
      return typeof event.code === 'string' && typeof event.message === 'string' ? event : null;
    case 'speech_generate_completed':
    case 'speech_generate_cancelled':
      return typeof event.audioAvailable === 'boolean' ? event : null;
    case 'speech_generate_failed':
      return typeof event.audioAvailable === 'boolean'
        && typeof event.code === 'string'
        && typeof event.message === 'string'
        ? event
        : null;
    default:
      return null;
  }
}
