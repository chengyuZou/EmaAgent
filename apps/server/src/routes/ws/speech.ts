import { upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { SpeechComposition, SpeechSocketClient } from '../../composition/speech.js';

export const speechWebSocketRoute = (
  speech: Pick<SpeechComposition, 'attachSpeechSocket' | 'detachSpeechSocket'>,
) => new Hono().get('/:audioId', upgradeWebSocket(context => {
  const audioId = context.req.param('audioId')!;
  let client: SpeechSocketClient | null = null;
  return {
    onOpen(_event, socket) {
      client = socketClient(socket);
      try {
        speech.attachSpeechSocket(audioId, client);
      } catch {
        socket.close(1011, 'speech_attach_failed');
      }
    },
    onClose() {
      if (client) speech.detachSpeechSocket(audioId, client);
    },
    onError() {
      if (client) speech.detachSpeechSocket(audioId, client);
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

