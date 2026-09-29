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
interface HistoryWindowRequest {
  readonly arrivedMessages: Map<string, SessionMessage>;
  readonly arrivedTurnStats: Map<string, SessionTurnStats>;
}
// 对象身份使旧请求失效; 两份临时事实只在窗口读取期间使用, 提交后清空.
const currentWindowRequests = new Map<string, HistoryWindowRequest>();

function windowRequest(): HistoryWindowRequest {
  return { arrivedMessages: new Map(), arrivedTurnStats: new Map() };
}

function clearArrivals(request: HistoryWindowRequest): void {
  request.arrivedMessages.clear();
  request.arrivedTurnStats.clear();
}

export interface SessionHistoryState {
  /** 当前加载窗口内的持久化消息, 可能是最新一页, 也可能是 Turn 游标打开的锚点窗口. */
  readonly messages: readonly SessionMessage[];
  /** 成功整窗替换后产生的新身份. 普通翻页不改变它, 同锚点重开也不复用旧测量. */
  readonly windowId?: string;
  /** around 的初始定位目标. 是否已连到最新位置由 newerCursor 决定. */
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
  /** 该方向失败后暂停自动分页, 只有用户点击重试才重新请求. */
  readonly olderError?: string;
  readonly newerError?: string;
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
  /** 点击已加载 Message 时, 使正在读取的窗口替换和分页都不能覆盖这次导航. */
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
  const current = sessions.get(sessionId) ?? EMPTY_SESSION_HISTORY;
  const updated = update(current);
  if (updated === current) return sessions;
  const next = new Map(sessions);
  next.set(sessionId, updated);
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
  messages: readonly SessionMessage[],
): ReadonlyMap<string, SessionTurnStats> {
  const retainedTurns = new Set(messages.map(message => message.turnId));
  const next = new Map([...current].filter(([turnId]) => retainedTurns.has(turnId)));
  for (const stats of incoming) {
    if (retainedTurns.has(stats.turnId)) next.set(stats.turnId, stats);
  }
  return next;
}

function compareMessages(left: SessionMessage, right: SessionMessage): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

/** 实时事实只更新窗口内消息; 连到最新时才允许扩展尾部, 工具结果按调用关系保留. */
function mergeWindowMessages(
  window: SessionHistoryState,
  incoming: readonly SessionMessage[],
): SessionMessage[] {
  const first = window.messages[0];
  const last = window.messages.at(-1);
  const knownIds = new Set(window.messages.map(message => message.id));
  const selected = incoming.filter(message => {
    if (knownIds.has(message.id) || !window.loaded) return true;
    if (first && compareMessages(message, first) < 0) return false;
    return !window.newerCursor || Boolean(last && compareMessages(message, last) <= 0);
  });
  const toolCallIds = new Set<string>();
  for (const message of [...window.messages, ...selected]) {
    if (!Array.isArray(message.blocks)) continue;
    for (const block of message.blocks) {
      if (block.type === 'tool_use') toolCallIds.add(block.id);
    }
  }
  for (const message of incoming) {
    if (selected.includes(message) || message.kind !== 'tool_results' || !Array.isArray(message.blocks)) continue;
    if (message.blocks.some(block => block.type === 'tool_result' && toolCallIds.has(block.toolCallId))) {
      selected.push(message);
    }
  }
  return mergeMessages(window.messages, selected);
}

/** MessageList, TurnNavigationRail 和终态订阅共享的持久化 History Store. */
export const useSessionHistoryStore = create<HistoryStore>((set, get) => ({
  bySession: new Map(),

  // 落盘 UserMessage 可以在 Turn 运行期间到达, 立即按 ID 合入当前窗口.
  appendMessage(sessionId, message) {
    const current = get().bySession.get(sessionId);
    if (current?.loading || current?.loadingNewer) {
      currentWindowRequests.get(sessionId)?.arrivedMessages.set(message.id, message);
    }
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        messages: mergeWindowMessages(value, [message]),
      })),
    }));
  },

  // 最新页用于正常打开 Session; older/newer 在当前窗口两端追加, 不替换用户正在看的内容.
  async loadLatest(sessionId, force = false) {
    const current = get().bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY;
    if (current.loading || (current.loaded && !force)) return;
    const request = windowRequest();
    currentWindowRequests.set(sessionId, request);
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loading: true,
        loadingOlder: false,
        loadingNewer: false,
        olderError: undefined,
        newerError: undefined,
        error: undefined,
      })),
    }));
    try {
      const page = await sessionsApi.listMessages(sessionId, { limit: MESSAGE_PAGE_SIZE });
      if (currentWindowRequests.get(sessionId) !== request) return;
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => {
          // 请求期间落盘的消息不能被请求开始时的服务端页面覆盖.
          const latest: SessionHistoryState = {
            ...value,
            messages: page.messages,
            loaded: true,
            newerCursor: undefined,
          };
          const messages = mergeWindowMessages(latest, [...request.arrivedMessages.values()]);
          return {
            ...latest,
            messages,
            windowId: crypto.randomUUID(),
            windowAnchorMessageId: undefined,
            turnStatsById: mergeTurnStats(
              new Map(page.turnStats.map(stats => [stats.turnId, stats])),
              [...request.arrivedTurnStats.values()],
              messages,
            ),
            loading: false,
            loadingOlder: false,
            loadingNewer: false,
            olderCursor: page.olderCursor,
          };
        }),
      }));
      clearArrivals(request);
    } catch (error) {
      if (currentWindowRequests.get(sessionId) !== request) return;
      clearArrivals(request);
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
    if (!current?.olderCursor || current.loading || current.loadingOlder) return;
    const request = currentWindowRequests.get(sessionId);
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loadingOlder: true,
        olderError: undefined,
      })),
    }));
    try {
      const page = await sessionsApi.listMessages(sessionId, {
        before: current.olderCursor,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (currentWindowRequests.get(sessionId) !== request) return;
      if (page.olderCursor === current.olderCursor) throw new Error('历史游标没有推进, 请重试');
      set(state => {
        const bySession = replace(state.bySession, sessionId, value => {
          if (
            value.windowId !== current.windowId
            || value.olderCursor !== current.olderCursor
          ) return value;
          const messages = mergeMessages(value.messages, page.messages);
          return {
            ...value,
            messages,
            turnStatsById: mergeTurnStats(value.turnStatsById, page.turnStats, messages),
            loadingOlder: false,
            olderCursor: page.olderCursor,
          };
        });
        return bySession === state.bySession ? state : { bySession };
      });
    } catch (error) {
      if (currentWindowRequests.get(sessionId) !== request) return;
      set(state => {
        const bySession = replace(state.bySession, sessionId, value => (
          value.windowId !== current.windowId
          || value.olderCursor !== current.olderCursor
            ? value
            : {
              ...value,
              loadingOlder: false,
              olderError: error instanceof Error ? error.message : '更早消息加载失败',
            }
        ));
        return bySession === state.bySession ? state : { bySession };
      });
    }
  },

  async loadNewer(sessionId) {
    const current = get().bySession.get(sessionId);
    if (!current?.newerCursor || current.loading || current.loadingNewer) return;
    const request = currentWindowRequests.get(sessionId);
    if (request) clearArrivals(request);
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loadingNewer: true,
        newerError: undefined,
      })),
    }));
    try {
      const page = await sessionsApi.listMessages(sessionId, {
        after: current.newerCursor,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (currentWindowRequests.get(sessionId) !== request) return;
      if (page.newerCursor === current.newerCursor) throw new Error('历史游标没有推进, 请重试');
      set(state => {
        const bySession = replace(state.bySession, sessionId, value => {
          if (
            value.windowId !== current.windowId
            || value.newerCursor !== current.newerCursor
          ) return value;
          const window = {
            ...value,
            messages: mergeMessages(value.messages, page.messages),
            loadingNewer: false,
            newerCursor: page.newerCursor,
          };
          const messages = mergeWindowMessages(window, [...(request?.arrivedMessages.values() ?? [])]);
          return {
            ...window,
            messages,
            turnStatsById: mergeTurnStats(
              value.turnStatsById,
              [...page.turnStats, ...(request?.arrivedTurnStats.values() ?? [])],
              messages,
            ),
          };
        });
        return bySession === state.bySession ? state : { bySession };
      });
      if (request) clearArrivals(request);
    } catch (error) {
      if (currentWindowRequests.get(sessionId) !== request) return;
      if (request) clearArrivals(request);
      set(state => {
        const bySession = replace(state.bySession, sessionId, value => (
          value.windowId !== current.windowId
          || value.newerCursor !== current.newerCursor
            ? value
            : {
              ...value,
              loadingNewer: false,
              newerError: error instanceof Error ? error.message : '更新消息加载失败',
            }
        ));
        return bySession === state.bySession ? state : { bySession };
      });
    }
  },

  // 导航轨跳转会用锚点窗口替换 messages, 后续向 newer 方向逐页回到 Session 最新位置.
  async openAround(sessionId, anchorMessageId) {
    const request = windowRequest();
    currentWindowRequests.set(sessionId, request);
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loading: true,
        loadingOlder: false,
        loadingNewer: false,
        olderError: undefined,
        newerError: undefined,
        error: undefined,
      })),
    }));
    try {
      const page = await sessionsApi.listMessagesAround(sessionId, {
        anchorMessageId,
        before: MESSAGE_PAGE_SIZE,
        after: MESSAGE_PAGE_SIZE,
      });
      if (currentWindowRequests.get(sessionId) !== request) return;
      set(state => ({
        bySession: replace(state.bySession, sessionId, value => {
          const window: SessionHistoryState = {
            ...value,
            messages: page.messages,
            windowId: crypto.randomUUID(),
            windowAnchorMessageId: anchorMessageId,
            loaded: true,
            loading: false,
            loadingOlder: false,
            loadingNewer: false,
            olderCursor: page.olderCursor,
            newerCursor: page.newerCursor,
          };
          const messages = mergeWindowMessages(window, [...request.arrivedMessages.values()]);
          return {
            ...window,
            messages,
            turnStatsById: mergeTurnStats(
              new Map(page.turnStats.map(stats => [stats.turnId, stats])),
              [...request.arrivedTurnStats.values()],
              messages,
            ),
          };
        }),
      }));
      clearArrivals(request);
    } catch (error) {
      if (currentWindowRequests.get(sessionId) !== request) return;
      clearArrivals(request);
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
    currentWindowRequests.set(sessionId, windowRequest());
    set(state => ({
      bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        loading: false,
        loadingOlder: false,
        loadingNewer: false,
      })),
    }));
  },

  // Turn terminal 和音频归档变化只重读该 Turn, 避免整页 History 再渲染一次.
  async mergeTurnMessages(sessionId, turnId) {
    const result = await sessionsApi.listTurnMessages(sessionId, turnId);
    const current = get().bySession.get(sessionId);
    const request = currentWindowRequests.get(sessionId);
    if (request && (current?.loading || current?.loadingNewer)) {
      for (const message of result.messages) request.arrivedMessages.set(message.id, message);
      for (const stats of result.turnStats) request.arrivedTurnStats.set(stats.turnId, stats);
    }
    set(state => ({
      bySession: state.bySession.has(sessionId)
        ? replace(state.bySession, sessionId, value => {
          const messages = mergeWindowMessages(value, result.messages);
          return {
            ...value,
            messages,
            turnStatsById: mergeTurnStats(value.turnStatsById, result.turnStats, messages),
            error: undefined,
          };
        })
        : state.bySession,
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
    set(state => {
      const bySession = replace(state.bySession, sessionId, value => (
        value.currentTurnId === turnId
          ? value
          : { ...value, currentTurnId: turnId }
      ));
      return bySession === state.bySession ? state : { bySession };
    });
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
    currentWindowRequests.delete(sessionId);
    set(state => {
      const bySession = new Map(state.bySession);
      bySession.delete(sessionId);
      return { bySession };
    });
  },
}));
