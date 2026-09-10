import { create } from 'zustand';
import { sessionsApi, type SessionHistoryMessage, type TurnIndexPage } from '../../api/sessions.js';

type TurnIndexItem = TurnIndexPage['items'][number];
const MESSAGE_PAGE_SIZE = 50;
const TURN_INDEX_PAGE_SIZE = 200;

export interface SessionHistoryState {
  readonly messages: readonly SessionHistoryMessage[];
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly loadingNewer: boolean;
  readonly olderCursor?: string;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly turnIndexItems: readonly TurnIndexItem[];
  readonly turnIndexNextCursor?: string;
  readonly turnIndexLoaded: boolean;
  readonly turnIndexLoading: boolean;
  readonly currentTurnId?: string;
  readonly error?: string;
}

interface HistoryStore {
  readonly bySession: ReadonlyMap<string, SessionHistoryState>;
  loadLatest(sessionId: string, force?: boolean): Promise<void>;
  loadOlder(sessionId: string): Promise<void>;
  loadNewer(sessionId: string): Promise<void>;
  openAround(sessionId: string, anchorMessageId: string): Promise<void>;
  mergeTurnMessages(sessionId: string, turnId: string): Promise<void>;
  loadTurnIndex(sessionId: string, reset?: boolean): Promise<void>;
  loadMoreTurnIndex(sessionId: string): Promise<void>;
  setCurrentTurn(sessionId: string, turnId: string): void;
  invalidateTurnIndex(sessionId: string): void;
  evictSession(sessionId: string): void;
}

export const EMPTY_SESSION_HISTORY: SessionHistoryState = {
  messages: [],
  loaded: false,
  loading: false,
  loadingOlder: false,
  loadingNewer: false,
  hasOlder: false,
  hasNewer: false,
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

function mergeMessages(current: readonly SessionHistoryMessage[], incoming: readonly SessionHistoryMessage[]): SessionHistoryMessage[] {
  const byId = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  bySession: new Map(),

  async loadLatest(sessionId, force = false) {
    const current = get().bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY;
    if (current.loading || (current.loaded && !force)) return;
    set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, loading: true, error: undefined })) }));
    try {
      const page = await sessionsApi.listMessages(sessionId, { limit: MESSAGE_PAGE_SIZE });
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        messages: page.messages,
        loaded: true,
        loading: false,
        olderCursor: page.olderCursor,
        hasOlder: page.olderCursor !== undefined,
        hasNewer: false,
      })) }));
    } catch (error) {
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, loading: false, error: error instanceof Error ? error.message : '消息加载失败' })) }));
    }
  },

  async loadOlder(sessionId) {
    const current = get().bySession.get(sessionId);
    if (!current?.olderCursor || current.loadingOlder) return;
    set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, loadingOlder: true })) }));
    try {
      const page = await sessionsApi.listMessages(sessionId, { before: current.olderCursor, limit: MESSAGE_PAGE_SIZE });
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        messages: mergeMessages(value.messages, page.messages),
        loadingOlder: false,
        olderCursor: page.olderCursor,
        hasOlder: page.olderCursor !== undefined,
      })) }));
    } catch (error) {
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, loadingOlder: false, error: error instanceof Error ? error.message : '更早消息加载失败' })) }));
    }
  },

  async loadNewer(sessionId) {
    const current = get().bySession.get(sessionId);
    const anchorMessageId = current?.messages.at(-1)?.id;
    if (!current?.hasNewer || current.loadingNewer || !anchorMessageId) return;
    set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, loadingNewer: true })) }));
    try {
      const page = await sessionsApi.listMessagesAround(sessionId, { anchorMessageId, before: 0, after: MESSAGE_PAGE_SIZE });
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, messages: mergeMessages(value.messages, page.messages), loadingNewer: false, hasNewer: page.hasNewer })) }));
    } catch (error) {
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, loadingNewer: false, error: error instanceof Error ? error.message : '更新消息加载失败' })) }));
    }
  },

  async openAround(sessionId, anchorMessageId) {
    set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, loading: true, error: undefined })) }));
    try {
      const page = await sessionsApi.listMessagesAround(sessionId, { anchorMessageId, before: MESSAGE_PAGE_SIZE, after: MESSAGE_PAGE_SIZE });
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({
        ...value,
        messages: page.messages,
        loaded: true,
        loading: false,
        olderCursor: undefined,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
      })) }));
    } catch (error) {
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, loading: false, error: error instanceof Error ? error.message : '历史位置加载失败' })) }));
    }
  },

  async mergeTurnMessages(sessionId, turnId) {
    const result = await sessionsApi.listTurnMessages(sessionId, turnId);
    set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, messages: mergeMessages(value.messages, result.messages), loaded: true })) }));
  },

  async loadTurnIndex(sessionId, reset = false) {
    const current = get().bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY;
    if (current.turnIndexLoading || (current.turnIndexLoaded && !reset)) return;
    set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, turnIndexLoading: true, error: undefined })) }));
    try {
      const page = await sessionsApi.listTurnIndex(sessionId, { limit: TURN_INDEX_PAGE_SIZE });
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, turnIndexItems: page.items, turnIndexNextCursor: page.nextCursor, turnIndexLoaded: true, turnIndexLoading: false })) }));
    } catch (error) {
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, turnIndexLoading: false, error: error instanceof Error ? error.message : 'Turn 索引加载失败' })) }));
    }
  },

  async loadMoreTurnIndex(sessionId) {
    const current = get().bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY;
    if (current.turnIndexLoading || !current.turnIndexNextCursor) return;
    set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, turnIndexLoading: true, error: undefined })) }));
    try {
      const page = await sessionsApi.listTurnIndex(sessionId, { cursor: current.turnIndexNextCursor, limit: TURN_INDEX_PAGE_SIZE });
      set(state => ({ bySession: replace(state.bySession, sessionId, value => {
        const known = new Set(value.turnIndexItems.map(item => item.turnId));
        return { ...value, turnIndexItems: [...value.turnIndexItems, ...page.items.filter(item => !known.has(item.turnId))], turnIndexNextCursor: page.nextCursor, turnIndexLoaded: true, turnIndexLoading: false };
      }) }));
    } catch (error) {
      set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, turnIndexLoading: false, error: error instanceof Error ? error.message : '更多 Turn 加载失败' })) }));
    }
  },

  setCurrentTurn(sessionId, turnId) {
    set(state => ({ bySession: replace(state.bySession, sessionId, value => value.currentTurnId === turnId ? value : { ...value, currentTurnId: turnId }) }));
  },

  invalidateTurnIndex(sessionId) {
    set(state => ({ bySession: replace(state.bySession, sessionId, value => ({ ...value, turnIndexLoaded: false })) }));
  },

  evictSession(sessionId) {
    set(state => { const bySession = new Map(state.bySession); bySession.delete(sessionId); return { bySession }; });
  },
}));
