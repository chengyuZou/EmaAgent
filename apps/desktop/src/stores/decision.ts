// 按 Session 保存 Permission 与 AskUser 等待交互卡片。
// 队列元素 = 后端交互队列的可恢复快照（PendingInteraction，@ema-agent/turn 拥有），
// kind 判别沿用后端拼写 'permission' | 'askUser'，前端不再另设联合。
//
// 每个 Session 拥有独立 FIFO。聊天窗口只渲染当前 Session 的队首，其他
// Session 在侧栏显示待处理数量；桌宠窗口不挂载阻塞式决策层，只显示非阻塞提示。
import { create } from 'zustand';
import type { PendingInteraction } from '@ema-agent/turn';
import type { PendingInteractions } from '../api/turns.js';

export interface DecisionStoreState {
  /** 每 Session 独立 FIFO；[0] 是该 Session 的当前卡片。 */
  sessions: Map<string, PendingInteraction[]>;

  /** 入队；按 request.toolCallId 去重（同一交互可能同时走 Turn 流与 pending 恢复通道）。 */
  push(interaction: PendingInteraction): void;

  /** 队首已回答，出队。 */
  resolve(sessionId: string): void;

  /** 队首被取消，出队。 */
  cancel(sessionId: string): void;

  /** 终态事件只携带 toolCallId：扫描全部 Session 队列移除对应卡片。 */
  dismiss(toolCallId: string): void;

  /** 删除 Session 时清空其整条队列。 */
  clearSession(sessionId: string): void;

  /** 窗口重开/SSE 重连时把 Core 仍在等待的 Permission/AskUser 补回各 Session FIFO。 */
  restorePending(pending: PendingInteractions['pending']): void;

  clear(): void;
}

export const useDecisionStore = create<DecisionStoreState>((set, get) => ({
  sessions: new Map(),

  push(interaction) {
    const sid = interaction.request.sessionId;
    const existing = get().sessions.get(sid) ?? [];
    if (existing.some((p) => p.request.toolCallId === interaction.request.toolCallId)) return;
    const next = new Map(get().sessions);
    next.set(sid, [...existing, interaction]);
    set({ sessions: next });
  },

  resolve(sessionId) {
    set((s) => {
      const q = s.sessions.get(sessionId);
      if (!q || q.length === 0) return {};
      const next = new Map(s.sessions);
      next.set(sessionId, q.slice(1));
      return { sessions: next };
    });
  },

  cancel(sessionId) {
    set((s) => {
      const q = s.sessions.get(sessionId);
      if (!q || q.length === 0) return {};
      const next = new Map(s.sessions);
      next.set(sessionId, q.slice(1));
      return { sessions: next };
    });
  },

  dismiss(toolCallId) {
    set((s) => {
      let changed = false;
      const next = new Map<string, PendingInteraction[]>();
      for (const [sid, q] of s.sessions) {
        const filtered = q.filter((p) => p.request.toolCallId !== toolCallId);
        if (filtered.length !== q.length) changed = true;
        if (filtered.length > 0) next.set(sid, filtered);
      }
      return changed ? { sessions: next } : {};
    });
  },

  clearSession(sessionId) {
    set((s) => {
      if (!s.sessions.has(sessionId)) return {};
      const next = new Map(s.sessions);
      next.delete(sessionId);
      return { sessions: next };
    });
  },

  restorePending(pending) {
    for (const item of pending) {
      get().push(item);
    }
  },

  clear() {
    set({ sessions: new Map() });
  },
}));
