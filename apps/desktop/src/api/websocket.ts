import type {
  AgentClientMessage,
  AgentServerMessage,
  EnqueueInputPayload,
} from '@ema-agent/server/routes/ws/agent.js';
import type { SpeechControlEvent } from '@ema-agent/server/routes/ws/speech.js';
import type { PermissionResponse } from '@ema-agent/permission';
import { serverClient } from './client.js';

type AgentMessageHandler = (message: AgentServerMessage) => void;
type AgentConnectionStateHandler = (state: AgentConnectionState) => void;

export type AgentConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface AgentSocketSubscriber {
  readonly onMessage: AgentMessageHandler;
  readonly onConnectionState: AgentConnectionStateHandler;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface AgentConnection {
  socket: WebSocket | null;
  readonly handlers: Set<AgentMessageHandler>;
  readonly stateHandlers: Set<AgentConnectionStateHandler>;
  readonly outgoing: AgentClientMessage[];
  readonly commands: Map<string, PendingCommand>;
  state: AgentConnectionState;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  generation: number;
  closed: boolean;
}

export class AgentWebSocketCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentWebSocketCommandError';
  }
}

export class AgentWebSockets {
  private readonly connections = new Map<string, AgentConnection>();

  subscribe(sessionId: string, subscriber: AgentSocketSubscriber): () => void {
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

  enqueueInput(sessionId: string, payload: EnqueueInputPayload): Promise<void> {
    return this.command<void>(sessionId, commandId => ({
      type: 'enqueue_input', commandId, payload,
    }));
  }

  removeQueuedInput(sessionId: string, id: string): Promise<void> {
    return this.command<void>(sessionId, commandId => ({
      type: 'remove_queued_input', commandId, id,
    }));
  }

  guideQueuedInput(sessionId: string, id: string): Promise<void> {
    return this.command<void>(sessionId, commandId => ({
      type: 'guide_queued_input', commandId, id,
    }));
  }

  startCompaction(sessionId: string) {
    return this.command<Extract<AgentServerMessage, { type: 'compaction_completed' }>['result']>(
      sessionId,
      commandId => ({ type: 'start_compaction', commandId }),
    );
  }

  respondPermission(
    sessionId: string,
    turnId: string,
    toolCallId: string,
    response: PermissionResponse,
  ): Promise<void> {
    return this.command<void>(sessionId, commandId => ({
      type: 'respond_permission',
      commandId,
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
    return this.command<void>(sessionId, commandId => ({
      type: 'respond_ask_user', commandId, turnId, toolCallId, answers,
    }));
  }

  cancelAskUser(sessionId: string, turnId: string, toolCallId: string): Promise<void> {
    return this.command<void>(sessionId, commandId => ({
      type: 'cancel_ask_user', commandId, turnId, toolCallId,
    }));
  }

  cancelExecution(sessionId: string, executionId: string): Promise<void> {
    return this.command<void>(sessionId, commandId => ({
      type: 'cancel_execution', commandId, executionId,
    }));
  }

  cancelTool(sessionId: string, turnId: string, toolCallId: string): Promise<void> {
    return this.command<void>(sessionId, commandId => ({
      type: 'cancel_tool', commandId, turnId, toolCallId,
    }));
  }

  cancelAgentRun(sessionId: string, agentRunId: string): Promise<void> {
    return this.command<void>(sessionId, commandId => ({
      type: 'cancel_agent_run', commandId, agentRunId,
    }));
  }

  disconnect(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    connection.closed = true;
    connection.generation += 1;
    this.clearTimers(connection);
    connection.socket?.close(1000, 'session_evicted');
    const error = new AgentWebSocketCommandError('connection_closed', 'Session 连接已经关闭');
    for (const pending of connection.commands.values()) pending.reject(error);
    connection.commands.clear();
    connection.outgoing.length = 0;
    this.changeState(connection, 'disconnected');
    this.connections.delete(sessionId);
  }

  private connection(sessionId: string): AgentConnection {
    const existing = this.connections.get(sessionId);
    if (existing) return existing;
    const created: AgentConnection = {
      socket: null,
      handlers: new Set(),
      stateHandlers: new Set(),
      outgoing: [],
      commands: new Map(),
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

  private connect(sessionId: string, connection: AgentConnection): void {
    if (connection.closed || connection.reconnectTimer) return;
    if (connection.socket?.readyState === WebSocket.OPEN || connection.socket?.readyState === WebSocket.CONNECTING) return;
    connection.generation += 1;
    const generation = connection.generation;
    this.changeState(connection, connection.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    void serverClient.webSocketUrl(`/api/ws/agent/${encodeURIComponent(sessionId)}`)
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
          while (connection.outgoing.length > 0) socket.send(JSON.stringify(connection.outgoing.shift()!));
          this.startHeartbeat(connection, socket);
        });
        socket.addEventListener('message', event => this.receive(connection, String(event.data)));
        socket.addEventListener('close', () => {
          if (connection.socket !== socket) return;
          connection.socket = null;
          this.clearTimers(connection);
          if (opened) this.rejectCommands(connection, 'connection_lost', 'Session 连接已中断');
          if (!connection.closed) this.scheduleReconnect(sessionId, connection);
        });
      })
      .catch(() => {
        if (!connection.closed && generation === connection.generation) this.scheduleReconnect(sessionId, connection);
      });
  }

  private receive(connection: AgentConnection, source: string): void {
    let value: unknown;
    try { value = JSON.parse(source); } catch { return; }
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
    const message = value as AgentServerMessage;
    if (message.type === 'pong') {
      if (connection.pongTimer) clearTimeout(connection.pongTimer);
      connection.pongTimer = null;
    } else if (message.type === 'compaction_completed') {
      connection.commands.get(message.commandId)?.resolve(message.result);
      connection.commands.delete(message.commandId);
    } else if (message.type === 'command_succeeded') {
      connection.commands.get(message.commandId)?.resolve(undefined);
      connection.commands.delete(message.commandId);
    } else if (message.type === 'command_rejected') {
      connection.commands.get(message.commandId)?.reject(new AgentWebSocketCommandError(message.code, message.message));
      connection.commands.delete(message.commandId);
    }
    for (const handler of [...connection.handlers]) handler(message);
  }

  private command<T>(sessionId: string, createMessage: (commandId: string) => AgentClientMessage): Promise<T> {
    const connection = this.connection(sessionId);
    const commandId = crypto.randomUUID();
    const message = createMessage(commandId);
    const result = new Promise<T>((resolve, reject) => {
      connection.commands.set(commandId, {
        resolve: value => resolve(value as T),
        reject,
      });
    });
    if (connection.socket?.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(message));
    else {
      connection.outgoing.push(message);
      this.connect(sessionId, connection);
    }
    return result;
  }

  private scheduleReconnect(sessionId: string, connection: AgentConnection): void {
    if (connection.reconnectTimer || connection.closed) return;
    this.changeState(connection, 'reconnecting');
    const delay = Math.min(1_000 * 2 ** connection.reconnectAttempt, 30_000);
    connection.reconnectAttempt += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      this.connect(sessionId, connection);
    }, delay);
  }

  private startHeartbeat(connection: AgentConnection, socket: WebSocket): void {
    this.clearTimers(connection);
    connection.pingTimer = setInterval(() => {
      if (connection.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'ping' } satisfies AgentClientMessage));
      if (connection.pongTimer) clearTimeout(connection.pongTimer);
      connection.pongTimer = setTimeout(() => socket.close(), 10_000);
    }, 30_000);
  }

  private clearTimers(connection: AgentConnection): void {
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    if (connection.pingTimer) clearInterval(connection.pingTimer);
    if (connection.pongTimer) clearTimeout(connection.pongTimer);
    connection.reconnectTimer = null;
    connection.pingTimer = null;
    connection.pongTimer = null;
  }

  // 连接打开后又断开时，命令可能已经被 Server 接收。此时只报告结果未知，
  // 不能自动重放 enqueue_input，否则同一条用户输入可能进入队列两次。
  private rejectCommands(connection: AgentConnection, code: string, message: string): void {
    const error = new AgentWebSocketCommandError(code, message);
    for (const pending of connection.commands.values()) pending.reject(error);
    connection.commands.clear();
    connection.outgoing.length = 0;
  }

  private changeState(connection: AgentConnection, state: AgentConnectionState): void {
    if (connection.state === state) return;
    connection.state = state;
    for (const handler of [...connection.stateHandlers]) handler(state);
  }
}

export const agentWebSocket = new AgentWebSockets();

export interface SpeechSocketHandlers {
  readonly onControl: (event: SpeechControlEvent) => void;
  readonly onAudio: (bytes: ArrayBuffer) => void;
  readonly onClosed: () => void;
}

export interface SpeechSocketHandle {
  sentencePlayed(sentenceId: string): void;
  cancel(): void;
}

export async function openSpeechSocket(turnId: string, handlers: SpeechSocketHandlers): Promise<SpeechSocketHandle> {
  const socket = new WebSocket(await serverClient.webSocketUrl(`/api/ws/speech/${encodeURIComponent(turnId)}`));
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => {
    if (event.data instanceof ArrayBuffer) {
      handlers.onAudio(event.data);
      return;
    }
    const control = parseSpeechControl(String(event.data));
    if (control) handlers.onControl(control);
  });
  socket.addEventListener('close', handlers.onClosed, { once: true });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Speech WebSocket connection failed')), { once: true });
  });
  return {
    sentencePlayed(sentenceId) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'sentence_played', sentenceId }));
    },
    cancel() {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel' }));
      socket.close(1000, 'speech_cancelled');
    },
  };
}

function parseSpeechControl(source: string): SpeechControlEvent | null {
  let value: unknown;
  try { value = JSON.parse(source); } catch { return null; }
  if (!value || typeof value !== 'object' || !('type' in value)) return null;
  const event = value as SpeechControlEvent;
  switch (event.type) {
    case 'sentence_started': return typeof event.sentenceId === 'string' && typeof event.mime === 'string' ? event : null;
    case 'sentence_completed': return typeof event.sentenceId === 'string' ? event : null;
    case 'sentence_failed': return typeof event.sentenceId === 'string' && typeof event.code === 'string' && typeof event.message === 'string' ? event : null;
    case 'speech_completed': return typeof event.audioAvailable === 'boolean' ? event : null;
    case 'speech_cancelled': return event;
    default: return null;
  }
}
