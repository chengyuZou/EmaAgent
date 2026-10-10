import type {
  SpeechClientCommand,
  SpeechGenerateEvent,
} from '@ema-agent/server/routes/ws/speech.js';
import { serverClient } from './client.js';

export interface SpeechSocketHandlers {
  readonly onControl: (event: SpeechGenerateEvent) => void;
  readonly onClosed: () => void;
}

export interface SpeechSocketHandle {
  /** 明确停止生成, 已写入的音频仍由 Server 保存. */
  cancel(): void;
  /** 只离开状态通知连接, 不停止生成. */
  close(): void;
}

export async function openSpeechSocket(
  sessionId: string,
  turnId: string,
  handlers: SpeechSocketHandlers,
): Promise<SpeechSocketHandle> {
  const url = await serverClient.webSocketUrl(`/api/ws/speech/${encodeURIComponent(turnId)}`);
  const socket = new WebSocket(url);
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    const control = parseSpeechControl(event.data);
    if (control?.sessionId === sessionId && control.turnId === turnId) {
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
    cancel() {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'speech_generate_cancel' } satisfies SpeechClientCommand));
      }
      socket.close(1000, 'speech_generate_cancelled');
    },
    close() {
      socket.close(1000, 'speech_subscription_closed');
    },
  };
}

function parseSpeechControl(source: string): SpeechGenerateEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const event = value as SpeechGenerateEvent;
  if (typeof event.sessionId !== 'string' || typeof event.turnId !== 'string') return null;
  switch (event.type) {
    case 'speech_generate_started':
    case 'speech_generate_unavailable':
      return event;
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
