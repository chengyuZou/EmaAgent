// Session WebSocket 接收 Chat 请求, 并把该 Session 的运行状态和业务事件发给已打开的窗口.
import { CommandsError, type ManualCompactResult } from '@ema-agent/commands';
import type { CompactEvent } from '@ema-agent/compact';
import type { SubagentEvent, SubagentExecutor } from '@ema-agent/agent';
import type { PermissionResponse } from '@ema-agent/permission';
import {
  SessionBusyError,
  type NarrativePolicy,
  type SessionMode,
  type SessionRunning,
  type SessionRunningRegistry,
  type SessionMessage,
  type SessionStore,
} from '@ema-agent/session';
import {
  hasTurnInput,
  type PendingInteraction,
  type QueuedSessionInput,
  type SessionContinuationEvent,
  type SessionContinuationQueue,
  type SessionInteractionQueue,
  type TurnExecutor,
  type TurnHandle,
  type TurnStore,
  type TurnStreamEvent,
} from '@ema-agent/turn';
import { upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { REQUEST_VALUE_LIMITS } from '../../platform/requestBudget.js';

const attachmentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('image_reference'), path: z.string().min(1), name: z.string().min(1).optional() }),
  z.object({ type: z.literal('pasted_text_reference'), path: z.string().min(1), preview: z.string() }),
  z.object({ type: z.literal('file_reference'), path: z.string().min(1) }),
]);

const inputPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(REQUEST_VALUE_LIMITS.maxTurnTextChars) }),
  z.object({ type: z.literal('attachment'), block: attachmentBlockSchema }),
  z.object({ type: z.literal('skill_reference'), name: z.string().min(1), path: z.string().min(1) }),
]);

const userMessagePayloadSchema = z.object({
  sessionMode: z.enum(['chat', 'work']),
  narrativePolicy: z.enum(['auto', 'always', 'off']),
  input: z.array(inputPartSchema).min(1).max(REQUEST_VALUE_LIMITS.maxTurnContentParts),
  knowledge: z.object({
    assetIds: z.array(z.string().min(1)).min(1).max(REQUEST_VALUE_LIMITS.maxTurnKbAssetScopes),
  }).optional(),
}).superRefine((payload, context) => {
  if (payload.input.filter(part => part.type === 'attachment').length > REQUEST_VALUE_LIMITS.maxTurnAttachments) {
    context.addIssue({ code: 'custom', path: ['input'], message: '附件数量超过单次 Turn 上限' });
  }
  if (payload.input.filter(part => part.type === 'skill_reference').length > 8) {
    context.addIssue({ code: 'custom', path: ['input'], message: 'Skill 数量超过单次 Turn 上限' });
  }
});

const requestIdSchema = z.string().min(1);
export const sessionClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send_user_message'), requestId: requestIdSchema, payload: userMessagePayloadSchema }),
  z.object({ type: z.literal('queue_user_message'), requestId: requestIdSchema, payload: userMessagePayloadSchema }),
  z.object({ type: z.literal('remove_queued_input'), requestId: requestIdSchema, id: z.string().uuid() }),
  z.object({ type: z.literal('guide_queued_input'), requestId: requestIdSchema, id: z.string().uuid() }),
  z.object({ type: z.literal('start_compaction'), requestId: requestIdSchema }),
  z.object({
    type: z.literal('respond_permission'),
    requestId: requestIdSchema,
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    action: z.enum(['allow', 'allowSession', 'deny']),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('respond_ask_user'),
    requestId: requestIdSchema,
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    answers: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal('cancel_ask_user'), requestId: requestIdSchema, turnId: z.string().min(1), toolCallId: z.string().min(1) }),
  z.object({ type: z.literal('cancel_turn'), requestId: requestIdSchema, turnId: z.string().min(1) }),
  z.object({ type: z.literal('cancel_compact'), requestId: requestIdSchema, compactId: z.string().min(1) }),
  z.object({ type: z.literal('cancel_tool'), requestId: requestIdSchema, turnId: z.string().min(1), toolCallId: z.string().min(1) }),
  z.object({ type: z.literal('cancel_subagent'), requestId: requestIdSchema, subagentId: z.string().min(1) }),
  z.object({ type: z.literal('ping') }),
]);

/**
 * Desktop 为每次需要结果的 Session 请求生成. Server 在成功或失败结果中原样返回,
 * Desktop 据此结束对应的等待 Promise. ping/pong 没有业务 Promise, 因此不使用该 ID.
 */
export type ClientRequestId = string;
/** Desktop 可以通过单个 Session WebSocket 发给 Server 的全部 JSON 消息. */
export type SessionClientMessage = z.infer<typeof sessionClientMessageSchema>;
/**
 * send_user_message 和 queue_user_message 共用的输入内容. 直接发送或排队由外层消息 type 决定,
 * payload 不再携带 delivery 字段.
 */
export type UserMessagePayload = z.infer<typeof userMessagePayloadSchema>;

/** TurnStreamEvent 原样传输. 已落库的 user_message_stored 走 Session 消息分支. */
type SessionTurnMessage = {
  readonly type: 'turn_event';
  readonly turnId: string;
  readonly event: Exclude<TurnStreamEvent, { readonly type: 'user_message_stored' }>;
};

/**
 * Server 主动发给一个 Session 的当前状态和后续变化. 它们不回答某一次 Client 请求,
 * 因此没有 requestId; 同一 Session 的多个观察窗口会收到相同变化.
 */
export type SessionBusinessMessage =
  | {
      /** 每次 Socket 打开只发送一次, Desktop 用它替换该 Session 的连接当前值. */
      readonly type: 'session_state';
      readonly running:
        | null
        | {
            readonly kind: 'turn';
            readonly turnId: string;
            readonly createdAt: number;
            readonly sessionMode: SessionMode;
            readonly narrativePolicy: NarrativePolicy;
            readonly messages: readonly SessionMessage[];
          }
        | {
            readonly kind: 'compact';
            readonly compactId: string;
          };
      readonly pendingInteractions: readonly PendingInteraction[];
      readonly queuedInputs: readonly QueuedSessionInput[];
    }
  | {
      /** 已连接期间根 Turn 或手动 Compact 的注册和清除变化. */
      readonly type: 'session_running_changed';
      readonly running: SessionRunning | null;
    }
  | {
      /** 真实 UserMessage 已写入 History, Desktop 按保存顺序交给当前 Turn 或持久 History. */
      readonly type: 'user_message_stored';
      readonly message: SessionMessage;
    }
  | CompactEvent
  | SessionContinuationEvent
  | SessionTurnMessage
  | {
      /** Subagent 的增量和终态, Desktop 只更新子代理 Store, 不混入根 Turn 的消息投影. */
      readonly type: 'subagent_event';
      readonly event: SubagentEvent;
    };

/**
 * Server 可以通过 Session WebSocket 发给 Desktop 的全部 JSON 消息: Session 主动推送、
 * 请求成功或失败结果、手动 Compact 结果和心跳 pong.
 */
export type SessionServerMessage =
  | SessionBusinessMessage
  | {
      /** 回答 start_compaction; afterTokens 只用于结果提示, Context 球另按有效历史重估. */
      readonly type: 'manual_compact_result';
      readonly requestId: ClientRequestId;
      readonly result: ManualCompactResult;
    }
  | {
      /** 回答没有额外结果数据的 Client 请求, Desktop 据 requestId 结束对应 Promise. */
      readonly type: 'request_succeeded';
      readonly requestId: ClientRequestId;
    }
  | {
      /** 请求没有执行或执行失败, Desktop 据 requestId 拒绝对应 Promise 并向当前操作显示错误. */
      readonly type: 'request_rejected';
      readonly requestId: ClientRequestId;
      readonly code: string;
      readonly message: string;
    }
  | {
      /** 回答 ping, 只证明当前 Socket 仍能双向传输, 不对应业务请求. */
      readonly type: 'pong';
    };

interface SessionSocket {
  send(message: SessionServerMessage): void;
}

/** Session Route 与 TurnFanout 共用此连接表, 同一 Session 可以被多个窗口同时观察. */
export class SessionSocketConnections {
  private readonly bySession = new Map<string, Set<SessionSocket>>();

  attach(sessionId: string, socket: SessionSocket): () => void {
    const sockets = this.bySession.get(sessionId) ?? new Set<SessionSocket>();
    sockets.add(socket);
    this.bySession.set(sessionId, sockets);
    return () => this.detach(sessionId, socket);
  }

  publish(sessionId: string, message: SessionBusinessMessage): void {
    const sockets = this.bySession.get(sessionId);
    if (!sockets) return;
    for (const socket of [...sockets]) {
      try {
        socket.send(message);
      } catch {
        sockets.delete(socket);
      }
    }
    if (sockets.size === 0) this.bySession.delete(sessionId);
  }

  private detach(sessionId: string, socket: SessionSocket): void {
    const sockets = this.bySession.get(sessionId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.bySession.delete(sessionId);
  }
}

export interface SessionWebSocketRouteDeps {
  readonly connections: SessionSocketConnections;
  readonly executor: TurnExecutor;
  readonly subagents: SubagentExecutor;
  readonly continuations: SessionContinuationQueue;
  readonly sessions: Pick<SessionStore, 'sessionExists' | 'getSession' | 'loadMessagesForTurn'>;
  readonly turns: Pick<TurnStore, 'getTurn'>;
  readonly sessionRunning: SessionRunningRegistry;
  readonly interactions: SessionInteractionQueue;
  readonly compactSession: (sessionId: string) => Promise<ManualCompactResult>;
  readonly attachTurn: (handle: TurnHandle) => void;
}

export const sessionWebSocketRoute = (deps: SessionWebSocketRouteDeps) =>
  new Hono().get('/:sessionId', upgradeWebSocket(context => {
    const sessionId = context.req.param('sessionId')!;
    let detach: (() => void) | undefined;
    return {
      onOpen(_event, socket) {
        if (!deps.sessions.sessionExists(sessionId)) {
          socket.close(1008, 'session_not_found');
          return;
        }
        const client = socketClient(socket);
        detach = deps.connections.attach(sessionId, client);
        client.send({
          type: 'session_state',
          running: readSessionRunningState(deps, sessionId),
          pendingInteractions: deps.interactions.listPending(sessionId),
          queuedInputs: deps.continuations.list(sessionId)
            .filter(item => item.delivery === 'after_turn'),
        });
        // TODO: 真实使用若证明断线期间的增量不可接受，再设计按 Turn 游标的有界重放和缺口通知。
      },
      async onMessage(event, socket) {
        if (typeof event.data !== 'string') return;
        const parsed = sessionClientMessageSchema.safeParse(parseJson(event.data));
        if (!parsed.success) {
          socket.close(1008, 'invalid_session_message');
          return;
        }
        await handleClientMessage(deps, sessionId, parsed.data, socketClient(socket));
      },
      onClose() { detach?.(); },
      onError() { detach?.(); },
    };
  }));

function socketClient(socket: WSContext): SessionSocket {
  return { send(message) { socket.send(JSON.stringify(message)); } };
}

async function handleClientMessage(
  deps: SessionWebSocketRouteDeps,
  sessionId: string,
  message: SessionClientMessage,
  socket: SessionSocket,
): Promise<void> {
  if (message.type === 'ping') {
    socket.send({ type: 'pong' });
    return;
  }
  try {
    switch (message.type) {
      case 'send_user_message': {
        if (!hasTurnInput(message.payload.input)) throw new SessionRequestError('empty_input', 'Turn 输入为空');
        // 发送消息只提交内容; 新 Turn 的语音选择从该 Session 的已保存设置读取.
        const ttsEnabled = deps.sessions.getSession(sessionId).ttsEnabled;
        const handle = deps.executor.start({
          sessionId,
          triggerType: 'userMessage',
          sessionMode: message.payload.sessionMode,
          narrativePolicy: message.payload.narrativePolicy,
          ttsEnabled,
          input: message.payload.input,
          ...(message.payload.knowledge ? { knowledge: message.payload.knowledge } : {}),
        });
        deps.attachTurn(handle);
        socket.send({ type: 'request_succeeded', requestId: message.requestId });
        return;
      }
      case 'queue_user_message': {
        if (!hasTurnInput(message.payload.input)) throw new SessionRequestError('empty_input', 'Turn 输入为空');
        if (deps.sessionRunning.getRunning(sessionId)?.kind !== 'turn') {
          throw new SessionRequestError('session_idle', '当前 Session 没有运行中的 Turn');
        }
        deps.continuations.enqueue({
          sessionId,
          input: message.payload.input,
          selection: {
            sessionMode: message.payload.sessionMode,
            narrativePolicy: message.payload.narrativePolicy,
            ...(message.payload.knowledge ? { knowledge: message.payload.knowledge } : {}),
          },
        });
        socket.send({ type: 'request_succeeded', requestId: message.requestId });
        return;
      }
      case 'remove_queued_input':
        sendRequestResult(socket, message.requestId, deps.continuations.remove(sessionId, message.id));
        return;
      case 'guide_queued_input':
        sendRequestResult(socket, message.requestId, deps.continuations.guide(sessionId, message.id));
        return;
      case 'start_compaction': {
        const result = await deps.compactSession(sessionId);
        socket.send({ type: 'manual_compact_result', requestId: message.requestId, result });
        return;
      }
      case 'respond_permission': {
        let response: PermissionResponse;
        if (message.action === 'deny') {
          response = message.reason
            ? { action: 'deny', reason: message.reason }
            : { action: 'deny' };
        } else {
          response = { action: message.action };
        }
        sendRequestResult(socket, message.requestId, deps.interactions.respondPermission(
          message.toolCallId,
          response,
          message.turnId,
        ));
        return;
      }
      case 'respond_ask_user':
        sendRequestResult(
          socket,
          message.requestId,
          deps.interactions.respondAskUser(
            message.toolCallId,
            message.answers,
            message.turnId,
          ),
        );
        return;
      case 'cancel_ask_user':
        sendRequestResult(
          socket,
          message.requestId,
          deps.interactions.cancelAskUser(
            message.toolCallId,
            'cancelled by user',
            message.turnId,
          ),
        );
        return;
      case 'cancel_turn':
        sendRequestResult(socket, message.requestId, deps.sessionRunning.abort(
          sessionId,
          { kind: 'turn', turnId: message.turnId },
        ));
        return;
      case 'cancel_compact':
        sendRequestResult(socket, message.requestId, deps.sessionRunning.abort(
          sessionId,
          { kind: 'compact', compactId: message.compactId },
        ));
        return;
      case 'cancel_tool':
        sendRequestResult(socket, message.requestId, deps.executor.abortTool(message.turnId, message.toolCallId));
        return;
      case 'cancel_subagent':
        sendRequestResult(socket, message.requestId, deps.subagents.cancel(message.subagentId, sessionId));
        return;
    }
  } catch (error) {
    const failure = commandFailure(error);
    socket.send({ type: 'request_rejected', requestId: message.requestId, ...failure });
  }
}

function readSessionRunningState(
  deps: SessionWebSocketRouteDeps,
  sessionId: string,
): Extract<SessionBusinessMessage, { readonly type: 'session_state' }>['running'] {
  const running = deps.sessionRunning.getRunning(sessionId);
  if (!running || running.kind === 'compact') return running ?? null;

  const turn = deps.turns.getTurn(running.turnId);
  if (!turn) throw new Error(`running_turn_not_found: ${running.turnId}`);
  return {
    kind: 'turn',
    turnId: running.turnId,
    createdAt: turn.createdAt,
    sessionMode: turn.sessionMode,
    narrativePolicy: turn.narrativePolicy,
    messages: deps.sessions.loadMessagesForTurn(running.turnId),
  };
}

function sendRequestResult(socket: SessionSocket, requestId: ClientRequestId, accepted: boolean): void {
  socket.send(accepted
    ? { type: 'request_succeeded', requestId }
    : { type: 'request_rejected', requestId, code: 'not_found_or_expired', message: '目标已经结束或不属于当前工作' });
}

function commandFailure(error: unknown): { code: string; message: string } {
  if (error instanceof SessionRequestError) return { code: error.code, message: error.message };
  if (error instanceof SessionBusyError) return { code: 'session_busy', message: error.message };
  if (error instanceof CommandsError) return { code: error.code.replace('/', '_'), message: error.message };
  if (error instanceof Error && error.message.startsWith('session_not_found')) {
    return { code: 'session_not_found', message: error.message };
  }
  console.warn('[session-ws] 请求执行失败:', error);
  return { code: 'internal_error', message: 'Session 请求执行失败' };
}

class SessionRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
