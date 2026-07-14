import type { LlmUsage } from './types.js';

export interface ProviderUsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  /** Provider 定义的可缓存输入总量；缺省时使用 inputTokens。 */
  cacheEligibleInputTokens?: number;
}

/** 将不同 Provider 的缓存计数归一为统一、可聚合的调用级指标。 */
export function createLlmUsage(input: ProviderUsageInput): LlmUsage {
  const inputTokens = nonNegative(input.inputTokens);
  const outputTokens = nonNegative(input.outputTokens);
  const hasCacheRead = input.cacheReadInputTokens !== undefined
    && input.cacheReadInputTokens !== null;
  const hasCacheWrite = input.cacheWriteInputTokens !== undefined
    && input.cacheWriteInputTokens !== null;
  const cacheReadInputTokens = hasCacheRead
    ? nonNegative(input.cacheReadInputTokens!)
    : undefined;
  const cacheWriteInputTokens = hasCacheWrite
    ? nonNegative(input.cacheWriteInputTokens!)
    : undefined;

  const result: LlmUsage = {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  };

  if (cacheReadInputTokens !== undefined) {
    const eligible = nonNegative(input.cacheEligibleInputTokens ?? inputTokens);
    result.cacheHitRate = eligible > 0
      ? Math.min(1, cacheReadInputTokens / eligible)
      : 0;
  }

  return result;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
