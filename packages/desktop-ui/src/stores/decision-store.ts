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
import type { AskUserQuestionSpec } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DecisionPrompt =
  | {
      kind: 'permission';
      promptId: string;
      toolName: string;
      args: unknown;
      hint: string;
      humanDescription?: string;
      humanDescriptionPending?: boolean;
    }
  | {
      kind: 'ask_confirm';
      promptId: string;
      question: string;
      humanDescription?: string;
    }
  | {
      kind: 'ask_text';
      promptId: string;
      question: string;
      humanDescription?: string;
      placeholder?: string;
    }
  | {
      kind: 'ask_choice';
      promptId: string;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function advance(): { current: DecisionPrompt | null; queue: DecisionPrompt[] } {
  return { current: null, queue: [] };
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useDecisionStore = create<DecisionStoreState>((set, get) => ({
  queue:   [],
  current: null,

  push(prompt) {
    const state = get();
    if (!state.current) {
      set({ current: prompt });
    } else {
      set({ queue: [...state.queue, prompt] });
    }
  },

  resolve(_response) {
    const state = get();
    const next = state.queue[0];
    set({
      current: next ?? null,
      queue: state.queue.slice(1),
    });
  },

  cancel() {
    const state = get();
    const next = state.queue[0];
    set({
      current: next ?? null,
      queue: state.queue.slice(1),
    });
  },

  dismiss(promptId) {
    set((s) => ({
      current: s.current?.promptId === promptId ? null : s.current,
      queue:   s.queue.filter((p) => p.promptId !== promptId),
    }));
    // If we dismissed current, try advancing
    if (get().current === null && get().queue.length > 0) {
      const next = get().queue[0]!;
      set({ current: next, queue: get().queue.slice(1) });
    }
  },

  clear() {
    set({ queue: [], current: null });
  },
}));
