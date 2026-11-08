import { upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { TurnStore } from '@ema-agent/turn';
import type { SpeechComposition, SpeechSocketClient } from '../../composition/speech.js';
export type { SpeechGenerateEvent } from '@ema-agent/speech';

export const speechWebSocketRoute = (
  speech: Pick<SpeechComposition, 'attachSpeechSocket' | 'detachSpeechSocket'>,
  turns: Pick<TurnStore, 'getTurn'>,
) => new Hono().get('/:turnId', upgradeWebSocket(context => {
  const turnId = context.req.param('turnId')!;
  const sessionId = turns.getTurn(turnId)?.sessionId;
  let client: SpeechSocketClient | null = null;
  return {
    onOpen(_event, socket) {
      if (!sessionId) {
        socket.close(1008, 'turn_not_found');
        return;
      }
      client = socketClient(socket);
      try {
        speech.attachSpeechSocket(sessionId, turnId, client);
      } catch {
        socket.close(1011, 'speech_attach_failed');
      }
    },
    onClose() {
      if (client && sessionId) speech.detachSpeechSocket(sessionId, turnId, client);
    },
    onError() {
      if (client && sessionId) speech.detachSpeechSocket(sessionId, turnId, client);
    },
  };
}));

function socketClient(socket: WSContext): SpeechSocketClient {
  return {
    sendControl(event) {
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    },
    close() {
      socket.close(1000, 'speech_generate_ended');
    },
  };
}

