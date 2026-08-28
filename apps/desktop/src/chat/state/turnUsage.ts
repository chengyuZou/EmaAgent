// Turn 实时 token 用量：根 Agent 累计与子 Agent 按 agentRunId 的最新累计。
// 事件携带的是截至当前的累计值（不是增量），替换不叠加；根 Turn 终态即清。
import { create } from 'zustand';
import type { LlmTokenUsage } from '@ema-agent/llm';

interface TurnUsageState {
  readonly rootByTurn: Readonly<Record<string, LlmTokenUsage>>;
  readonly subagentByTurn: Readonly<Record<string, Readonly<Record<string, LlmTokenUsage>>>>;
  setRootUsage(turnId: string, usage: LlmTokenUsage): void;
  setSubagentUsage(turnId: string, agentRunId: string, usage: LlmTokenUsage): void;
  clearTurn(turnId: string): void;
}

export const useTurnUsage = create<TurnUsageState>((set) => ({
  rootByTurn: {},
  subagentByTurn: {},

  setRootUsage(turnId, usage) {
    set((state) => ({ rootByTurn: { ...state.rootByTurn, [turnId]: usage } }));
  },

  setSubagentUsage(turnId, agentRunId, usage) {
    set((state) => ({
      subagentByTurn: {
        ...state.subagentByTurn,
        [turnId]: { ...state.subagentByTurn[turnId], [agentRunId]: usage },
      },
    }));
  },

  clearTurn(turnId) {
    set((state) => {
      if (!(turnId in state.rootByTurn) && !(turnId in state.subagentByTurn)) return state;
      const rootByTurn = { ...state.rootByTurn };
      const subagentByTurn = { ...state.subagentByTurn };
      delete rootByTurn[turnId];
      delete subagentByTurn[turnId];
      return { rootByTurn, subagentByTurn };
    });
  },
}));

/** Turn 实时总消耗 = 根 Agent 最新累计 + Σ 每个 agentRunId 的最新累计。 */
export function sumTurnUsage(
  state: Pick<TurnUsageState, 'rootByTurn' | 'subagentByTurn'>,
  turnId: string,
): LlmTokenUsage | undefined {
  const root = state.rootByTurn[turnId];
  const subagents = state.subagentByTurn[turnId];
  if (!root && !subagents) return undefined;
  let inputTokens = root?.inputTokens ?? 0;
  let outputTokens = root?.outputTokens ?? 0;
  for (const usage of Object.values(subagents ?? {})) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  }
  return { inputTokens, outputTokens };
}
