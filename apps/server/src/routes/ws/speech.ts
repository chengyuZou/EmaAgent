import { upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { SpeechClientCommand } from '@ema-agent/speech';
import type { TurnStore } from '@ema-agent/turn';
import type { SpeechComposition, SpeechSocketClient } from '../../composition/speech.js';
export type { SpeechClientCommand, SpeechGenerateEvent } from '@ema-agent/speech';

export const speechWebSocketRoute = (
  speech: Pick<SpeechComposition, 'attachSpeechSocket' | 'detachSpeechSocket' | 'cancelTurnSpeech'>,
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
      void speech.attachSpeechSocket(sessionId, turnId, client).catch(() => {
        socket.close(1011, 'speech_attach_failed');
      });
    },
    onMessage(event, socket) {
      if (!client || !sessionId || typeof event.data !== 'string') return;
      const command = parseClientCommand(event.data);
      if (command) {
        void speech.cancelTurnSpeech(turnId).catch(() => {
          socket.close(1011, 'speech_cancel_failed');
        });
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

function parseClientCommand(source: string): SpeechClientCommand | null {
  try {
    const value = JSON.parse(source) as { type?: unknown } | null;
    return value?.type === 'speech_generate_cancel' ? { type: value.type } : null;
  } catch {
    return null;
  }
}
