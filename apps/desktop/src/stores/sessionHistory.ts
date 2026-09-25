import { create } from 'zustand';
import type { SessionMessage } from '@ema-agent/session';
import {
  sessionsApi,
  type SessionMessagePage,
  type TurnIndexPage,
} from '../api/sessions.js';

type TurnIndexItem = TurnIndexPage['items'][number];
type SessionTurnStats = SessionMessagePage['turnStats'][number];
const MESSAGE_PAGE_SIZE = 50;
const TURN_INDEX_PAGE_SIZE = 200;
let nextWindowRequestId = 0;
const currentWindowRequestIds = new Map<string, number>();

export interface SessionHistoryState {
  /** 当前加载窗口内的持久化消息, 可能是最新一页, 也可能是 Turn 游标打开的锚点窗口. */
  readonly messages: readonly SessionMessage[];
  /** around 窗口的锚点 Message ID. 最新页为 undefined, MessageList 用它重建虚拟列表. */
  readonly windowAnchorMessageId?: string;
  /** 已加载 Turn 的最终 Token, 耗时和音频状态, AssistantMessage 只从这里读取落盘事实. */
  readonly turnStatsById: ReadonlyMap<string, SessionTurnStats>;
  /** 至少一次 History 请求已经成功; 空数组也可能是已加载完成的合法结果. */
  readonly loaded: boolean;
  /** 正在加载最新页或替换为锚点窗口, 这两种操作都会整体替换当前 messages. */
  readonly loading: boolean;
  /** 正在把更早一页合并到当前窗口头部. */
  readonly loadingOlder: boolean;
  /** 锚点窗口之后仍有消息时, 正在把下一页合并到当前窗口尾部. */
  readonly loadingNewer: boolean;
  /** 当前窗口之前仍有消息时, Server 返回并由 loadOlder 原样回传. */
  readonly olderCursor?: string;
  /** 当前窗口之后仍有消息时, Server 返回并由 loadNewer 原样回传. */
  readonly newerCursor?: string;
  /** TurnNavigationRail 已加载的 Turn 锚点, 与 messages 的分页窗口相互独立. */
  readonly turnIndexItems: readonly TurnIndexItem[];
  /** Turn 索引下一页游标; 没有值表示导航轨已经读到最早一轮. */
  readonly turnIndexNextCursor?: string;
  /** 至少一次 Turn 索引请求已经成功, reset/invalidate 后会重新请求第一页. */
  readonly turnIndexLoaded: boolean;
  /** Turn 索引第一页或后续页正在请求, 防止滚动重复发起同一页. */
  readonly turnIndexLoading: boolean;
  /** History 当前滚动经过的 Turn, TurnNavigationRail 用它高亮对应刻度. */
  readonly currentTurnId?: string;
  /** 最近一次 History 或 Turn 索引请求的可显示错误, 下一次替换请求开始时清除. */
  readonly error?: string;
}

interface HistoryStore {
  /** 每个打开或最近访问的 Session 各自保存一段 History 窗口和一份 Turn 索引. */
  readonly bySession: ReadonlyMap<string, SessionHistoryState>;
  /** user_message_stored 到达时按 Message ID 合入, 不等待 Turn 结束后整页重载. */
  appendMessage(sessionId: string, message: SessionMessage): void;
  /** 打开 Session 时读取最新一页; force 用于终态或失效通知后替换已经加载的最新窗口. */
  loadLatest(sessionId: string, force?: boolean): Promise<void>;
  /** 使用 Server 返回的 olderCursor 把更早消息合入头部. */
  loadOlder(sessionId: string): Promise<void>;
  /** 使用 Server 返回的 newerCursor 把更新消息合入尾部. */
  loadNewer(sessionId: string): Promise<void>;
  /** TurnNavigationRail 跳转时以真实 Message ID 重新加载前后有界的窗口. */
  openAround(sessionId: string, anchorMessageId: string): Promise<void>;
  /** 点击已加载 Message 时, 使仍在请求中的整窗替换不能覆盖这次导航. */
  cancelPendingWindowReplace(sessionId: string): void;
  /** Turn terminal 或音频归档变化后只重读该 Turn, 按 Message ID 和 turnId 合入当前窗口. */
  mergeTurnMessages(sessionId: string, turnId: string): Promise<void>;
  /** 读取 TurnNavigationRail 第一页; reset 会丢弃旧索引并以 Server 当前结果替换. */
  loadTurnIndex(sessionId: string, reset?: boolean): Promise<void>;
  /** 使用 turnIndexNextCursor 追加更早的 Turn, 已知 turnId 不重复加入. */
  loadMoreTurnIndex(sessionId: string): Promise<void>;
  /** History 滚动经过某轮时更新导航轨高亮, 不改变消息窗口. */
  setCurrentTurn(sessionId: string, turnId: string): void;
  /** Session 新增或删除 Turn 后让下次导航轨读取重新请求第一页. */
  invalidateTurnIndex(sessionId: string): void;
  /** terminal 合入或分页读取失败时把原因留在对应 Session 页面, 不删除仍在显示的 TurnState. */
  reportError(sessionId: string, message: string): void;
  /** Session 关闭, 归档或删除后清除消息窗口, Turn 统计和导航索引. */
  evictSession(sessionId: string): void;
}

/** Session 尚未读取 History 时的共享空值; 写入 Store 前始终通过 replace 创建新对象. */
export const EMPTY_SESSION_HISTORY: SessionHistoryState = {
  messages: [],
  turnStatsById: new Map(),
  loaded: false,
  loading: false,
  loadingOlder: false,
  loadingNewer: false,
  turnIndexItems: [],
  turnIndexLoaded: false,
  turnIndexLoading: false,
};

function replace(
  sessions: ReadonlyMap<string, SessionHistoryState>,
  sessionId: string,
  update: (current: SessionHistoryState) => SessionHistoryState,
): ReadonlyMap<string, SessionHistoryState> {
  const next = new Map(sessions);
  next.set(sessionId, update(sessions.get(sessionId) ?? EMPTY_SESSION_HISTORY));
  return next;
}

function mergeMessages(current: readonly SessionMessage[], incoming: readonly SessionMessage[]): SessionMessage[] {
  // 同一条消息可能先由 user_message_stored 到达, 随后又出现在 History 页里.
  // 按真实 Message ID 合并可以保留一次显示, createdAt + id 只负责稳定排序.
  const byId = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function mergeTurnStats(
  current: ReadonlyMap<string, SessionTurnStats>,
  incoming: readonly SessionTurnStats[],
): ReadonlyMap<string, SessionTurnStats> {
  const next = new Map(current);
  for (const stats of incoming) next.set(stats.turnId, stats);
  return next;
}

/** MessageList, TurnNavigationRail 和终态订阅共享的持久化 History Store. */
export const useSessionHistoryStore = create<HistoryStore>((set, get) => ({
  bySession: new Map(),

  // 落盘 UserMessage 可以在 Turn 运行期间到达, 立即按 ID 合入当前窗口.
  appendMessage(sessionId, message) {
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        messages: mergeMessages(value.messages, [message]),
      })),
    }));
  },

  // 最新页用于正常打开 Session; older/newer 在当前窗口两端追加, 不替换用户正在看的内容.
  async loadLatest(sessionId, force = false) {
    const current = get().bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY;
    if (current.loading || (current.loaded && !force)) return;
    const requestId = ++nextWindowRequestId;
    currentWindowRequestIds.set(sessionId, requestId);
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loading: true,
        error: undefined,
      })),
    }));
    try {
      const page = await sessionsApi.listMessages(sessionId, { limit: MESSAGE_PAGE_SIZE });
      if (currentWindowRequestIds.get(sessionId) !== requestId) return;
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => ({
          ...value,
          messages: page.messages,
          windowAnchorMessageId: undefined,
          turnStatsById: new Map(page.turnStats.map(stats => [stats.turnId, stats])),
          loaded: true,
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          olderCursor: page.olderCursor,
          newerCursor: undefined,
        })),
      }));
    } catch (error) {
      if (currentWindowRequestIds.get(sessionId) !== requestId) return;
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => ({
          ...value,
          loading: false,
          error: error instanceof Error ? error.message : '消息加载失败',
        })),
      }));
    }
  },

  async loadOlder(sessionId) {
    const current = get().bySession.get(sessionId);
    if (!current?.olderCursor || current.loadingOlder) return;
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loadingOlder: true,
      })),
    }));
    try {
      const page = await sessionsApi.listMessages(sessionId, {
        before: current.olderCursor,
        limit: MESSAGE_PAGE_SIZE,
      });
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => {
          if (
            value.windowAnchorMessageId !== current.windowAnchorMessageId
            || value.olderCursor !== current.olderCursor
          ) return value;
          return {
            ...value,
            messages: mergeMessages(value.messages, page.messages),
            turnStatsById: mergeTurnStats(value.turnStatsById, page.turnStats),
            loadingOlder: false,
            olderCursor: page.olderCursor,
          };
        }),
      }));
    } catch (error) {
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => (
          value.windowAnchorMessageId !== current.windowAnchorMessageId
          || value.olderCursor !== current.olderCursor
            ? value
            : {
              ...value,
              loadingOlder: false,
              error: error instanceof Error ? error.message : '更早消息加载失败',
            }
        )),
      }));
    }
  },

  async loadNewer(sessionId) {
    const current = get().bySession.get(sessionId);
    if (!current?.newerCursor || current.loadingNewer) return;
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loadingNewer: true,
      })),
    }));
    try {
      const page = await sessionsApi.listMessages(sessionId, {
        after: current.newerCursor,
        limit: MESSAGE_PAGE_SIZE,
      });
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => {
          if (
            value.windowAnchorMessageId !== current.windowAnchorMessageId
            || value.newerCursor !== current.newerCursor
          ) return value;
          return {
            ...value,
            messages: mergeMessages(value.messages, page.messages),
            turnStatsById: mergeTurnStats(value.turnStatsById, page.turnStats),
            loadingNewer: false,
            newerCursor: page.newerCursor,
          };
        }),
      }));
    } catch (error) {
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => (
          value.windowAnchorMessageId !== current.windowAnchorMessageId
          || value.newerCursor !== current.newerCursor
            ? value
            : {
              ...value,
              loadingNewer: false,
              error: error instanceof Error ? error.message : '更新消息加载失败',
            }
        )),
      }));
    }
  },

  // 导航轨跳转会用锚点窗口替换 messages, 后续向 newer 方向逐页回到 Session 最新位置.
  async openAround(sessionId, anchorMessageId) {
    const requestId = ++nextWindowRequestId;
    currentWindowRequestIds.set(sessionId, requestId);
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loading: true,
        error: undefined,
      })),
    }));
    try {
      const page = await sessionsApi.listMessagesAround(sessionId, {
        anchorMessageId,
        before: MESSAGE_PAGE_SIZE,
        after: MESSAGE_PAGE_SIZE,
      });
      if (currentWindowRequestIds.get(sessionId) !== requestId) return;
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => ({
          ...value,
          messages: page.messages,
          windowAnchorMessageId: anchorMessageId,
          turnStatsById: new Map(page.turnStats.map(stats => [stats.turnId, stats])),
          loaded: true,
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          olderCursor: page.olderCursor,
          newerCursor: page.newerCursor,
        })),
      }));
    } catch (error) {
      if (currentWindowRequestIds.get(sessionId) !== requestId) return;
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => ({
          ...value,
          loading: false,
          error: error instanceof Error ? error.message : '历史位置加载失败',
        })),
      }));
    }
  },

  cancelPendingWindowReplace(sessionId) {
    currentWindowRequestIds.set(sessionId, ++nextWindowRequestId);
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loading: false,
      })),
    }));
  },

  // Turn terminal 和音频归档变化只重读该 Turn, 避免整页 History 再渲染一次.
  async mergeTurnMessages(sessionId, turnId) {
    const result = await sessionsApi.listTurnMessages(sessionId, turnId);
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        messages: mergeMessages(value.messages, result.messages),
        turnStatsById: mergeTurnStats(value.turnStatsById, result.turnStats),
        error: undefined,
      })),
    }));
  },

  // Turn 索引与 Message 分页分开读取, 导航轨滚动不会改变正文窗口.
  async loadTurnIndex(sessionId, reset = false) {
    const current = get().bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY;
    if (current.turnIndexLoading || (current.turnIndexLoaded && !reset)) return;
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        turnIndexLoading: true,
        error: undefined,
      })),
    }));
    try {
      const page = await sessionsApi.listTurnIndex(sessionId, { limit: TURN_INDEX_PAGE_SIZE });
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => ({
          ...value,
          turnIndexItems: page.items,
          turnIndexNextCursor: page.nextCursor,
          turnIndexLoaded: true,
          turnIndexLoading: false,
        })),
      }));
    } catch (error) {
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => ({
          ...value,
          turnIndexLoading: false,
          error: error instanceof Error ? error.message : 'Turn 索引加载失败',
        })),
      }));
    }
  },

  async loadMoreTurnIndex(sessionId) {
    const current = get().bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY;
    if (current.turnIndexLoading || !current.turnIndexNextCursor) return;
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        turnIndexLoading: true,
        error: undefined,
      })),
    }));
    try {
      const page = await sessionsApi.listTurnIndex(sessionId, {
        cursor: current.turnIndexNextCursor,
        limit: TURN_INDEX_PAGE_SIZE,
      });
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => {
          const known = new Set(value.turnIndexItems.map(item => item.turnId));
          return {
            ...value,
            turnIndexItems: [
              ...value.turnIndexItems,
              ...page.items.filter(item => !known.has(item.turnId)),
            ],
            turnIndexNextCursor: page.nextCursor,
            turnIndexLoaded: true,
            turnIndexLoading: false,
          };
        }),
      }));
    } catch (error) {
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => ({
          ...value,
          turnIndexLoading: false,
          error: error instanceof Error ? error.message : '更多 Turn 加载失败',
        })),
      }));
    }
  },

  // 这两个入口只改变导航轨状态; Session 清理则删除消息, 统计和索引的整份记录.
  setCurrentTurn(sessionId, turnId) {
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => (
        value.currentTurnId === turnId
          ? value
          : { ...value, currentTurnId: turnId }
      )),
    }));
  },

  invalidateTurnIndex(sessionId) {
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        turnIndexLoaded: false,
      })),
    }));
  },

  reportError(sessionId, message) {
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        error: message,
      })),
    }));
  },

  evictSession(sessionId) {
    currentWindowRequestIds.delete(sessionId);
    set(state => {
      const bySession = new Map(state.bySession);
      bySession.delete(sessionId);
      return { bySession };
    });
  },
}));
