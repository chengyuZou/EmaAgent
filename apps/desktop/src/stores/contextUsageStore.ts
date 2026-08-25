// 当前 Session 最近一次 LLM Call 的上下文分类估算,纯内存展示态,不落 SQL。
import { create } from 'zustand';
import type { ContextUsageEstimate } from '@ema-agent/context';

export interface ContextUsageEntry {
  readonly llmCallId: string;
  readonly estimate: ContextUsageEstimate;
  readonly at: number;
}

interface ContextUsageState {
  readonly bySession: Record<string, ContextUsageEntry>;
  applyEstimate(sessionId: string, llmCallId: string, estimate: ContextUsageEstimate): void;
  clearSession(sessionId: string): void;
}

export const useContextUsageStore = create<ContextUsageState>((set) => ({
  bySession: {},

  applyEstimate(sessionId, llmCallId, estimate) {
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { llmCallId, estimate, at: Date.now() },
      },
    }));
  },

  clearSession(sessionId) {
    set((s) => {
      if (!(sessionId in s.bySession)) return s;
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  },
}));
