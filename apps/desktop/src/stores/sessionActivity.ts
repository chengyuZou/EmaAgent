import { create } from 'zustand';
import type { SessionRunning } from '@ema-agent/session';
import type {
  PendingInteraction,
  QueuedSessionInput,
  TurnStreamEvent,
} from '@ema-agent/turn';
import type { SessionConnectionState } from '../api/sessionWebSocket.js';

export interface SessionActivity {
  /** 断线只表示当前值未知, 不等于 Server 已经结束当前工作. */
  readonly connection: SessionConnectionState;
  /** Server 当前占用 Session 的根 Turn 或手动 Compact; 已收到 session_state 后 null 表示空闲. */
  readonly running: SessionRunning | null;
  /** 当前正在生成摘要的 Compact ID, 同时覆盖手动命令和根 Turn 自动压缩. */
  readonly activeCompactId: string | null;
  /** 仍等待用户处理的 Permission 和 AskUser, resolved 事件到达后按 toolCallId 删除. */
  readonly pendingInteractions: readonly PendingInteraction[];
  /** 这里只显示 after_turn 项; guide 成功后该项立即移入 Live Turn. */
  readonly queuedInputs: readonly QueuedSessionInput[];
}

interface SessionActivityStore {
  /** Chat 当前订阅的各 Session 活动事实, 不包含消息正文或 Live Turn 内容. */
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
  startCompact(sessionId: string, compactId: string): void;
  /** 仅结束对应 ID 的压缩, 不让迟到的终态清除下一次压缩. */
  finishCompact(sessionId: string, compactId: string): void;
  /** 流式 required/resolved 事件按 toolCallId 增删交互, 保持创建时间顺序. */
  applyInteractionEvent(sessionId: string, event: TurnStreamEvent): void;
  /** queued_input_added 到达时按 ID 替换并按创建时间排列, 防止重连事件显示两次. */
  addQueuedInput(sessionId: string, item: QueuedSessionInput): void;
  /** queued_input_removed 到达时删除队列气泡; guide 后的消息由 Live Turn 接管显示. */
  removeQueuedInput(sessionId: string, id: string): void;
  /** Session 已归档或删除时一次删除连接, 占用, 交互和队列视图. */
  evictSession(sessionId: string): void;
}

/** 尚未收到 session_state 时的占位值. running=null 在这里不能证明 Server 已经空闲. */
export const EMPTY_SESSION_ACTIVITY: SessionActivity = {
  connection: 'disconnected',
  running: null,
  activeCompactId: null,
  pendingInteractions: [],
  queuedInputs: [],
};

function updateSession(
  sessions: ReadonlyMap<string, SessionActivity>,
  sessionId: string,
  update: (current: SessionActivity) => SessionActivity,
): ReadonlyMap<string, SessionActivity> {
  const next = new Map(sessions);
  next.set(sessionId, update(sessions.get(sessionId) ?? EMPTY_SESSION_ACTIVITY));
  return next;
}

function sortPending(items: readonly PendingInteraction[]): PendingInteraction[] {
  return [...items].sort((left, right) => left.createdAt - right.createdAt);
}

function removePending(
  items: readonly PendingInteraction[],
  toolCallId: string,
): PendingInteraction[] {
  return items.filter(item => item.request.toolCallId !== toolCallId);
}

/** ChatInput, Sidebar 和 PendingInteractionView 共享的 Session 活动 Store. */
export const useSessionActivityStore = create<SessionActivityStore>(set => ({
  bySession: new Map(),

  // 连接与运行身份都来自 Session WebSocket, 断线时不把未知 running 强行改成 null.
  setConnection(sessionId, connection) {
    set(state => ({
      bySession: updateSession(state.bySession, sessionId, current => ({
        ...current,
        connection,
      })),
    }));
  },

  replaceSessionState(sessionId, running, pendingInteractions, queuedInputs) {
    set(state => ({
      bySession: updateSession(state.bySession, sessionId, current => ({
        ...current,
        running,
        activeCompactId: running?.kind === 'compact' ? running.compactId : null,
        pendingInteractions: sortPending(pendingInteractions),
        queuedInputs: [...queuedInputs]
          .sort((left, right) => left.createdAt - right.createdAt),
      })),
    }));
  },

  setRunning(sessionId, running) {
    set(state => ({
      bySession: updateSession(state.bySession, sessionId, current => {
        let activeCompactId = current.activeCompactId;
        if (running === null) activeCompactId = null;
        else if (running.kind === 'compact') activeCompactId = running.compactId;
        return { ...current, running, activeCompactId };
      }),
    }));
  },

  startCompact(sessionId, compactId) {
    set(state => ({
      bySession: updateSession(state.bySession, sessionId, current => ({
        ...current,
        activeCompactId: compactId,
      })),
    }));
  },

  finishCompact(sessionId, compactId) {
    set(state => ({
      bySession: updateSession(state.bySession, sessionId, current => (
        current.activeCompactId === compactId
          ? { ...current, activeCompactId: null }
          : current
      )),
    }));
  },

  applyInteractionEvent(sessionId, event) {
    set(state => ({
      bySession: updateSession(state.bySession, sessionId, current => {
        if (event.type === 'permission_required') {
          const { type: _type, ...request } = event;
          return {
            ...current,
            pendingInteractions: sortPending([
              ...removePending(current.pendingInteractions, event.toolCallId),
              {
                kind: 'permission',
                toolCallId: event.toolCallId,
                createdAt: Date.now(),
                request,
              },
            ]),
          };
        }
        if (event.type === 'ask_user_required') {
          return {
            ...current,
            pendingInteractions: sortPending([
              ...removePending(current.pendingInteractions, event.toolCallId),
              { kind: 'askUser', createdAt: Date.now(), request: event },
            ]),
          };
        }
        if (event.type === 'permission_resolved' || event.type === 'ask_user_resolved') {
          return {
            ...current,
            pendingInteractions: removePending(
              current.pendingInteractions,
              event.toolCallId,
            ),
          };
        }
        return current;
      }),
    }));
  },

  addQueuedInput(sessionId, item) {
    set(state => ({
      bySession: updateSession(state.bySession, sessionId, current => ({
        ...current,
        queuedInputs: [
          ...current.queuedInputs.filter(candidate => candidate.id !== item.id),
          item,
        ].sort((left, right) => left.createdAt - right.createdAt),
      })),
    }));
  },

  removeQueuedInput(sessionId, id) {
    set(state => ({
      bySession: updateSession(state.bySession, sessionId, current => ({
        ...current,
        queuedInputs: current.queuedInputs.filter(item => item.id !== id),
      })),
    }));
  },

  // 普通断开只更新 connection; Session 归档或删除才清掉整份活动视图.
  evictSession(sessionId) {
    set(state => {
      const bySession = new Map(state.bySession);
      bySession.delete(sessionId);
      return { bySession };
    });
  },
}));
