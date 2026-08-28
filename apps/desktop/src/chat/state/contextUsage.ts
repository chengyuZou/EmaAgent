// 每个 Session 最新的根 Context 占用：根调用事件与手动 Compact 共用一格，纯内存展示态。
import { create } from 'zustand';
import type { ContextUsage } from '@ema-agent/context';

export type ContextUsageEntry =
  | {
      readonly kind: 'llm_call';
      readonly llmCallId: string;
      readonly usage: ContextUsage;
    }
  | {
      readonly kind: 'manual_compact';
      readonly inputTokens: number;
      readonly contextWindow: number;
    };

interface ContextUsageState {
  readonly bySession: Readonly<Record<string, ContextUsageEntry>>;
  applyLlmCall(sessionId: string, llmCallId: string, usage: ContextUsage): void;
  applyManualCompact(sessionId: string, inputTokens: number, contextWindow: number): void;
  clearSession(sessionId: string): void;
}

export const useContextUsage = create<ContextUsageState>((set) => ({
  bySession: {},

  applyLlmCall(sessionId, llmCallId, usage) {
    set((state) => {
      const current = state.bySession[sessionId];
      // 新 ID 的 estimate 建立当前调用；不同 ID 的 provider 校正是迟到事件，直接忽略。
      if (
        current?.kind === 'llm_call'
        && current.llmCallId !== llmCallId
        && usage.source === 'provider'
      ) {
        return state;
      }
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { kind: 'llm_call', llmCallId, usage },
        },
      };
    });
  },

  applyManualCompact(sessionId, inputTokens, contextWindow) {
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { kind: 'manual_compact', inputTokens, contextWindow },
      },
    }));
  },

  clearSession(sessionId) {
    set((state) => {
      if (!(sessionId in state.bySession)) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  },
}));
