// 验证 Session WebSocket 打开后的首条业务消息包含同一连接边界下的运行身份和已保存 Message.

import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { SessionRunningRegistry, type Message } from '@ema-agent/session';
import type {
  SessionContinuationQueue,
  SessionInteractionQueue,
  Turn,
  TurnExecutor,
} from '@ema-agent/turn';
import type { AgentRunExecutor } from '@ema-agent/agent';
import {
  SessionSocketConnections,
  sessionWebSocketRoute,
  type SessionServerMessage,
  type SessionWebSocketRouteDeps,
} from '../src/routes/ws/session.js';

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

describe('Session WebSocket Route', () => {
  it('每次连接先发送一条 session_state, 运行 Turn 携带冻结设置和已保存 Message', async () => {
    const sessionId = 'session-1';
    const turnId = 'turn-1';
    const registry = new SessionRunningRegistry();
    registry.register(sessionId, { kind: 'turn', turnId });
    const persisted: Message = {
      id: 'message-1',
      sessionId,
      turnId,
      role: 'user',
      kind: 'normal',
      blocks: '已经落库',
      interrupted: false,
      createdAt: 100,
    };
    const turn: Turn = {
      id: turnId,
      sessionId,
      status: 'running',
      triggerType: 'userMessage',
      sessionMode: 'work',
      narrativePolicy: 'auto',
      providerId: null,
      modelId: null,
      protocol: null,
      characterDirectoryName: null,
      iterations: 0,
      createdAt: 42,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
    };
    const deps: SessionWebSocketRouteDeps = {
      connections: new SessionSocketConnections(),
      executor: {} as TurnExecutor,
      agentRuns: {} as AgentRunExecutor,
      continuations: { list: () => [] } as unknown as SessionContinuationQueue,
      sessions: {
        sessionExists: id => id === sessionId,
        getSession: vi.fn(),
        loadMessagesForTurn: id => id === turnId ? [persisted] : [],
      },
      turns: { getTurn: id => id === turnId ? turn : undefined },
      sessionRunning: registry,
      interactions: { listPending: () => [] } as unknown as SessionInteractionQueue,
      compactSession: vi.fn(),
      attachTurn: vi.fn(),
    };

    const app = new Hono();
    app.route('/api/ws/session', sessionWebSocketRoute(deps));
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

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws/session/${sessionId}`);
    const received: SessionServerMessage[] = [];
    let resolveFirst!: (message: SessionServerMessage) => void;
    let resolveSecond!: (message: SessionServerMessage) => void;
    const firstMessage = new Promise<SessionServerMessage>(resolve => { resolveFirst = resolve; });
    const secondMessage = new Promise<SessionServerMessage>(resolve => { resolveSecond = resolve; });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as SessionServerMessage;
      received.push(message);
      if (received.length === 1) resolveFirst(message);
      if (received.length === 2) resolveSecond(message);
    });
    const first = await new Promise<SessionServerMessage>((resolve, reject) => {
      void firstMessage.then(resolve);
      socket.addEventListener('error', () => reject(new Error('Session WebSocket test connection failed')));
    });

    expect(first).toEqual({
      type: 'session_state',
      running: {
        kind: 'turn',
        turnId,
        createdAt: 42,
        sessionMode: 'work',
        narrativePolicy: 'auto',
        messages: [persisted],
      },
      pendingInteractions: [],
      queuedInputs: [],
    });
    deps.connections.publish(sessionId, {
      type: 'session_running_changed',
      running: null,
    });
    expect(await secondMessage).toEqual({
      type: 'session_running_changed',
      running: null,
    });
    expect(received.filter(message => message.type === 'session_state')).toHaveLength(1);
    socket.close();
  });
});
