import type { PermissionResponse } from '@ema-agent/permission';
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
  /**
   * Chat 已经不再观察这个 Session 时为 true. 如果还有已经发出的请求等待结果,
   * Socket 会暂时保留到结果返回; 期间重新订阅或发起请求会撤销这次关闭.
   */
  closeRequested: boolean;
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
    const connection = this.getOrCreateConnection(sessionId);
    connection.closeRequested = false;
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

  cancelTurn(sessionId: string, turnId: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'cancel_turn', requestId, turnId,
    }));
  }

  cancelCompact(sessionId: string, compactId: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'cancel_compact', requestId, compactId,
    }));
  }

  cancelTool(sessionId: string, turnId: string, toolCallId: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'cancel_tool', requestId, turnId, toolCallId,
    }));
  }

  cancelSubagent(sessionId: string, subagentId: string): Promise<void> {
    return this.request<void>(sessionId, requestId => ({
      type: 'cancel_subagent', requestId, subagentId,
    }));
  }

  /**
   * Chat 不再观察这个 Session 时关闭网络连接. 已写入 Socket 的请求会先等 Server 返回结果;
   * History, Turn Stream, Speech 和 Presentation 由各自业务生命周期清理, 不在这里处理.
   */
  disconnect(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    connection.closeRequested = true;

    // outgoing 里的请求还没有写入任何 Socket, 可以确定 Server 没有执行它们.
    // 已经发出的请求必须等结果返回再关, 尤其 compact_completed 会早于
    // manual_compact_result, 这里立即拒绝会把成功压缩误报成断线失败.
    if (connection.outgoing.length > 0) {
      this.rejectRequests(connection, 'connection_closed', 'Session 连接已经关闭');
    }
    this.finishDisconnect(sessionId, connection);
  }

  private getOrCreateConnection(sessionId: string): SessionConnection {
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
      closeRequested: false,
    };
    this.connections.set(sessionId, created);
    return created;
  }

  private connect(sessionId: string, connection: SessionConnection): void {
    if (connection.closeRequested || connection.reconnectTimer) return;
    if (
      connection.socket?.readyState === WebSocket.OPEN
      || connection.socket?.readyState === WebSocket.CONNECTING
    ) return;

    connection.generation += 1;
    const generation = connection.generation;
    this.changeState(connection, connection.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    void serverClient.webSocketUrl(`/api/ws/session/${encodeURIComponent(sessionId)}`)
      .then(url => {
        if (connection.closeRequested || generation !== connection.generation) return;
        const socket = new WebSocket(url);
        let opened = false;
        connection.socket = socket;
        socket.addEventListener('open', () => {
          if (connection.socket !== socket || connection.closeRequested) return;
          opened = true;
          connection.reconnectAttempt = 0;
          this.changeState(connection, 'connected');
          while (connection.outgoing.length > 0) {
            socket.send(JSON.stringify(connection.outgoing.shift()!));
          }
          this.startHeartbeat(connection, socket);
        });
        socket.addEventListener('message', event => (
          this.receive(sessionId, connection, String(event.data))
        ));
        socket.addEventListener('close', () => {
          if (connection.socket !== socket) return;
          connection.socket = null;
          this.clearTimers(connection);
          // 打开后断线时, Server 可能已经执行写请求但回复尚未到达. 报告结果未知,
          // 不能重发, 否则同一条输入可能保存两次或排队两次.
          if (opened) this.rejectRequests(connection, 'connection_lost', 'Session 连接已中断');
          if (connection.closeRequested) {
            this.finishDisconnect(sessionId, connection);
          } else {
            this.scheduleReconnect(sessionId, connection);
          }
        });
      })
      .catch(() => {
        if (!connection.closeRequested && generation === connection.generation) {
          this.scheduleReconnect(sessionId, connection);
        }
      });
  }

  private receive(sessionId: string, connection: SessionConnection, source: string): void {
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
      this.finishDisconnect(sessionId, connection);
      return;
    }
    if (message.type === 'request_succeeded') {
      connection.pendingRequests.get(message.requestId)?.resolve(undefined);
      connection.pendingRequests.delete(message.requestId);
      this.finishDisconnect(sessionId, connection);
      return;
    }
    if (message.type === 'request_rejected') {
      connection.pendingRequests.get(message.requestId)?.reject(
        new SessionRequestError(message.code, message.message),
      );
      connection.pendingRequests.delete(message.requestId);
      this.finishDisconnect(sessionId, connection);
      return;
    }

    // Chat 只收到 Session 业务更新. 心跳和请求结果在 API 内结束, 不进入 Store.
    for (const handler of [...connection.handlers]) handler(message);
  }

  private request<T>(
    sessionId: string,
    createMessage: (requestId: ClientRequestId) => SessionClientMessage,
  ): Promise<T> {
    const connection = this.getOrCreateConnection(sessionId);
    connection.closeRequested = false;
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
    return result.finally(() => {
      // 主窗口 Permission 等入口可能只发一次请求, 没有 Chat 业务订阅.
      // 结果已经返回且没有观察者时直接关闭, 不为一次命令永久保留 Socket.
      if (
        connection.handlers.size === 0
        && connection.stateHandlers.size === 0
        && this.connections.get(sessionId) === connection
      ) {
        this.disconnect(sessionId);
      }
    });
  }

  private scheduleReconnect(sessionId: string, connection: SessionConnection): void {
    if (connection.reconnectTimer || connection.closeRequested) return;
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

  /** 没有在途请求后才真正关闭并删除连接;业务 Store 不在这个模块的清理范围内. */
  private finishDisconnect(sessionId: string, connection: SessionConnection): void {
    if (!connection.closeRequested || connection.pendingRequests.size > 0) return;
    connection.generation += 1;
    this.clearTimers(connection);
    const socket = connection.socket;
    connection.socket = null;
    socket?.close(1000, 'session_subscription_closed');
    this.changeState(connection, 'disconnected');
    if (this.connections.get(sessionId) === connection) this.connections.delete(sessionId);
  }

  private changeState(connection: SessionConnection, state: SessionConnectionState): void {
    if (connection.state === state) return;
    connection.state = state;
    for (const handler of [...connection.stateHandlers]) handler(state);
  }
}

export const sessionWebSocket = new SessionWebSocket();
