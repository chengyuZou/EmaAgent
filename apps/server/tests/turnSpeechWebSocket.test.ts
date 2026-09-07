// 验证真实 Node WebSocket 握手后的 Speech 控制帧、二进制帧和客户端确认。
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { emaAuth } from '../src/platform/auth.js';
import { turnSpeechRoute } from '../src/routes/turns/speech.js';

const SECRET = 's'.repeat(32);
let server: Server | null = null;
let webSocketServer: WebSocketServer | null = null;

afterEach(async () => {
  for (const socket of webSocketServer?.clients ?? []) socket.terminate();
  webSocketServer?.close();
  webSocketServer = null;
  if (!server) return;
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

describe('Turn Speech WebSocket', () => {
  it('在认证握手后按顺序发送控制帧与二进制音频帧', async () => {
    const app = new Hono();
    let receiveClientMessage!: (message: string) => void;
    const clientMessage = new Promise<string>(resolve => {
      receiveClientMessage = resolve;
    });
    app.use('*', emaAuth(SECRET));
    app.route('/api/turns', turnSpeechRoute({
      speech: {
        attachSpeechSocket(_turnId, client) {
          client.sendControl({ type: 'sentence_started', sentenceId: 'turn-0', mime: 'audio/mpeg' });
          client.sendAudio(new Uint8Array([1, 2, 3]));
          return true;
        },
        handleSpeechSocketMessage(_turnId, message) {
          receiveClientMessage(message);
          return false;
        },
        detachSpeechSocket() {},
      },
    }));

    webSocketServer = new WebSocketServer({ noServer: true });
    server = serve({
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: 0,
      websocket: { server: webSocketServer },
    }) as Server;
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/turns/turn/speech?secret=${SECRET}`);
    socket.binaryType = 'arraybuffer';
    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', event => {
        received.push(event.data);
        if (received.length === 2) resolve();
      });
      socket.addEventListener('error', () => reject(new Error('WebSocket test connection failed')));
    });
    socket.send(JSON.stringify({ type: 'sentence_played', sentenceId: 'turn-0' }));

    expect(JSON.parse(String(received[0]))).toEqual({
      type: 'sentence_started',
      sentenceId: 'turn-0',
      mime: 'audio/mpeg',
    });
    expect([...new Uint8Array(received[1] as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(JSON.parse(await clientMessage)).toEqual({
      type: 'sentence_played',
      sentenceId: 'turn-0',
    });
    socket.close();
  });
});
