import type { SpeechControlEvent } from '@ema-agent/server/routes/turns/speech.js';
import { serverClient } from './client.js';

export interface SpeechSocketHandlers {
  readonly onControl: (event: SpeechControlEvent) => void;
  readonly onAudio: (bytes: ArrayBuffer) => void;
  readonly onClosed: () => void;
}

export interface SpeechSocketHandle {
  sentencePlayed(sentenceId: string): void;
  cancel(): void;
}

export async function openSpeechSocket(
  turnId: string,
  handlers: SpeechSocketHandlers,
): Promise<SpeechSocketHandle> {
  const socket = new WebSocket(await serverClient.webSocketUrl(`/api/turns/${turnId}/speech`));
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => {
    if (event.data instanceof ArrayBuffer) {
      handlers.onAudio(event.data);
      return;
    }
    const control = parseControlEvent(String(event.data));
    if (control) handlers.onControl(control);
  });
  socket.addEventListener('close', handlers.onClosed, { once: true });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Speech WebSocket connection failed')), { once: true });
  });

  return {
    sentencePlayed(sentenceId) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'sentence_played', sentenceId }));
      }
    },
    cancel() {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel' }));
      socket.close(1000, 'speech_cancelled');
    },
  };
}

function parseControlEvent(source: string): SpeechControlEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || !('type' in value)) return null;
  const event = value as SpeechControlEvent;
  switch (event.type) {
    case 'sentence_started':
      return typeof event.sentenceId === 'string' && typeof event.mime === 'string' ? event : null;
    case 'sentence_completed':
      return typeof event.sentenceId === 'string' ? event : null;
    case 'sentence_failed':
      return typeof event.sentenceId === 'string'
        && typeof event.code === 'string'
        && typeof event.message === 'string' ? event : null;
    case 'speech_completed':
      return typeof event.audioAvailable === 'boolean' ? event : null;
    case 'speech_cancelled':
      return event;
    default:
      return null;
  }
}
