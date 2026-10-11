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
  TurnStore,
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
import { archiveSession, deleteSession } from '../src/application/sessionActions.js';
import { sessionActionsRoute } from '../src/routes/sessions/actions.js';
import { sessionCollectionRoute } from '../src/routes/sessions/collection.js';
import type { Composition } from '../src/composition/index.js';

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
  const running = new SessionRunningRegistry();
  const sessions = new SessionStore({ db, isWorkClosed: id => running.isClosed(id) });
  const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
  const starts: StartTurn[] = [];
  let queue: SessionContinuationQueue;
  const goals = new GoalStore(db, event => {
    if (event.type === 'goal_created') queue.requestDrain(event.goal.sessionId);
  }, id => running.isClosed(id));
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

function actionFixture() {
  const fixture = goalFixture();
  const turns = new TurnStore({ db: fixture.db, sessionRunning: fixture.running });
  const interactions = new SessionInteractionQueue(null);
  const subagents = {
    abortForSession: vi.fn(async () => undefined),
    abortForTurn: vi.fn(async () => undefined),
  };
  const processes = {
    stopForSession: vi.fn(async () => undefined),
  };
  const speech = {
    cancelSessionSpeech: vi.fn(async () => undefined),
  };
  const executor = {
    abortAndAwait: vi.fn(async (sessionId: string, turnId: string) => {
      turns.abortTurn(sessionId, turnId);
      turns.clearRunning(sessionId, turnId);
    }),
  };
  const composition = {
    database: { session: fixture.sessions, sessionRunning: fixture.running, goals: fixture.goals, turns },
    turn: { subagents, turnExecutor: executor, interactionQueue: interactions, continuations: fixture.queue },
    tools: { backgroundProcesses: processes, discardSessionToolState: vi.fn(async () => undefined) },
    speech,
    characters: { stage: { evictSession: vi.fn() } },
  } as unknown as Composition;
  const app = new Hono()
    .route('/api/sessions', sessionCollectionRoute({ session: fixture.sessions }))
    .route('/api/sessions', sessionActionsRoute({
      session: fixture.sessions,
      turns,
      abortSubagentsForTurn: subagents.abortForTurn,
      assertSessionWorkAllowed: id => fixture.running.assertWorkAllowed(id),
      archiveSession: id => archiveSession(composition, id),
      deleteSession: id => deleteSession(composition, id),
    }));
  return { ...fixture, turns, interactions, subagents, processes, speech, executor, composition, app };
}

describe('会话归档和删除', () => {
  it.each(['archive', 'delete'] as const)('%s 无需确认字段, 收到一次请求就停止并执行, 返回 204', async action => {
    const fixture = actionFixture();
    const root = fixture.turns.startTurn({ sessionId: fixture.session.id, triggerType: 'userMessage', ttsEnabled: false });
    const goal = fixture.goals.create(fixture.session.id, '正在进行的目标');
    fixture.queue.enqueue({ sessionId: fixture.session.id, input: [{ type: 'text', text: '排队消息' }] });
    const response = await fixture.app.request(`/api/sessions/${fixture.session.id}${action === 'archive' ? '/archive' : ''}`, {
      method: action === 'archive' ? 'POST' : 'DELETE',
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(root.signal.aborted).toBe(true);
    expect(fixture.running.isClosed(fixture.session.id)).toBe(false);
    if (action === 'archive') {
      expect(fixture.sessions.getSession(fixture.session.id).archivedAt).not.toBeNull();
      expect(fixture.goals.get(fixture.session.id, goal.id)).toMatchObject({ status: 'completed', reason: 'cancelled' });
    } else {
      expect(fixture.sessions.sessionExists(fixture.session.id)).toBe(false);
    }
    expect(fixture.queue.list(fixture.session.id)).toEqual([]);
    expect(fixture.subagents.abortForSession).toHaveBeenCalledTimes(1);
    expect(fixture.processes.stopForSession).toHaveBeenCalledTimes(1);
    expect(fixture.speech.cancelSessionSpeech).toHaveBeenCalled();
    fixture.queue.shutdown();
  });

  it('确认归档同时停止各项工作, 保留最后保存的消息, 未完成 Goal 标记取消', async () => {
    const fixture = actionFixture();
    const id = fixture.session.id;
    const root = fixture.turns.startTurn({ sessionId: id, triggerType: 'userMessage', ttsEnabled: false });
    const other = fixture.sessions.createSession({ cwd: os.tmpdir() });
    const otherRoot = fixture.turns.startTurn({ sessionId: other.id, triggerType: 'userMessage', ttsEnabled: false });
    const goal = fixture.goals.create(id, '需要结束的目标');
    fixture.sessions.appendMessage({ sessionId: id, turnId: root.turn.id, role: 'user', blocks: '已保存消息' });
    fixture.queue.enqueue({ sessionId: id, input: [{ type: 'text', text: '未执行消息' }] });
    const permission = fixture.interactions.enqueuePermission({
      sessionId: id, turnId: root.turn.id, toolCallId: 'waiting-approval', toolName: 'PowerShell', input: {},
    });
    let finishRoot!: () => void;
    const rootFinished = new Promise<void>(resolve => { finishRoot = resolve; });
    fixture.executor.abortAndAwait.mockImplementation(async (sessionId, turnId) => {
      await rootFinished;
      fixture.turns.abortTurn(sessionId, turnId);
      fixture.turns.clearRunning(sessionId, turnId);
    });
    const archived = archiveSession(fixture.composition, id);
    expect(root.signal.aborted).toBe(true);
    expect(otherRoot.signal.aborted).toBe(false);
    expect(fixture.subagents.abortForSession).toHaveBeenCalledWith(id, 'Session archived');
    expect(fixture.processes.stopForSession).toHaveBeenCalledWith(id);
    expect(fixture.speech.cancelSessionSpeech).toHaveBeenCalledWith(id);
    expect(fixture.queue.list(id)).toEqual([]);
    await expect(permission.promise).resolves.toMatchObject({ action: 'deny' });
    expect(fixture.goals.get(id, goal.id)).toMatchObject({ status: 'completed', reason: 'cancelled' });
    expect(() => fixture.sessions.getSessionForWork(id)).toThrow('session_stopping');
    const unarchiveDuringStop = await fixture.app.request(`/api/sessions/${id}/unarchive`, { method: 'POST' });
    expect(unarchiveDuringStop.status).toBe(409);
    fixture.sessions.appendMessage({ sessionId: id, turnId: root.turn.id, role: 'assistant', blocks: '停止前的最后记录' });
    finishRoot();
    await expect(archived).resolves.toBeUndefined();
    expect(fixture.sessions.loadHistory(id)).toHaveLength(2);
    expect(fixture.turns.getTurn(root.turn.id)?.status).toBe('aborted');
    expect(fixture.sessions.listSessionsForSidebar().recent.map(item => item.id)).not.toContain(id);
    const archiveList = await fixture.app.request('/api/sessions/archived');
    expect(await archiveList.json()).toEqual([
      { id, title: fixture.session.title, projectId: null, projectName: null, archivedAt: expect.any(Number) },
    ]);
    expect(fixture.composition.tools.discardSessionToolState).not.toHaveBeenCalled();
    fixture.sessions.unarchiveSession(id);
    fixture.queue.requestDrain(id);
    await Promise.resolve();
    expect(fixture.starts).toEqual([]);
    expect(() => fixture.sessions.getSessionForWork(id)).not.toThrow();
    fixture.queue.shutdown();
  });

  it('没有主任务时也停止后台子代理, 进程和语音', async () => {
    const fixture = actionFixture();
    await archiveSession(fixture.composition, fixture.session.id);
    expect(fixture.running.isClosed(fixture.session.id)).toBe(false);
    expect(fixture.subagents.abortForSession).toHaveBeenCalledWith(fixture.session.id, 'Session archived');
    expect(fixture.processes.stopForSession).toHaveBeenCalledWith(fixture.session.id);
    expect(fixture.speech.cancelSessionSpeech).toHaveBeenCalledWith(fixture.session.id);
    fixture.queue.shutdown();
  });

  it('确认删除后先等进程退出, 才删除历史及工具状态', async () => {
    const fixture = actionFixture();
    const id = fixture.session.id;
    fixture.sessions.appendMessage({ sessionId: id, turnId: null, role: 'user', blocks: '待删除历史' });
    let finishProcess!: () => void;
    fixture.processes.stopForSession.mockImplementation(() => new Promise<void>(resolve => { finishProcess = resolve; }));
    const deleted = deleteSession(fixture.composition, id);
    expect(fixture.sessions.sessionExists(id)).toBe(true);
    expect(fixture.sessions.loadHistory(id)).toHaveLength(1);
    expect(fixture.running.isClosed(id)).toBe(true);
    expect(fixture.composition.tools.discardSessionToolState).not.toHaveBeenCalled();
    finishProcess();
    await expect(deleted).resolves.toBeUndefined();
    expect(fixture.sessions.sessionExists(id)).toBe(false);
    expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(id)).toEqual({ count: 0 });
    expect(fixture.composition.tools.discardSessionToolState).toHaveBeenCalledWith(id);
    expect(fixture.composition.characters.stage.evictSession).toHaveBeenCalledWith(id);
    fixture.queue.shutdown();
  });

  it('归档取消暂停的 Goal, 不改写已经完成的 Goal', async () => {
    const fixture = actionFixture();
    const id = fixture.session.id;
    const succeeded = fixture.goals.create(id, '完成的目标');
    fixture.goals.complete({ sessionId: id, goalId: succeeded.id, expectedVersion: succeeded.version }, '完成');
    const active = fixture.goals.create(id, '暂停的目标');
    const paused = fixture.goals.pause({ sessionId: id, goalId: active.id, expectedVersion: active.version });
    await archiveSession(fixture.composition, id);
    expect(fixture.goals.get(id, succeeded.id)).toMatchObject({ status: 'completed', reason: 'succeeded' });
    expect(fixture.goals.get(id, paused.id)).toMatchObject({ status: 'completed', reason: 'cancelled' });
    fixture.queue.shutdown();
  });

  it.each(['archive', 'delete'] as const)('%s 不存在的会话返回 404, 不启动停止流程', async action => {
    const fixture = actionFixture();
    const response = await fixture.app.request(`/api/sessions/missing${action === 'archive' ? '/archive' : ''}`, {
      method: action === 'archive' ? 'POST' : 'DELETE',
    });
    expect(response.status).toBe(404);
    expect(fixture.sessions.getSession(fixture.session.id).archivedAt).toBeNull();
    expect(fixture.subagents.abortForSession).not.toHaveBeenCalled();
    expect(fixture.processes.stopForSession).not.toHaveBeenCalled();
    fixture.queue.shutdown();
  });
});

describe('Session WebSocket Route', () => {
  it.each(['send_user_message', 'queue_user_message'] as const)(
    '归档拒绝 %s, 不创建 Goal、排队输入或 Turn', async type => {
      const fixture = goalFixture();
      fixture.sessions.archiveSession(fixture.session.id);
      const { socket, waitForMessage } = await connect(fixture.deps, fixture.session.id);
      for (const objective of [undefined, '新目标']) {
        const response = waitForMessage();
        socket.send(JSON.stringify({ type, requestId: 'archived-input', payload: {
          input: [{ type: 'text', text: '不能发送' }], objective,
        } }));
        expect(await response).toMatchObject({ type: 'request_rejected', code: 'session_archived' });
      }
      expect(fixture.goals.getCurrent(fixture.session.id)).toBeNull();
      expect(fixture.queue.list(fixture.session.id)).toEqual([]);
      expect(fixture.starts).toEqual([]);
      expect(fixture.deps.executor.start).not.toHaveBeenCalled();
      fixture.queue.shutdown();
    },
  );

  it('正在删除或归档时拒绝直接发送和建 Goal', async () => {
    const fixture = goalFixture();
    const { socket, waitForMessage } = await connect(fixture.deps, fixture.session.id);
    await fixture.running.runWithSessionClosed(fixture.session.id, async () => {
      const response = waitForMessage();
      socket.send(JSON.stringify({ type: 'send_user_message', requestId: 'stopping-input', payload: {
        input: [{ type: 'text', text: '不能发送' }], objective: '新目标',
      } }));
      expect(await response).toMatchObject({ type: 'request_rejected', code: 'session_stopping' });
      expect(() => fixture.goals.create(fixture.session.id, '迟到 Goal')).toThrow('session_stopping');
    });
    expect(fixture.goals.getCurrent(fixture.session.id)).toBeNull();
    expect(fixture.starts).toEqual([]);
    fixture.queue.shutdown();
  });

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
      input: [{ type: 'text', text: objective }], objective,
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
      input: [{ type: 'text', text: objective }], objective,
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
      input: [{ type: 'text', text: '新任务' }], objective: '新任务',
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
        getSessionForWork: vi.fn(),
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
