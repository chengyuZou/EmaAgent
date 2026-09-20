// 估算根模型调用的总输入, Provider 回报后只把同一调用的总量校正为实报.
import type { LlmTokenUsage, LlmTool, Message } from '@ema-agent/llm';
import { estimateLlmInputTokens, type TokenEstimateAccuracy } from '@ema-agent/token';

export interface ContextUsageEstimate {
  readonly contextWindow: number;
  readonly estimatedInputTokens: number;
  readonly accuracy: TokenEstimateAccuracy;
}

export interface ContextUsage {
  readonly contextWindow: number;
  readonly inputTokens: number;
  readonly source: 'estimate' | 'provider';
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

export function estimateContextUsage(input: {
  readonly contextWindow: number;
  readonly promptMessages: readonly Message[];
  readonly tools: readonly LlmTool[];
  readonly history: readonly Message[];
  readonly currentTurn: readonly Message[];
}): ContextUsageEstimate {
  const estimate = estimateLlmInputTokens(
    [...input.promptMessages, ...input.history, ...input.currentTurn],
    { tools: input.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    })) },
  );
  return {
    contextWindow: input.contextWindow,
    estimatedInputTokens: estimate.totalTokens,
    accuracy: estimate.accuracy,
  };
}

export function estimatedContextUsage(estimate: ContextUsageEstimate): ContextUsage {
  return {
    contextWindow: estimate.contextWindow,
    inputTokens: estimate.estimatedInputTokens,
    source: 'estimate',
  };
}

export function providerContextUsage(estimate: ContextUsageEstimate, usage: LlmTokenUsage): ContextUsage {
  return {
    contextWindow: estimate.contextWindow,
    inputTokens: usage.inputTokens,
    source: 'provider',
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
  };
}

/** 实报锚点后又有模型可见消息时, 圆环重新成为估算而非伪称 Provider 实报. */
export function appendEstimatedContextMessages(
  current: ContextUsage,
  messages: readonly Message[],
): ContextUsage {
  const addedTokens = estimateLlmInputTokens(messages).totalTokens;
  if (addedTokens === 0) return current;
  return {
    ...current,
    inputTokens: current.inputTokens + addedTokens,
    source: 'estimate',
  };
}
