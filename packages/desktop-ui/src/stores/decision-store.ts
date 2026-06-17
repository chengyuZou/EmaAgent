/**
 * Decision store — global permission / ask-user prompt queue.
 *
 * Receives prompts from:
 *   - system SSE (/api/system/events) — permission_required
 *   - turn SSE — ask_user tool events (routed through chat-store → decision-store)
 *
 * Only one prompt is visible at a time (top of queue).
 */
import { create } from 'zustand';
import type { AskUserQuestionSpec, TurnId } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DecisionPrompt =
  | {
      kind: 'permission';
      promptId: string;
      sessionId?: string;
      toolName: string;
      args: unknown;
      hint: string;
      humanDescription?: string;
      humanDescriptionPending?: boolean;
    }
  | {
      kind: 'ask_confirm';
      promptId: string;
      sessionId?: string;
      question: string;
      humanDescription?: string;
    }
  | {
      kind: 'ask_text';
      promptId: string;
      sessionId?: string;
      question: string;
      humanDescription?: string;
      placeholder?: string;
    }
  | {
      kind: 'ask_choice';
      promptId: string;
      sessionId?: string;
      question: string;
      humanDescription?: string;
      options: Array<{ label: string; humanDescription?: string }>;
      multiSelect: boolean;
      allowCustom?: boolean;
    }
  // Batched ask-user from the built-in `ask_user` tool. The UI walks the
  // questions array one at a time and resolves once with the full answers map.
  | {
      kind: 'ask_user';
      promptId: string;
      sessionId?: string;
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
  queue:   DecisionPrompt[];
  current: DecisionPrompt | null;

  /** Push a new prompt. If nothing is active, it becomes current immediately. */
  push(prompt: DecisionPrompt): void;

  /** Resolve the current prompt. Advances queue. */
  resolve(response: PermissionResponse | AskResponse): void;

  /** Cancel the current prompt without a response. Advances queue. */
  cancel(): void;

  /** Remove a specific prompt from the queue by promptId. */
  dismiss(promptId: string): void;

  /** Clear all prompts. */
  clear(): void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useDecisionStore = create<DecisionStoreState>((set, get) => ({
  queue:   [],
  current: null,

  push(prompt) {
    const state = get();
    // Deduplicate — backend may occasionally emit the same promptId twice
    // (e.g. permission_required arriving on both per-turn and system SSE).
    if (state.current?.promptId === prompt.promptId) return;
    if (state.queue.some((p) => p.promptId === prompt.promptId)) return;

    if (!state.current) {
      set({ current: prompt });
    } else {
      set({ queue: [...state.queue, prompt] });
    }
  },

  resolve(_response) {
    set((s) => {
      const next = s.queue[0] ?? null;
      return { current: next, queue: s.queue.slice(1) };
    });
  },

  cancel() {
    set((s) => {
      const next = s.queue[0] ?? null;
      return { current: next, queue: s.queue.slice(1) };
    });
  },

  dismiss(promptId) {
    set((s) => {
      const wasCurrent = s.current?.promptId === promptId;
      const newQueue   = s.queue.filter((p) => p.promptId !== promptId);
      if (wasCurrent) {
        const next = newQueue[0] ?? null;
        return { current: next, queue: next ? newQueue.slice(1) : newQueue };
      }
      return { queue: newQueue };
    });
  },

  clear() {
    set({ queue: [], current: null });
  },
}));
