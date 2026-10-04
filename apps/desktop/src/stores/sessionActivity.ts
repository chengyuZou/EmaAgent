import { create } from 'zustand';
import type { SessionRunning } from '@ema-agent/session';
import type { PermissionStreamEvent } from '@ema-agent/permission';
import type { AskUserRequiredEvent, ToolExecutionEvent } from '@ema-agent/tools';
import type { PendingInteraction, QueuedSessionInput } from '@ema-agent/turn';
import type { SessionConnectionState } from '../api/sessionWebSocket.js';

export interface SessionActivity {
  /** 断线只表示当前值未知, 不等于 Server 已经结束当前工作. */
  readonly connection: SessionConnectionState;
  /** Server 当前占用 Session 的根 Turn 或手动 Compact; 已收到 session_state 后 null 表示空闲. */
  readonly running: SessionRunning | null;
  /** 当前正在生成摘要的 Compact, 同时覆盖手动命令和根 Turn 自动压缩. */
  readonly activeCompact: ActiveCompact | null;
  /** 仍等待用户处理的 Permission 和 AskUser, resolved 事件到达后按 toolCallId 删除. */
  readonly pendingInteractions: readonly PendingInteraction[];
  /** 这里只显示 after_turn 项; guide 成功后该项立即移入当前 Turn. */
  readonly queuedInputs: readonly QueuedSessionInput[];
}

export interface ActiveCompact {
  readonly compactId: string;
  /** session_state 只能恢复运行身份, 只有实时 compact_started 带准确开始时间. */
  readonly startedAt: number | null;
}

interface SessionActivityStore {
  /** Chat 当前订阅的各 Session 活动事实, 不包含消息正文或 Turn Store 内容. */
  readonly bySession: ReadonlyMap<string, SessionActivity>;
  /** Session WebSocket 状态变化时写入, ChatInput 和 Sidebar 用它显示断线而不是伪造 idle. */
  setConnection(sessionId: string, connection: SessionConnectionState): void;
  /** Socket 打开后一次替换 Server 给出的运行、交互和队列当前值, 不暴露三轮中间状态. */
  replaceSessionState(
    sessionId: string,
    running: SessionRunning | null,
    pendingInteractions: readonly PendingInteraction[],
    queuedInputs: readonly QueuedSessionInput[],
  ): void;
  /** session_running_changed 到达时原样保存 Server 的 Turn/Compact 占用身份. */
  setRunning(sessionId: string, running: SessionRunning | null): void;
  /** 两种启动方式的 compact_started 最终都写入这一份会话级展示状态. */
  startCompact(
    sessionId: string,
    compactId: string,
    startedAt: number
  ): void;
  /** 仅结束对应 ID 的压缩, 不让迟到的终态清除下一次压缩. */
  finishCompact(sessionId: string, compactId: string): void;
  /** Session required/resolved 按 toolCallId 增删, 保持 Server 交付的 FIFO 顺序. */
  applyInteractionEvent(
    sessionId: string,
    event: PermissionStreamEvent | AskUserRequiredEvent | Extract<ToolExecutionEvent, { type: 'ask_user_resolved' }>
  ): void;
  /** queued_input_added 到达时按 ID 替换并按创建时间排列, 防止重连事件显示两次. */
  addQueuedInput(sessionId: string, item: QueuedSessionInput): void;
  /** queued_input_removed 到达时删除队列气泡; guide 后的消息由 Turn Store 接管显示. */
  removeQueuedInput(sessionId: string, id: string): void;
  /** Session 已归档或删除时一次删除连接, 占用, 交互和队列视图. */
  evictSession(sessionId: string): void;
}

/** 尚未收到 session_state 时的占位值. running=null 在这里不能证明 Server 已经空闲. */
export const EMPTY_SESSION_ACTIVITY: SessionActivity = {
  connection: 'disconnected',
  running: null,
  activeCompact: null,
  pendingInteractions: [],
  queuedInputs: [],
};

function updateSession(
  state: SessionActivityStore,
  sessionId: string,
  update: (current: SessionActivity) => SessionActivity,
): SessionActivityStore | { bySession: ReadonlyMap<string, SessionActivity> } {
  const current = state.bySession.get(sessionId) ?? EMPTY_SESSION_ACTIVITY;
  const updated = update(current);
  if (updated === current) {
    return state;
  }
  const bySession = new Map(state.bySession);
  bySession.set(sessionId, updated);
  return { bySession };
}

function removePending(items: readonly PendingInteraction[], toolCallId: string): PendingInteraction[] {
  return items.filter(item => item.request.toolCallId !== toolCallId);
}

/** ChatInput, Sidebar 和 PendingInteractionView 共享的 Session 活动 Store. */
export const useSessionActivityStore = create<SessionActivityStore>(set => ({
  bySession: new Map(),

  // 连接与运行身份都来自 Session WebSocket, 断线时不把未知 running 强行改成 null.
  setConnection(sessionId, connection) {
    set(state => updateSession(
      state,
      sessionId,
      current => (
        current.connection === connection
          ? current
          : { ...current, connection }
      )
    ));
  },

  replaceSessionState(
    sessionId,
    running,
    pendingInteractions,
    queuedInputs
  ) {
    set(state => updateSession(
      state,
      sessionId,
      current => ({
        ...current,
        running,
        activeCompact: running?.kind === 'compact'
          ? { compactId: running.compactId, startedAt: null }
          : null,
        pendingInteractions: [...pendingInteractions],
        queuedInputs: [...queuedInputs]
          .sort((left, right) => left.createdAt - right.createdAt),
      })
    ));
  },

  setRunning(sessionId, running) {
    set(state => updateSession(state, sessionId, current => {
      let activeCompact: ActiveCompact | null = null;
      if (running?.kind === 'compact') {
        activeCompact = current.activeCompact?.compactId === running.compactId
          ? current.activeCompact
          : { compactId: running.compactId, startedAt: null };
      }
      if (current.running === running && current.activeCompact === activeCompact) {
        return current;
      }
      return { ...current, running, activeCompact };
    }));
  },

  startCompact(sessionId, compactId, startedAt) {
    set(state => updateSession(
      state,
      sessionId,
      current => (
        current.activeCompact?.compactId === compactId
          && current.activeCompact.startedAt === startedAt
          ? current
          : { ...current, activeCompact: { compactId, startedAt } }
      )
    ));
  },

  finishCompact(sessionId, compactId) {
    set(state => updateSession(
      state,
      sessionId,
      current => (
        current.activeCompact?.compactId === compactId
          ? { ...current, activeCompact: null }
          : current
      )
    ));
  },

  applyInteractionEvent(sessionId, event) {
    if (
      event.type !== 'permission_required'
      && event.type !== 'permission_resolved'
      && event.type !== 'ask_user_required'
      && event.type !== 'ask_user_resolved'
    ) {
      return;
    }
    set(state => updateSession(state, sessionId, current => {
      if (event.type === 'permission_required') {
        const { type: _type, ...request } = event;
        return {
          ...current,
          pendingInteractions: [
            ...removePending(current.pendingInteractions, event.toolCallId),
            {
              kind: 'permission',
              toolCallId: event.toolCallId,
              createdAt: Date.now(),
              request,
            },
          ],
        };
      }
      if (event.type === 'ask_user_required') {
        return {
          ...current,
          pendingInteractions: [
            ...removePending(current.pendingInteractions, event.toolCallId),
            { kind: 'askUser', createdAt: Date.now(), request: event },
          ],
        };
      }
      if (event.type === 'permission_resolved' || event.type === 'ask_user_resolved') {
        if (!current.pendingInteractions.some(item => item.request.toolCallId === event.toolCallId)) {
          return current;
        }
        return { ...current, pendingInteractions: removePending(current.pendingInteractions, event.toolCallId) };
      }
      return current;
    }));
  },

  addQueuedInput(sessionId, item) {
    set(state => updateSession(
      state,
      sessionId,
      current => ({
        ...current,
        queuedInputs: [...current.queuedInputs.filter(candidate => candidate.id !== item.id), item].sort((left, right) => left.createdAt - right.createdAt),
      })
    ));
  },

  removeQueuedInput(sessionId, id) {
    set(state => updateSession(
      state,
      sessionId,
      current => (
        current.queuedInputs.some(item => item.id === id)
          ? { ...current, queuedInputs: current.queuedInputs.filter(item => item.id !== id) }
          : current
      )
    ));
  },

  // 普通断开只更新 connection; Session 归档或删除才清掉整份活动视图.
  evictSession(sessionId) {
    set(state => {
      if (!state.bySession.has(sessionId)) {
        return state;
      }
      const bySession = new Map(state.bySession);
      bySession.delete(sessionId);
      return { bySession };
    });
  },
}));
