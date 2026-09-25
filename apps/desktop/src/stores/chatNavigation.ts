import { create } from 'zustand';

interface ChatNavigationStore {
  readonly viewedSessionId: string | null;
  /** null 表示普通新对话, string 表示在指定 Project 中新建, undefined 表示已有 Session. */
  readonly newSessionProjectId: string | null | undefined;
  /** null 表示沿用所选项目主文件夹, 或无项目时的默认执行目录. */
  readonly newSessionCwd: string | null;
  readonly scrollToTurnId: string | null;
  viewSession(sessionId: string): void;
  openNewSession(projectId?: string): void;
  setNewSessionCwd(cwd: string): void;
  promoteNewSession(sessionId: string): void;
  scrollToTurn(turnId: string): void;
  evictSession(sessionId: string): void;
}

export const useChatNavigationStore = create<ChatNavigationStore>(set => ({
  viewedSessionId: null,
  newSessionProjectId: null,
  newSessionCwd: null,
  scrollToTurnId: null,

  viewSession(sessionId) {
    set({
      viewedSessionId: sessionId,
      newSessionProjectId: undefined,
      scrollToTurnId: null,
    });
  },

  openNewSession(projectId) {
    // 全局入口与 Project 入口共享新对话草稿, 来回切换只改变首次创建归属.
    set({
      viewedSessionId: null,
      newSessionProjectId: projectId ?? null,
      newSessionCwd: null,
      scrollToTurnId: null,
    });
  },

  setNewSessionCwd(cwd) {
    set({ newSessionCwd: cwd });
  },

  promoteNewSession(sessionId) {
    set({
      viewedSessionId: sessionId,
      newSessionProjectId: undefined,
      newSessionCwd: null,
    });
  },

  scrollToTurn(turnId) {
    set({ scrollToTurnId: turnId });
  },

  evictSession(sessionId) {
    set(state => {
      if (state.viewedSessionId !== sessionId) return state;
      return {
        viewedSessionId: null,
        newSessionProjectId: null,
        newSessionCwd: null,
        scrollToTurnId: null,
      };
    });
  },
}));
