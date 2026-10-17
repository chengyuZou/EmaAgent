// 估算根模型调用的总输入, Provider 回报后只把同一调用的总量校正为实报.
import type { LLMTokenUsage, LLMTool, Message } from '@ema-agent/llm';
import { estimateMessagesTokens } from '@ema-agent/token';

export interface ContextUsageEstimate {
  readonly contextWindow: number;
  readonly estimatedInputTokens: number;
}

export interface ContextUsage {
  readonly contextWindow: number;
  readonly inputTokens: number;
  readonly source: 'estimate' | 'provider';
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

/** messages 包含本次请求的 system 消息. */
export function estimateContextUsage(input: {
  readonly contextWindow: number;
  readonly tools: readonly LLMTool[];
  readonly messages: readonly Message[];
}): ContextUsageEstimate {
  return {
    contextWindow: input.contextWindow,
    estimatedInputTokens: estimateMessagesTokens(input.messages, input.tools),
  };
}

export function estimatedContextUsage(estimate: ContextUsageEstimate): ContextUsage {
  return {
    contextWindow: estimate.contextWindow,
    inputTokens: estimate.estimatedInputTokens,
    source: 'estimate',
  };
}

export function providerContextUsage(estimate: ContextUsageEstimate, usage: LLMTokenUsage): ContextUsage {
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
  const addedTokens = estimateMessagesTokens(messages);
  if (addedTokens === 0) return current;
  return {
    ...current,
    inputTokens: current.inputTokens + addedTokens,
    source: 'estimate',
  };
}
