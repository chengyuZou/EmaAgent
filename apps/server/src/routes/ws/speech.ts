// Speech WebSocket Route：转发单个 Turn 的控制帧和二进制音频。
import { upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { SpeechComposition, SpeechSocketClient } from '../../composition/speech.js';
export type { SpeechControlEvent } from '@ema-agent/speech';

export const speechWebSocketRoute = (speech: Pick<
  SpeechComposition,
  'attachSpeechSocket' | 'handleSpeechSocketMessage' | 'detachSpeechSocket'
>) => new Hono().get('/:turnId', upgradeWebSocket(context => {
  const turnId = context.req.param('turnId')!;
  let client: SpeechSocketClient | null = null;
  return {
    onOpen(_event, socket) {
      client = socketClient(socket);
      if (!speech.attachSpeechSocket(turnId, client)) socket.close(1008, 'speech_not_available');
    },
    onMessage(event, socket) {
      if (typeof event.data !== 'string' || !client) return;
      if (speech.handleSpeechSocketMessage(turnId, event.data)) {
        speech.detachSpeechSocket(turnId, client);
        socket.close(1000, 'speech_cancelled');
      }
    },
    onClose() { if (client) speech.detachSpeechSocket(turnId, client); },
    onError() { if (client) speech.detachSpeechSocket(turnId, client); },
  };
}));

function socketClient(socket: WSContext): SpeechSocketClient {
  return {
    sendControl(event) { socket.send(JSON.stringify(event)); },
    sendAudio(bytes) { socket.send(Uint8Array.from(bytes)); },
    close() { socket.close(1000, 'speech_completed'); },
  };
}
