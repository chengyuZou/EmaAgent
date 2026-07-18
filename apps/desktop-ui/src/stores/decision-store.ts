/**
 * Decision store — per-session permission / ask-user prompt queues.
 *
 * Each session owns an independent FIFO queue. The active session's queue
 * head is what the chat-window DecisionLayer renders; non-active sessions
 * surface pending counts via the sidebar. The pet window never mounts
 * DecisionLayer (it has no viewedSessionId), so it never shows a blocking
 * modal — only non-blocking toasts via PermissionToastLayer.
 *
 * Prompts arrive from:
 *   - system SSE (/api/system/events) — permission_required
 *   - turn SSE — ask_* tool events (routed through conversation-sse)
 *
 * Routing is by `promptId` (globally unique UUID) on the backend
 * (AskUserRegistry.respond only looks up promptId, never turnId/sessionId).
 * This store mirrors that: dismiss(promptId) scans all session queues.
 */
import { create } from 'zustand';
import type {
  AskUserQuestionSpec,
  PermissionAccessType,
  PermissionRiskLevel,
  SessionId,
  TurnId,
} from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DecisionPrompt =
  | {
      kind: 'permission';
      promptId: string;
      sessionId?: SessionId;
      toolId: string;
      toolName: string;
      toolDescription?: string;
      args: unknown;
      hint: string;
      riskLevel: PermissionRiskLevel;
      accessType?: PermissionAccessType;
      gateReason?: string;
      humanDescription?: string;
      humanDescriptionPending?: boolean;
    }
  | {
      kind: 'ask_confirm';
      promptId: string;
      turnId: TurnId;
      sessionId?: SessionId;
      question: string;
      humanDescription?: string;
    }
  | {
      kind: 'ask_text';
      promptId: string;
      turnId: TurnId;
      sessionId?: SessionId;
      question: string;
      humanDescription?: string;
      placeholder?: string;
    }
  | {
      kind: 'ask_choice';
      promptId: string;
      turnId: TurnId;
      sessionId?: SessionId;
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
      sessionId?: SessionId;
      turnId: TurnId;
      questions: AskUserQuestionSpec[];
      humanDescription?: string;
    };

export type PermissionResponse =
  | { decision: 'allow' }
  | { decision: 'deny' };

export type AskResponse =
  | { kind: 'confirm'; confirmed: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'choice'; answers: string[]; customText?: string }
  | { kind: 'ask_user'; answers: Record<string, string> };

// ── State ─────────────────────────────────────────────────────────────────────

export interface DecisionStoreState {
  /** Per-session FIFO queues. Each queue's [0] is that session's "current". */
  sessions: Map<SessionId, DecisionPrompt[]>;

  /** Push a prompt onto its session's queue (deduped by promptId). */
  push(prompt: DecisionPrompt): void;

  /** Resolve the head of `sessionId`'s queue. */
  resolve(sessionId: SessionId, response: PermissionResponse | AskResponse): void;

  /** Cancel the head of `sessionId`'s queue. */
  cancel(sessionId: SessionId): void;

  /** Remove a specific prompt by promptId (scans all sessions). Used by
   *  `*_resolved` SSE events which carry only promptId. */
  dismiss(promptId: string): void;

  /** Drop a session's entire queue (called when the session is deleted). */
  clearSession(sessionId: SessionId): void;

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

  resolve(sessionId, _response) {
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
      const next = new Map<SessionId, DecisionPrompt[]>();
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

  clear() {
    set({ sessions: new Map() });
  },
}));
