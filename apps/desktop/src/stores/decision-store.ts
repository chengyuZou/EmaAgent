/**
 * 按 Session 保存 Permission 与 AskUser 等待交互卡片。
 *
 * 每个 Session 拥有独立 FIFO。聊天窗口只渲染当前 Session 的队首，其他
 * Session 在侧栏显示待处理数量；桌宠窗口不挂载阻塞式决策层，只显示非阻塞提示。
 *
 * Permission 从系统 SSE 到达，AskUser 从 Turn SSE 到达。promptId 是全局唯一
 * 定位键，两类交互提交时后端都会核对 URL 中的 turnId，拒绝陈旧卡片误答。
 * dismiss(promptId) 仍会扫描所有 Session 队列，以便终态事件清理对应卡片。
 */
import { create } from 'zustand';
import type {
  PendingPermissionPrompt,
  PermissionPrompt,
} from '@ema-agent/permission';

import type {
  AskUserQuestionSpec,
  PendingAskUserPrompt,
} from '@ema-agent/tools';

// ── Types ─────────────────────────────────────────────────────────────────────

/** 前端队列只补充卡片身份，Permission 业务字段全部继承后端唯一契约。 */
export interface PermissionDecisionPrompt extends PermissionPrompt {
  kind: 'permission';
  promptId: string;
  turnId: string;
  sessionId: string;
}

export type DecisionPrompt =
  | PermissionDecisionPrompt
  | {
      kind: 'ask_confirm';
      promptId: string;
      turnId: string;
      sessionId?: string;
      question: string;
      humanDescription?: string;
    }
  | {
      kind: 'ask_text';
      promptId: string;
      turnId: string;
      sessionId?: string;
      question: string;
      humanDescription?: string;
      placeholder?: string;
    }
  | {
      kind: 'ask_choice';
      promptId: string;
      turnId: string;
      sessionId?: string;
      question: string;
      humanDescription?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
      allowCustom?: boolean;
    }
  // Batched ask-user from the built-in `ask_user` tool. The UI walks the
  // questions array one at a time and resolves once with the full answers map.
  | {
      kind: 'ask_user';
      promptId: string;
      sessionId?: string;
      turnId: string;
      questions: AskUserQuestionSpec[];
      humanDescription?: string;
    };

// ── State ─────────────────────────────────────────────────────────────────────

export interface DecisionStoreState {
  /** Per-session FIFO queues. Each queue's [0] is that session's "current". */
  sessions: Map<string, DecisionPrompt[]>;

  /** Push a prompt onto its session's queue (deduped by promptId). */
  push(prompt: DecisionPrompt): void;

  /** Resolve the head of `sessionId`'s queue. */
  resolve(sessionId: string): void;

  /** Cancel the head of `sessionId`'s queue. */
  cancel(sessionId: string): void;

  /** Remove a specific prompt by promptId (scans all sessions). Used by
   *  `*_resolved` SSE events which carry only promptId. */
  dismiss(promptId: string): void;

  /** Drop a session's entire queue (called when the session is deleted). */
  clearSession(sessionId: string): void;

  /** 窗口重开时把 Core 仍在等待的权限请求补回各 Session FIFO。 */
  restorePermissions(prompts: PendingPermissionPrompt[]): void;

  /** 窗口重开时恢复 Core 仍在等待回答的 Ask User 请求。 */
  restoreAskUser(prompts: PendingAskUserPrompt[]): void;

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
      console.warn('[decision-store] prompt without sessionId, dropped', prompt.promptId);
      return;
    }
    const state = get();
    const existing = state.sessions.get(sid) ?? [];
    // Dedupe — backend may emit the same promptId on both per-turn and system SSE.
    if (existing.some((p) => p.promptId === prompt.promptId)) return;
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

  dismiss(promptId) {
    set((s) => {
      let changed = false;
      const next = new Map<string, DecisionPrompt[]>();
      for (const [sid, q] of s.sessions) {
        const filtered = q.filter((p) => p.promptId !== promptId);
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

  restorePermissions(prompts) {
    for (const snapshot of prompts) {
      const prompt = snapshot.prompt;
      if (!prompt.sessionId || !prompt.turnId) continue;
      get().push({
        ...prompt,
        kind: 'permission',
        promptId: snapshot.promptId,
        turnId: prompt.turnId,
        sessionId: prompt.sessionId,
      });
    }
  },

  restoreAskUser(prompts) {
    for (const snapshot of prompts) {
      const request = snapshot.request;
      switch (request.type) {
        case 'ask_user_required':
          get().push({
            kind: 'ask_user',
            promptId: request.promptId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            questions: request.questions,
            humanDescription: request.humanDescription,
          });
          break;
        case 'ask_confirm_required':
          get().push({
            kind: 'ask_confirm',
            promptId: request.promptId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            question: request.question,
            humanDescription: request.humanDescription,
          });
          break;
        case 'ask_text_required':
          get().push({
            kind: 'ask_text',
            promptId: request.promptId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            question: request.question,
            humanDescription: request.humanDescription,
            placeholder: request.placeholder,
          });
          break;
        case 'ask_choice_required':
          get().push({
            kind: 'ask_choice',
            promptId: request.promptId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            question: request.question,
            humanDescription: request.humanDescription,
            options: request.options,
            multiSelect: request.multiSelect ?? false,
            allowCustom: request.allowCustom,
          });
          break;
      }
    }
  },

  clear() {
    set({ sessions: new Map() });
  },
}));
