import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import type { SpeechGenerationEvent } from '@ema-agent/speech';
import type { SpeechSocketClient } from '../src/composition/speech.js';
import { speechWebSocketRoute } from '../src/routes/ws/speech.js';

let server: Server | null = null;
let sockets: WebSocketServer | null = null;

afterEach(async () => {
  for (const socket of sockets?.clients ?? []) socket.terminate();
  sockets?.close();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  sockets = null;
});

it('同一轮两条 AudioID 各有自己的语音连接, 关闭一条不会关掉另一条', async () => {
  const clients = new Map<string, SpeechSocketClient>();
  const app = new Hono().route('/api/ws/speech', speechWebSocketRoute({
    attachSpeechSocket(audioId, client) {
      clients.set(audioId, client);
      client.sendControl({
        type: 'speech_segments', audioId, sessionId: 'session', turnId: 'same-turn',
        characterName: audioId === 'ema' ? '艾玛' : '希罗', segments: [],
      });
    },
    detachSpeechSocket(audioId, client) {
      if (clients.get(audioId) === client) clients.delete(audioId);
    },
  }));
  sockets = new WebSocketServer({ noServer: true });
  server = serve({
    fetch: app.fetch, hostname: '127.0.0.1', port: 0, websocket: { server: sockets },
  }) as Server;
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const connect = async (audioId: string) => {
    const socket = new WebSocket('ws://127.0.0.1:' + address.port + '/api/ws/speech/' + audioId);
    const first = await new Promise<SpeechGenerationEvent>((resolve, reject) => {
      socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return { socket, first };
  };
  const ema = await connect('ema');
  const hiro = await connect('hiro');
  expect(ema.first.audioId).toBe('ema');
  expect(hiro.first.audioId).toBe('hiro');
  const closed = new Promise<void>(resolve => ema.socket.addEventListener('close', () => resolve(), { once: true }));
  clients.get('ema')!.close();
  await closed;
  expect(hiro.socket.readyState).toBe(WebSocket.OPEN);
  expect(clients.has('hiro')).toBe(true);
});
