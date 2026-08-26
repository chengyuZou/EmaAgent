/**
 * 按 Session 保存 Permission 与 AskUser 等待交互卡片。
 *
 * 每个 Session 拥有独立 FIFO。聊天窗口只渲染当前 Session 的队首，其他
 * Session 在侧栏显示待处理数量；桌宠窗口不挂载阻塞式决策层，只显示非阻塞提示。
 *
 * 两类交互都从 Turn SSE 到达，toolCallId 是全局唯一定位键（一次交互永远由
 * 唯一一次 Tool 调用触发）；提交时后端核对 URL 中的 turnId，拒绝陈旧卡片误答。
 * dismiss(toolCallId) 仍会扫描所有 Session 队列，以便终态事件清理对应卡片。
 */
import { create } from 'zustand';
import type { PermissionRequest } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import type { PendingInteractions } from '../api/turns.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Permission 卡：业务字段继承后端 PermissionRequest 契约，只补卡片 kind。
 * decisionReason 不进卡片：subcommandResults 变体携带的 ReadonlyMap 无法 JSON 化
 * （SSE 与 pending 恢复都是 JSON 通道），且当前批准卡 UI 不消费判定原因。
 */
export interface PermissionDecisionPrompt extends Omit<PermissionRequest, 'decisionReason'> {
  kind: 'permission';
}

/** AskUser 卡：一次 Tool 调用发起的一组问题；answers 以问题 id 为键一次提交。 */
export interface AskUserDecisionPrompt {
  kind: 'ask_user';
  sessionId: string;
  turnId: string;
  toolCallId: string;
  questions: AskUserRequiredEvent['questions'];
  humanDescription?: string;
}

export type DecisionPrompt = PermissionDecisionPrompt | AskUserDecisionPrompt;

type PendingInteractionItem = PendingInteractions['pending'][number];

// ── State ─────────────────────────────────────────────────────────────────────

export interface DecisionStoreState {
  /** Per-session FIFO queues. Each queue's [0] is that session's "current". */
  sessions: Map<string, DecisionPrompt[]>;

  /** Push a prompt onto its session's queue (deduped by toolCallId). */
  push(prompt: DecisionPrompt): void;

  /** Resolve the head of `sessionId`'s queue. */
  resolve(sessionId: string): void;

  /** Cancel the head of `sessionId`'s queue. */
  cancel(sessionId: string): void;

  /** Remove a specific prompt by toolCallId (scans all sessions). Used by
   *  `*_resolved` SSE events which carry only toolCallId. */
  dismiss(toolCallId: string): void;

  /** Drop a session's entire queue (called when the session is deleted). */
  clearSession(sessionId: string): void;

  /** 窗口重开/SSE 重连时把 Core 仍在等待的 Permission/AskUser 补回各 Session FIFO。 */
  restorePending(pending: PendingInteractionItem[]): void;

  /** Clear all queues. */
  clear(): void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useDecisionStore = create<DecisionStoreState>((set, get) => ({
  sessions: new Map(),

  push(prompt) {
    const sid = prompt.sessionId;
    if (!sid) {
      // SSE always carries sessionId; a missing one means upstream is broken.
      // Drop rather than pollute a synthetic queue.
      console.warn('[decision-store] prompt without sessionId, dropped', prompt.toolCallId);
      return;
    }
    const state = get();
    const existing = state.sessions.get(sid) ?? [];
    // Dedupe — backend may emit the same toolCallId on both per-turn and system SSE.
    if (existing.some((p) => p.toolCallId === prompt.toolCallId)) return;
    const next = new Map(state.sessions);
    next.set(sid, [...existing, prompt]);
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
      const next = new Map<string, DecisionPrompt[]>();
      for (const [sid, q] of s.sessions) {
        const filtered = q.filter((p) => p.toolCallId !== toolCallId);
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
      if (item.kind === 'permission') {
        get().push({ kind: 'permission', ...item.request });
      } else {
        const { type: _type, ...request } = item.request;
        get().push({ kind: 'ask_user', ...request });
      }
    }
  },

  clear() {
    set({ sessions: new Map() });
  },
}));
