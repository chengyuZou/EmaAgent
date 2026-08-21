// 管理每个 Session 的热尾/旧历史模式、轻量 Turn 索引和历史窗口缓存。
import { create } from 'zustand';

import type { TurnIndexItemWire } from '@ema-agent/session';
import { sessionsApi } from '../../api/sessions.js';
import {
  assembleHistory,
  type ChatHistoryItem,
} from '../../stores/conversation-history.js';

const ARCHIVE_WINDOW_CACHE_LIMIT = 3;
const TURN_INDEX_PAGE_SIZE = 200;

export interface ArchiveMessageWindow {
  anchorTurnId: string;
  messages: ChatHistoryItem[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface SessionHistoryState {
  mode: 'tail' | 'archive';
  turnIndexItems: TurnIndexItemWire[];
  turnIndexNextCursor?: string;
  turnIndexLoaded: boolean;
  turnIndexLoading: boolean;
  archiveLoading: boolean;
  archiveWindows: ArchiveMessageWindow[];
  activeArchiveTurnId?: string;
  currentTurnId?: string;
  unseenTailCount: number;
  error?: string;
}

interface SessionHistoryStore {
  bySession: Map<string, SessionHistoryState>;
  loadTurnIndex(sessionId: string, reset?: boolean): Promise<void>;
  loadMoreTurnIndex(sessionId: string): Promise<void>;
  openArchive(sessionId: string, anchorTurnId: string): Promise<void>;
  showTail(sessionId: string): void;
  setCurrentTurn(sessionId: string, turnId: string): void;
  noteTailUpdate(sessionId: string): void;
  invalidateTurnIndex(sessionId: string): void;
  evictSession(sessionId: string): void;
}

export const EMPTY_SESSION_HISTORY: SessionHistoryState = {
  mode: 'tail',
  turnIndexItems: [],
  turnIndexLoaded: false,
  turnIndexLoading: false,
  archiveLoading: false,
  archiveWindows: [],
  unseenTailCount: 0,
};

export const useSessionHistoryStore = create<SessionHistoryStore>((set, get) => ({
  bySession: new Map(),

  async loadTurnIndex(sessionId, reset = false) {
    const key = sessionId as string;
    const current = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
    if (current.turnIndexLoading || (current.turnIndexLoaded && !reset)) return;

    updateSession(set, key, {
      ...current,
      turnIndexLoading: true,
      error: undefined,
    });
    try {
      const page = await sessionsApi.listTurnIndex(sessionId, {
        limit: TURN_INDEX_PAGE_SIZE,
      });
      const latest = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
      updateSession(set, key, {
        ...latest,
        turnIndexItems: page.items,
        turnIndexNextCursor: page.nextCursor,
        turnIndexLoaded: true,
        turnIndexLoading: false,
      });
    } catch (error) {
      const latest = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
      updateSession(set, key, {
        ...latest,
        turnIndexLoading: false,
        error: error instanceof Error ? error.message : 'Turn 索引加载失败',
      });
    }
  },

  async loadMoreTurnIndex(sessionId) {
    const key = sessionId as string;
    const current = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
    if (current.turnIndexLoading || !current.turnIndexNextCursor) return;

    updateSession(set, key, { ...current, turnIndexLoading: true, error: undefined });
    try {
      const page = await sessionsApi.listTurnIndex(sessionId, {
        cursor: current.turnIndexNextCursor,
        limit: TURN_INDEX_PAGE_SIZE,
      });
      const latest = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
      const known = new Set(latest.turnIndexItems.map((item) => item.turnId));
      updateSession(set, key, {
        ...latest,
        turnIndexItems: [
          ...latest.turnIndexItems,
          ...page.items.filter((item) => !known.has(item.turnId)),
        ],
        turnIndexNextCursor: page.nextCursor,
        turnIndexLoaded: true,
        turnIndexLoading: false,
      });
    } catch (error) {
      const latest = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
      updateSession(set, key, {
        ...latest,
        turnIndexLoading: false,
        error: error instanceof Error ? error.message : '更多 Turn 加载失败',
      });
    }
  },

  async openArchive(sessionId, anchorTurnId) {
    const key = sessionId as string;
    const current = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
    const cached = current.archiveWindows.find(
      (window) => window.anchorTurnId === anchorTurnId,
    );
    if (cached) {
      updateSession(set, key, {
        ...current,
        mode: 'archive',
        activeArchiveTurnId: anchorTurnId,
        archiveWindows: [
          cached,
          ...current.archiveWindows.filter((window) => window !== cached),
        ],
        unseenTailCount: 0,
      });
      return;
    }

    updateSession(set, key, { ...current, archiveLoading: true, error: undefined });
    try {
      const result = await sessionsApi.listMessageWindow(sessionId, {
        anchorTurnId,
      });
      const window: ArchiveMessageWindow = {
        anchorTurnId,
        messages: assembleHistory(result.messages, result.turns, 'oldestFirst'),
        hasOlder: result.hasOlder,
        hasNewer: result.hasNewer,
      };
      const latest = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
      updateSession(set, key, {
        ...latest,
        mode: 'archive',
        archiveLoading: false,
        activeArchiveTurnId: anchorTurnId,
        archiveWindows: [
          window,
          ...latest.archiveWindows.filter(
            (entry) => entry.anchorTurnId !== anchorTurnId,
          ),
        ].slice(0, ARCHIVE_WINDOW_CACHE_LIMIT),
        unseenTailCount: 0,
      });
    } catch (error) {
      const latest = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
      updateSession(set, key, {
        ...latest,
        archiveLoading: false,
        error: error instanceof Error ? error.message : '历史窗口加载失败',
      });
    }
  },

  showTail(sessionId) {
    const key = sessionId as string;
    const current = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
    updateSession(set, key, {
      ...current,
      mode: 'tail',
      activeArchiveTurnId: undefined,
      unseenTailCount: 0,
    });
  },

  setCurrentTurn(sessionId, turnId) {
    const key = sessionId as string;
    const current = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
    if (current.currentTurnId === turnId) return;
    updateSession(set, key, { ...current, currentTurnId: turnId });
  },

  noteTailUpdate(sessionId) {
    const key = sessionId as string;
    const current = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
    updateSession(set, key, {
      ...current,
      unseenTailCount: current.mode === 'archive'
        ? current.unseenTailCount + 1
        : 0,
    });
  },

  invalidateTurnIndex(sessionId) {
    const key = sessionId as string;
    const current = get().bySession.get(key) ?? EMPTY_SESSION_HISTORY;
    updateSession(set, key, { ...current, turnIndexLoaded: false });
  },

  evictSession(sessionId) {
    set((state) => {
      const bySession = new Map(state.bySession);
      bySession.delete(sessionId as string);
      return { bySession };
    });
  },
}));

function updateSession(
  set: (
    update: (state: SessionHistoryStore) => Pick<SessionHistoryStore, 'bySession'>,
  ) => void,
  sessionId: string,
  value: SessionHistoryState,
): void {
  set((state) => {
    const bySession = new Map(state.bySession);
    bySession.set(sessionId, value);
    return { bySession };
  });
}
