// 聊天窗当前会话的窗口级状态：查看目标、草稿、桌宠语音/情绪归属与滚动定位。
import { create } from 'zustand';
import { sessionsApi } from '../../api/sessions.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { useMessages } from './messages.js';
import { useSessionStore } from '../../stores/session.js';
import type { TurnInputPart } from '@ema-agent/turn';

interface CurrentSessionState {
  readonly viewedSessionId: string | null;
  /** 桌宠当前为哪个 Session 发声/演出；情绪变化只中继给 owner。 */
  readonly ttsOwnerSessionId: string | null;
  /** 各 Session 记忆的当前情绪语义名，用于重新认领舞台时补发。 */
  readonly emotionStateMap: ReadonlyMap<string, string>;
  readonly draftMap: ReadonlyMap<string, readonly TurnInputPart[]>;
  readonly scrollToTurnId: string | null;

  viewSession(id: string): Promise<void>;
  /** 新建会话前先复用空会话：viewed 会话还没有任何 turn 时直接复用，不重复创建。 */
  createFreshSession(): Promise<string | null>;
  scrollToTurn(turnId: string): void;
  setDraft(sessionId: string, parts: readonly TurnInputPart[]): void;
  /** Turn 开始时把桌宠语音/演出归属切到该 Session，并补发其记忆情绪。 */
  claimStageOwner(sessionId: string): void;
  setEmotion(sessionId: string, emotion: string): void;
  /** 角色切换后清空全部记忆情绪：旧角色的语义名在新角色映射下无意义。 */
  clearEmotions(): void;
  evictSession(id: string): void;
}

export const useCurrentSession = create<CurrentSessionState>((set, get) => ({
  viewedSessionId: null,
  ttsOwnerSessionId: null,
  emotionStateMap: new Map(),
  draftMap: new Map(),
  scrollToTurnId: null,

  async viewSession(id) {
    if (get().viewedSessionId === id) {
      await useMessages.getState().loadMessages(id);
      return;
    }
    set({ viewedSessionId: id });

    void sessionsApi.markViewed(id)
      .then(() => useSessionStore.getState().loadSessions())
      .catch(() => {});

    await useMessages.getState().loadMessages(id);
  },

  async createFreshSession() {
    const viewedId = get().viewedSessionId;
    if (viewedId) {
      const viewed = useSessionStore.getState().sessions.byId.get(viewedId);
      // 空会话（从未产生 turn）直接复用，连点"新建会话"不再产生一串空会话。
      if (viewed && viewed.lastTurnStatus === null) return viewedId;
    }
    return useSessionStore.getState().createSession();
  },

  scrollToTurn(turnId) {
    set({ scrollToTurnId: turnId });
  },

  setDraft(sessionId, parts) {
    set((s) => {
      const draftMap = new Map(s.draftMap);
      if (parts.length > 0) draftMap.set(sessionId, parts);
      else draftMap.delete(sessionId);
      return { draftMap };
    });
  },

  claimStageOwner(sessionId) {
    if (get().ttsOwnerSessionId === sessionId) return;
    set({ ttsOwnerSessionId: sessionId });
    const saved = get().emotionStateMap.get(sessionId);
    if (saved) void tauriBridge.publishStageEmotion(saved);
  },

  setEmotion(sessionId, emotion) {
    set((s) => {
      const emotionStateMap = new Map(s.emotionStateMap);
      emotionStateMap.set(sessionId, emotion);
      return { emotionStateMap };
    });
    if (get().ttsOwnerSessionId === sessionId) {
      void tauriBridge.publishStageEmotion(emotion);
    }
  },

  clearEmotions() {
    set({ emotionStateMap: new Map() });
  },

  evictSession(id) {
    set((s) => {
      const draftMap = new Map(s.draftMap);
      draftMap.delete(id);
      const emotionStateMap = new Map(s.emotionStateMap);
      emotionStateMap.delete(id);
      const ttsOwnerSessionId =
        s.ttsOwnerSessionId === id ? null : s.ttsOwnerSessionId;
      return { draftMap, emotionStateMap, ttsOwnerSessionId };
    });
  },
}));
