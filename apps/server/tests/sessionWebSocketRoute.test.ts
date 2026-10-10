// 验证 Session WebSocket 打开后的首条业务消息包含同一连接边界下的运行身份和已保存 Message.

import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import os from 'node:os';
import { GoalStore } from '@ema-agent/goal';
import { Database, GoalsRepo } from '@ema-agent/storage';
import { SessionRunningRegistry, SessionStore, type SessionMessage } from '@ema-agent/session';
import {
  SessionContinuationQueue,
  SessionInteractionQueue,
  type StartTurn,
  type TurnHandle,
  type Turn,
  type TurnExecutor,
} from '@ema-agent/turn';
import type { SubagentExecutor } from '@ema-agent/agent';
import {
  SessionSocketConnections,
  sessionWebSocketRoute,
  type SessionServerMessage,
  type SessionWebSocketRouteDeps,
} from '../src/routes/ws/session.js';

let server: Server | null = null;
let webSocketServer: WebSocketServer | null = null;
const databases: Database[] = [];

afterEach(async () => {
  for (const socket of webSocketServer?.clients ?? []) socket.terminate();
  webSocketServer?.close();
  webSocketServer = null;
  for (const db of databases.splice(0)) db.close();
  if (!server) return;
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function connect(deps: SessionWebSocketRouteDeps, sessionId: string) {
  const app = new Hono().route('/api/ws/session', sessionWebSocketRoute(deps));
  webSocketServer = new WebSocketServer({ noServer: true });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0,
    websocket: { server: webSocketServer } }) as Server;
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws/session/${sessionId}`);
  const waitForMessage = () => new Promise<SessionServerMessage>((resolve, reject) => {
    socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true });
    socket.addEventListener('error', () => reject(new Error('test websocket failed')), { once: true });
  });
  expect((await waitForMessage()).type).toBe('session_state');
  return { socket, waitForMessage };
}

function goalFixture() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  databases.push(db);
  const sessions = new SessionStore({ db });
  const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
  const running = new SessionRunningRegistry();
  const starts: StartTurn[] = [];
  let queue: SessionContinuationQueue;
  const goals = new GoalStore(db, event => {
    if (event.type === 'goal_created') queue.requestDrain(event.goal.sessionId);
  });
  queue = new SessionContinuationQueue({
    sessions, goals, sessionRunning: running,
    startTurn: input => {
      starts.push(input);
      running.register(session.id, { kind: 'turn', turnId: input.turnId! });
      return { sessionId: session.id, turnId: input.turnId!, events: (async function* () {})(),
        completion: new Promise(() => {}), abort: () => undefined } satisfies TurnHandle;
    },
    attachTurn: vi.fn(), publish: vi.fn(),
  });
  const deps: SessionWebSocketRouteDeps = {
    connections: new SessionSocketConnections(),
    executor: { start: vi.fn() } as unknown as TurnExecutor,
    subagents: {} as SubagentExecutor,
    continuations: queue, goals, sessions,
    turns: { getTurn: () => undefined },
    sessionRunning: running,
    interactions: { listPending: () => [] } as unknown as SessionInteractionQueue,
    compactSession: vi.fn(), attachTurn: vi.fn(),
  };
  return { db, sessions, session, running, goals, queue, starts, deps };
}

describe('Session WebSocket Route', () => {
  it('没有运行中的父 Turn 时仍能回答子代理批准, 不需要提交 Turn 或 Run ID', async () => {
    const fixture = goalFixture();
    const queue = new SessionInteractionQueue(null);
    const deps = { ...fixture.deps, interactions: queue };
    const pending = queue.enqueuePermission({
      sessionId: fixture.session.id, turnId: 'finished-parent', toolCallId: 'child-call',
      subagentId: 'agent-1', runId: 'run-1', toolName: 'PowerShell', input: { command: 'Get-Date' },
    });
    const { socket, waitForMessage } = await connect(deps, fixture.session.id);
    const required = queue.listPending(fixture.session.id).find(entry => entry.kind === 'permission')!.request;
    const notification = waitForMessage();
    deps.connections.publish(fixture.session.id, { type: 'permission_required', ...required });
    expect(await notification).toEqual({ type: 'permission_required', ...required });
    const response = waitForMessage();
    socket.send(JSON.stringify({ type: 'respond_permission', requestId: 'approve-child',
      toolCallId: 'child-call', action: 'allow' }));
    expect(await response).toEqual({ type: 'request_succeeded', requestId: 'approve-child' });
    await expect(pending.promise).resolves.toEqual({ action: 'allow' });
    expect(fixture.running.getRunning(fixture.session.id)).toBeUndefined();
    expect(fixture.starts).toEqual([]);
    fixture.queue.shutdown();
  });

  it('拒绝回答其它 Session 的批准, 也拒绝已经取消的 Run 请求', async () => {
    const fixture = goalFixture();
    const queue = new SessionInteractionQueue(null);
    const deps = { ...fixture.deps, interactions: queue };
    const foreign = queue.enqueuePermission({
      sessionId: 'other-session', turnId: 'parent', toolCallId: 'foreign-call',
      toolName: 'PowerShell', input: {},
    });
    const { socket, waitForMessage } = await connect(deps, fixture.session.id);
    let response = waitForMessage();
    socket.send(JSON.stringify({ type: 'respond_permission', requestId: 'wrong-session',
      toolCallId: 'foreign-call', action: 'allow' }));
    expect(await response).toMatchObject({ type: 'request_rejected', code: 'not_found_or_expired' });
    expect(queue.size()).toBe(1);
    const child = queue.enqueuePermission({
      sessionId: fixture.session.id, turnId: 'parent', toolCallId: 'child-call',
      subagentId: 'agent', runId: 'run', toolName: 'PowerShell', input: {},
    });
    queue.cancelForRun('run');
    response = waitForMessage();
    socket.send(JSON.stringify({ type: 'respond_permission', requestId: 'late-answer',
      toolCallId: 'child-call', action: 'allow' }));
    expect(await response).toMatchObject({ type: 'request_rejected', code: 'not_found_or_expired' });
    await expect(child.promise).resolves.toMatchObject({ action: 'deny' });
    queue.cancelForSession('other-session');
    await foreign.promise;
    fixture.queue.shutdown();
  });

  it('正常发送携带原始 objective 时先建 Goal 再入队, 创建事件不会提前开第二根 Turn', async () => {
    const fixture = goalFixture();
    const { socket, waitForMessage } = await connect(fixture.deps, fixture.session.id);
    const objective = ' \r\n任务正文\n  ';
    const response = waitForMessage();
    socket.send(JSON.stringify({ type: 'send_user_message', requestId: 'initial-goal', payload: {
      sessionMode: 'work', input: [{ type: 'text', text: objective }], objective,
    } }));
    expect(await response).toEqual({ type: 'request_succeeded', requestId: 'initial-goal' });
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]).toMatchObject({ triggerType: 'userMessage', input: [{ type: 'text', text: objective }],
      continuationText: expect.stringContaining('根据本轮 reminder 和 GoalGet') });
    const goal = fixture.goals.getCurrent(fixture.session.id)!;
    expect(new GoalsRepo(fixture.db.sqlite).findById(fixture.session.id, goal.id)?.objective).toBe(objective);
    expect(fixture.deps.executor.start).not.toHaveBeenCalled();
    fixture.queue.shutdown();
  });

  it('活动 Turn 下带目标的排队发送保留用户任务, 收尾后与短提示同轮交付', async () => {
    const fixture = goalFixture();
    const { socket, waitForMessage } = await connect(fixture.deps, fixture.session.id);
    fixture.running.register(fixture.session.id, { kind: 'turn', turnId: 'existing-turn' });
    const objective = '  下一轮的任务  ';
    const response = waitForMessage();
    socket.send(JSON.stringify({ type: 'queue_user_message', requestId: 'queued-goal', payload: {
      sessionMode: 'work', input: [{ type: 'text', text: objective }], objective,
    } }));
    expect(await response).toEqual({ type: 'request_succeeded', requestId: 'queued-goal' });
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.goals.getCurrent(fixture.session.id)?.objective).toBe(objective);
    fixture.running.clear(fixture.session.id, { kind: 'turn', turnId: 'existing-turn' });
    fixture.queue.turnFinished(fixture.session.id, 'completed');
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: objective }]);
    expect(fixture.starts[0]!.continuationText).toContain('根据本轮 reminder 和 GoalGet');
    fixture.queue.shutdown();
  });

  it.each(['plan', 'existing', 'compact'] as const)('%s 冲突拒绝初始 Goal 请求, 不把未创建的任务入队', async conflict => {
    const fixture = goalFixture();
    const { socket, waitForMessage } = await connect(fixture.deps, fixture.session.id);
    if (conflict === 'plan') fixture.sessions.patchSession(fixture.session.id, { permissionMode: 'plan' });
    else if (conflict === 'existing') {
      const goal = fixture.goals.create(fixture.session.id, '已有目标');
      fixture.goals.pause({ sessionId: fixture.session.id, goalId: goal.id, expectedVersion: goal.version });
    } else fixture.running.register(fixture.session.id, { kind: 'compact', compactId: 'compact' });
    const response = waitForMessage();
    socket.send(JSON.stringify({ type: 'send_user_message', requestId: 'rejected-goal', payload: {
      sessionMode: 'work', input: [{ type: 'text', text: '新任务' }], objective: '新任务',
    } }));
    const codes = { plan: 'goal_plan_conflict', existing: 'goal_already_exists', compact: 'session_busy' };
    expect(await response).toMatchObject({ type: 'request_rejected', code: codes[conflict] });
    expect(fixture.queue.list(fixture.session.id)).toEqual([]);
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.deps.executor.start).not.toHaveBeenCalled();
    fixture.queue.shutdown();
  });

  it('每次连接先发送一条 session_state, 运行 Turn 携带冻结设置和已保存 Message', async () => {
    const sessionId = 'session-1';
    const turnId = 'turn-1';
    const registry = new SessionRunningRegistry();
    registry.register(sessionId, { kind: 'turn', turnId });
    const persisted: SessionMessage = {
      id: 'message-1',
      sessionId,
      turnId,
      role: 'user',
      kind: 'normal',
      blocks: '已经落库',
      interrupted: false,
      createdAt: 100,
      summarizedThroughMessageId: null,
    };
    const turn: Turn = {
      id: turnId,
      sessionId,
      status: 'running',
      triggerType: 'userMessage',
      sessionMode: 'work',
      ttsEnabled: true,
      providerId: null,
      modelId: null,
      protocol: null,
      characterName: null,
      iterations: 0,
      createdAt: 42,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
    };
    const deps: SessionWebSocketRouteDeps = {
      connections: new SessionSocketConnections(),
      executor: {} as TurnExecutor,
      subagents: {} as SubagentExecutor,
      continuations: { list: () => [] } as unknown as SessionContinuationQueue,
      goals: { create: vi.fn() },
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
