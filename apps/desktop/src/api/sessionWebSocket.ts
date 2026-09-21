import type { PermissionResponse } from '@ema-agent/permission';
import type { ActiveSession } from '@ema-agent/session';
import type {
  ClientRequestId,
  SessionBusinessMessage,
  SessionClientMessage,
  SessionServerMessage,
  UserMessagePayload,
} from '@ema-agent/server/routes/ws/session.js';
import { serverClient } from './client.js';

type SessionMessageHandler = (message: SessionBusinessMessage) => void;
type SessionConnectionStateHandler = (state: SessionConnectionState) => void;

export type SessionConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface SessionSocketSubscriber {
  readonly onMessage: SessionMessageHandler;
  readonly onConnectionState: SessionConnectionStateHandler;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface SessionConnection {
  socket: WebSocket | null;
  readonly handlers: Set<SessionMessageHandler>;
  readonly stateHandlers: Set<SessionConnectionStateHandler>;
  /**
   * 只保存尚未写入任何 Socket 的请求. 连接打开后会按创建顺序发送并立即移出这里.
   * 已经写入 Socket 的请求即使随后断线也不会重新加入, 因为 Server 可能已经保存了
   * UserMessage 或 Queue item, 自动重发会产生第二条业务记录.
   */
  readonly outgoing: SessionClientMessage[];
  /**
   * 每一项对应 Desktop 已经创建, 但 Promise 还没有成功或失败的一次 Session 请求.
   * 请求可能仍在 outgoing 中等待连接, 也可能已经发出并等待 Server 结果. 收到同一个
   * requestId 的结果后立即结束 Promise 并删除; 已发送请求遇到断线时按结果未知失败结束.
   * 这里不保存聊天消息、Turn 或 Queue 投影.
   */
  readonly pendingRequests: Map<ClientRequestId, PendingRequest>;
  state: SessionConnectionState;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  generation: number;
  closed: boolean;
}

export class SessionRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SessionRequestError';
  }
}

class SessionWebSocket {
  private readonly connections = new Map<string, SessionConnection>();

  subscribe(sessionId: string, subscriber: SessionSocketSubscriber): () => void {
    const connection = this.connection(sessionId);
    connection.handlers.add(subscriber.onMessage);
    connection.stateHandlers.add(subscriber.onConnectionState);
    subscriber.onConnectionState(connection.state);
    this.connect(sessionId, connection);
    return () => {
      connection.handlers.delete(subscriber.onMessage);
      connection.stateHandlers.delete(subscriber.onConnectionState);
    };
  }

  sendUserMessage(sessionId: string, payload: UserMessagePayload): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'send_user_message', requestId, payload,
    }));
  }

  queueUserMessage(sessionId: string, payload: UserMessagePayload): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'queue_user_message', requestId, payload,
    }));
  }

  removeQueuedInput(sessionId: string, id: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'remove_queued_input', requestId, id,
    }));
  }

  guideQueuedInput(sessionId: string, id: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'guide_queued_input', requestId, id,
    }));
  }

  startCompaction(sessionId: string) {
    return this.request<Extract<SessionServerMessage, { type: 'manual_compact_result' }>['result']>(
      sessionId,
      requestId => ({ type: 'start_compaction', requestId }),
    );
  }

  respondPermission(
    sessionId: string,
    turnId: string,
    toolCallId: string,
    response: PermissionResponse,
  ): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'respond_permission',
      requestId,
      turnId,
      toolCallId,
      action: response.action,
      ...(response.action === 'deny' && response.reason ? { reason: response.reason } : {}),
    }));
  }

  respondAskUser(
    sessionId: string,
    turnId: string,
    toolCallId: string,
    answers: Record<string, string>,
  ): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'respond_ask_user', requestId, turnId, toolCallId, answers,
    }));
  }

  cancelAskUser(sessionId: string, turnId: string, toolCallId: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'cancel_ask_user', requestId, turnId, toolCallId,
    }));
  }

  cancelActiveSession(sessionId: string, active: ActiveSession): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'cancel_active_session', requestId, active,
    }));
  }

  cancelTool(sessionId: string, turnId: string, toolCallId: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'cancel_tool', requestId, turnId, toolCallId,
    }));
  }

  cancelAgentRun(sessionId: string, agentRunId: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'cancel_agent_run', requestId, agentRunId,
    }));
  }

  disconnect(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    connection.closed = true;
    connection.generation += 1;
    this.clearTimers(connection);
    connection.socket?.close(1000, 'session_evicted');
    const error = new SessionRequestError('connection_closed', 'Session 连接已经关闭');
    for (const pending of connection.pendingRequests.values()) pending.reject(error);
    connection.pendingRequests.clear();
    connection.outgoing.length = 0;
    this.changeState(connection, 'disconnected');
    this.connections.delete(sessionId);
  }

  private connection(sessionId: string): SessionConnection {
    const existing = this.connections.get(sessionId);
    if (existing) return existing;
    const created: SessionConnection = {
      socket: null,
      handlers: new Set(),
      stateHandlers: new Set(),
      outgoing: [],
      pendingRequests: new Map(),
      state: 'disconnected',
      reconnectAttempt: 0,
      reconnectTimer: null,
      pingTimer: null,
      pongTimer: null,
      generation: 0,
      closed: false,
    };
    this.connections.set(sessionId, created);
    return created;
  }

  private connect(sessionId: string, connection: SessionConnection): void {
    if (connection.closed || connection.reconnectTimer) return;
    if (
      connection.socket?.readyState === WebSocket.OPEN
      || connection.socket?.readyState === WebSocket.CONNECTING
    ) return;

    connection.generation += 1;
    const generation = connection.generation;
    this.changeState(connection, connection.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    void serverClient.webSocketUrl(`/api/ws/session/${encodeURIComponent(sessionId)}`)
      .then(url => {
        if (connection.closed || generation !== connection.generation) return;
        const socket = new WebSocket(url);
        let opened = false;
        connection.socket = socket;
        socket.addEventListener('open', () => {
          if (connection.socket !== socket || connection.closed) return;
          opened = true;
          connection.reconnectAttempt = 0;
          this.changeState(connection, 'connected');
          while (connection.outgoing.length > 0) {
            socket.send(JSON.stringify(connection.outgoing.shift()!));
          }
          this.startHeartbeat(connection, socket);
        });
        socket.addEventListener('message', event => this.receive(connection, String(event.data)));
        socket.addEventListener('close', () => {
          if (connection.socket !== socket) return;
          connection.socket = null;
          this.clearTimers(connection);
          // 打开后断线时, Server 可能已经执行写请求但回复尚未到达. 报告结果未知,
          // 不能重发, 否则同一条输入可能保存两次或排队两次.
          if (opened) this.rejectRequests(connection, 'connection_lost', 'Session 连接已中断');
          if (!connection.closed) this.scheduleReconnect(sessionId, connection);
        });
      })
      .catch(() => {
        if (!connection.closed && generation === connection.generation) {
          this.scheduleReconnect(sessionId, connection);
        }
      });
  }

  private receive(connection: SessionConnection, source: string): void {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      return;
    }
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
    const message = value as SessionServerMessage;

    if (message.type === 'pong') {
      if (connection.pongTimer) clearTimeout(connection.pongTimer);
      connection.pongTimer = null;
      return;
    }
    if (message.type === 'manual_compact_result') {
      connection.pendingRequests.get(message.requestId)?.resolve(message.result);
      connection.pendingRequests.delete(message.requestId);
      return;
    }
    if (message.type === 'request_succeeded') {
      connection.pendingRequests.get(message.requestId)?.resolve(undefined);
      connection.pendingRequests.delete(message.requestId);
      return;
    }
    if (message.type === 'request_rejected') {
      connection.pendingRequests.get(message.requestId)?.reject(
        new SessionRequestError(message.code, message.message),
      );
      connection.pendingRequests.delete(message.requestId);
      return;
    }

    // Chat 只收到 Session 业务更新. 心跳和请求结果在 API 内结束, 不进入 Store.
    for (const handler of [...connection.handlers]) handler(message);
  }

  private request<T>(
    sessionId: string,
    createMessage: (requestId: ClientRequestId) => SessionClientMessage,
  ): Promise<T> {
    const connection = this.connection(sessionId);
    const requestId = crypto.randomUUID();
    const message = createMessage(requestId);
    const result = new Promise<T>((resolve, reject) => {
      connection.pendingRequests.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
      });
    });
    if (connection.socket?.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(message));
    } else {
      connection.outgoing.push(message);
      this.connect(sessionId, connection);
    }
    return result;
  }

  private scheduleReconnect(sessionId: string, connection: SessionConnection): void {
    if (connection.reconnectTimer || connection.closed) return;
    this.changeState(connection, 'reconnecting');
    const delay = Math.min(1_000 * 2 ** connection.reconnectAttempt, 30_000);
    connection.reconnectAttempt += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      this.connect(sessionId, connection);
    }, delay);
  }

  private startHeartbeat(connection: SessionConnection, socket: WebSocket): void {
    this.clearTimers(connection);
    connection.pingTimer = setInterval(() => {
      if (connection.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'ping' } satisfies SessionClientMessage));
      if (connection.pongTimer) clearTimeout(connection.pongTimer);
      connection.pongTimer = setTimeout(() => socket.close(), 10_000);
    }, 30_000);
  }

  private clearTimers(connection: SessionConnection): void {
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    if (connection.pingTimer) clearInterval(connection.pingTimer);
    if (connection.pongTimer) clearTimeout(connection.pongTimer);
    connection.reconnectTimer = null;
    connection.pingTimer = null;
    connection.pongTimer = null;
  }

  private rejectRequests(connection: SessionConnection, code: string, message: string): void {
    const error = new SessionRequestError(code, message);
    for (const pending of connection.pendingRequests.values()) pending.reject(error);
    connection.pendingRequests.clear();
    connection.outgoing.length = 0;
  }

  private changeState(connection: SessionConnection, state: SessionConnectionState): void {
    if (connection.state === state) return;
    connection.state = state;
    for (const handler of [...connection.stateHandlers]) handler(state);
  }
}

export const sessionWebSocket = new SessionWebSocket();
