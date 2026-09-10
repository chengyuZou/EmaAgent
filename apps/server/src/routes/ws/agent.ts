// Agent WebSocket Route：按 Session 接收实时命令，并把 Turn 事件送往所有观察该 Session 的窗口。
import { CommandsError, type CommandCompactResult } from '@ema-agent/commands';
import type { AgentRunEvent, AgentRunExecutor } from '@ema-agent/agent';
import {
  SessionBusyError,
  type ActiveSessionExecution,
  type ActiveSessionRegistry,
  type SessionStore,
} from '@ema-agent/session';
import {
  hasTurnInput,
  type PendingInteraction,
  type SessionContinuationEvent,
  type SessionContinuationQueue,
  type SessionInteractionQueue,
  type TurnExecutor,
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

const enqueueInputPayloadSchema = z.object({
  executionProfile: z.enum(['chat', 'work']),
  narrativePolicy: z.enum(['auto', 'always', 'off']),
  input: z.array(inputPartSchema).min(1).max(REQUEST_VALUE_LIMITS.maxTurnContentParts),
  modelSelection: z.object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    thinkingEnabled: z.boolean(),
    thinkingEffort: z.enum(['low', 'medium', 'high', 'max']),
  }).optional(),
  knowledge: z.object({
    assetIds: z.array(z.string().min(1)).min(1).max(REQUEST_VALUE_LIMITS.maxTurnKbAssetScopes),
  }).optional(),
  ttsEnabled: z.boolean().optional(),
}).superRefine((payload, context) => {
  if (payload.input.filter(part => part.type === 'attachment').length > REQUEST_VALUE_LIMITS.maxTurnAttachments) {
    context.addIssue({ code: 'custom', path: ['input'], message: '附件数量超过单次 Turn 上限' });
  }
  if (payload.input.filter(part => part.type === 'skill_reference').length > 8) {
    context.addIssue({ code: 'custom', path: ['input'], message: 'Skill 数量超过单次 Turn 上限' });
  }
});

const commandIdSchema = z.string().min(1);
export const agentClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enqueue_input'), commandId: commandIdSchema, payload: enqueueInputPayloadSchema }),
  z.object({ type: z.literal('remove_queued_input'), commandId: commandIdSchema, id: z.string().uuid() }),
  z.object({ type: z.literal('guide_queued_input'), commandId: commandIdSchema, id: z.string().uuid() }),
  z.object({ type: z.literal('start_compaction'), commandId: commandIdSchema }),
  z.object({
    type: z.literal('respond_permission'),
    commandId: commandIdSchema,
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    action: z.enum(['allow', 'allowSession', 'deny']),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('respond_ask_user'),
    commandId: commandIdSchema,
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    answers: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal('cancel_ask_user'), commandId: commandIdSchema, turnId: z.string().min(1), toolCallId: z.string().min(1) }),
  z.object({ type: z.literal('cancel_execution'), commandId: commandIdSchema, executionId: z.string().min(1) }),
  z.object({ type: z.literal('cancel_tool'), commandId: commandIdSchema, turnId: z.string().min(1), toolCallId: z.string().min(1) }),
  z.object({ type: z.literal('cancel_agent_run'), commandId: commandIdSchema, agentRunId: z.string().uuid() }),
  z.object({ type: z.literal('ping') }),
]);

export type AgentClientMessage = z.infer<typeof agentClientMessageSchema>;
export type EnqueueInputPayload = z.infer<typeof enqueueInputPayloadSchema>;

export type AgentServerMessage =
  | { readonly type: 'connected'; readonly sessionId: string }
  | { readonly type: 'session_state'; readonly execution: ActiveSessionExecution | null }
  | { readonly type: 'pending_interactions'; readonly pending: readonly PendingInteraction[] }
  | SessionContinuationEvent
  | { readonly type: 'turn_event'; readonly turnId: string; readonly event: TurnStreamEvent }
  | { readonly type: 'agent_run_event'; readonly event: AgentRunEvent }
  | { readonly type: 'compaction_completed'; readonly commandId: string; readonly result: CommandCompactResult }
  | { readonly type: 'command_succeeded'; readonly commandId: string }
  | { readonly type: 'command_rejected'; readonly commandId: string; readonly code: string; readonly message: string }
  | { readonly type: 'pong' };

interface AgentSocket {
  send(message: AgentServerMessage): void;
}

/** Route 与 TurnFanout 共用的唯一连接表；只记录当前进程内实际打开的 WebSocket。 */
export class AgentSocketConnections {
  private readonly bySession = new Map<string, Set<AgentSocket>>();

  attach(sessionId: string, socket: AgentSocket): () => void {
    const sockets = this.bySession.get(sessionId) ?? new Set<AgentSocket>();
    sockets.add(socket);
    this.bySession.set(sessionId, sockets);
    return () => this.detach(sessionId, socket);
  }

  publish(sessionId: string, message: AgentServerMessage): void {
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

  private detach(sessionId: string, socket: AgentSocket): void {
    const sockets = this.bySession.get(sessionId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.bySession.delete(sessionId);
  }
}

export interface AgentWebSocketRouteDeps {
  readonly connections: AgentSocketConnections;
  readonly executor: TurnExecutor;
  readonly agentRuns: AgentRunExecutor;
  readonly continuations: SessionContinuationQueue;
  readonly sessions: Pick<SessionStore, 'sessionExists'>;
  readonly activeSessions: ActiveSessionRegistry;
  readonly interactions: SessionInteractionQueue;
  readonly compactSession: (sessionId: string) => Promise<CommandCompactResult>;
}

export const agentWebSocketRoute = (deps: AgentWebSocketRouteDeps) =>
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
        client.send({ type: 'connected', sessionId });
        client.send({ type: 'session_state', execution: deps.activeSessions.getActiveExecution(sessionId) ?? null });
        client.send({ type: 'pending_interactions', pending: deps.interactions.listPending(sessionId) });
        client.send({ type: 'queued_inputs', items: deps.continuations.list(sessionId) });
        // TODO: 真实使用若证明断线期间的增量不可接受，再设计按 Turn 游标的有界重放和缺口通知。
      },
      async onMessage(event, socket) {
        if (typeof event.data !== 'string') return;
        const parsed = agentClientMessageSchema.safeParse(parseJson(event.data));
        if (!parsed.success) {
          socket.close(1008, 'invalid_agent_message');
          return;
        }
        await handleClientMessage(deps, sessionId, parsed.data, socketClient(socket));
      },
      onClose() { detach?.(); },
      onError() { detach?.(); },
    };
  }));

function socketClient(socket: WSContext): AgentSocket {
  return { send(message) { socket.send(JSON.stringify(message)); } };
}

async function handleClientMessage(
  deps: AgentWebSocketRouteDeps,
  sessionId: string,
  message: AgentClientMessage,
  socket: AgentSocket,
): Promise<void> {
  if (message.type === 'ping') {
    socket.send({ type: 'pong' });
    return;
  }
  try {
    switch (message.type) {
      case 'enqueue_input': {
        if (!hasTurnInput(message.payload.input)) throw new AgentCommandError('empty_input', 'Turn 输入为空');
        deps.continuations.enqueue({
          sessionId,
          input: message.payload.input,
          selection: {
            executionProfile: message.payload.executionProfile,
            narrativePolicy: message.payload.narrativePolicy,
            ...(message.payload.modelSelection ? { modelSelection: message.payload.modelSelection } : {}),
            ...(message.payload.knowledge ? { knowledge: message.payload.knowledge } : {}),
            ttsEnabled: message.payload.ttsEnabled ?? false,
          },
        });
        socket.send({ type: 'command_succeeded', commandId: message.commandId });
        return;
      }
      case 'remove_queued_input':
        sendCommandResult(socket, message.commandId, deps.continuations.remove(sessionId, message.id));
        return;
      case 'guide_queued_input':
        sendCommandResult(socket, message.commandId, deps.continuations.guide(sessionId, message.id));
        return;
      case 'start_compaction': {
        const running = deps.compactSession(sessionId);
        publishExecutionState(deps, sessionId);
        const result = await running.finally(() => publishExecutionState(deps, sessionId));
        socket.send({ type: 'compaction_completed', commandId: message.commandId, result });
        return;
      }
      case 'respond_permission':
        sendCommandResult(socket, message.commandId, deps.interactions.respondPermission(
          message.toolCallId,
          message.action === 'deny'
            ? { action: 'deny', ...(message.reason ? { reason: message.reason } : {}) }
            : { action: message.action },
          message.turnId,
        ));
        return;
      case 'respond_ask_user':
        sendCommandResult(socket, message.commandId, deps.interactions.respondAskUser(message.toolCallId, message.answers, message.turnId));
        return;
      case 'cancel_ask_user':
        sendCommandResult(socket, message.commandId, deps.interactions.cancelAskUser(message.toolCallId, 'cancelled by user', message.turnId));
        return;
      case 'cancel_execution':
        sendCommandResult(socket, message.commandId, deps.activeSessions.abort(sessionId, message.executionId));
        return;
      case 'cancel_tool':
        sendCommandResult(socket, message.commandId, deps.executor.abortTool(message.turnId, message.toolCallId));
        return;
      case 'cancel_agent_run':
        sendCommandResult(socket, message.commandId, deps.agentRuns.cancel(message.agentRunId, sessionId));
        return;
    }
  } catch (error) {
    const failure = commandFailure(error);
    socket.send({ type: 'command_rejected', commandId: message.commandId, ...failure });
  }
}

function publishExecutionState(deps: AgentWebSocketRouteDeps, sessionId: string): void {
  deps.connections.publish(sessionId, {
    type: 'session_state',
    execution: deps.activeSessions.getActiveExecution(sessionId) ?? null,
  });
}

function sendCommandResult(socket: AgentSocket, commandId: string, accepted: boolean): void {
  socket.send(accepted
    ? { type: 'command_succeeded', commandId }
    : { type: 'command_rejected', commandId, code: 'not_found_or_expired', message: '目标已经结束或不属于当前执行' });
}

function commandFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AgentCommandError) return { code: error.code, message: error.message };
  if (error instanceof SessionBusyError) return { code: 'session_busy', message: error.message };
  if (error instanceof CommandsError) return { code: error.code.replace('/', '_'), message: error.message };
  if (error instanceof Error && error.message.startsWith('session_not_found')) {
    return { code: 'session_not_found', message: error.message };
  }
  console.warn('[agent-ws] 命令执行失败:', error);
  return { code: 'internal_error', message: 'Agent 命令执行失败' };
}

class AgentCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
