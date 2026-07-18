// 归一化 Provider 用量，并把单次调用的累计快照安全转换为聚合增量。
import type { LlmTokenUsage } from './types.js';

export interface ProviderUsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  /** Provider 定义的可缓存输入总量；缺省时使用 inputTokens。 */
  cacheEligibleInputTokens?: number;
}

/** 将不同 Provider 的缓存计数归一为统一、可聚合的调用级指标。 */
export function createLlmTokenUsage(input: ProviderUsageInput): LlmTokenUsage {
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

  const result: LlmTokenUsage = {
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

/**
 * 接收同一次 LLM 调用的新累计快照，返回单调快照和相对上一快照的增量。
 * Provider 偶发返回较小计数时保持已确认上界，避免实时事件导致负增量或重复扣预算。
 */
export function advanceLlmUsageSnapshot(
  previous: LlmTokenUsage,
  incoming: LlmTokenUsage,
): { snapshot: LlmTokenUsage; delta: LlmTokenUsage } {
  const inputTokens = Math.max(
    nonNegative(previous.inputTokens),
    nonNegative(incoming.inputTokens),
  );
  const outputTokens = Math.max(
    nonNegative(previous.outputTokens),
    nonNegative(incoming.outputTokens),
  );
  const cacheReadInputTokens = maxOptional(
    previous.cacheReadInputTokens,
    incoming.cacheReadInputTokens,
  );
  const cacheWriteInputTokens = maxOptional(
    previous.cacheWriteInputTokens,
    incoming.cacheWriteInputTokens,
  );
  const snapshot: LlmTokenUsage = {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(incoming.cacheHitRate !== undefined
      ? { cacheHitRate: incoming.cacheHitRate }
      : previous.cacheHitRate !== undefined
        ? { cacheHitRate: previous.cacheHitRate }
        : {}),
  };

  return {
    snapshot,
    delta: {
      inputTokens: inputTokens - nonNegative(previous.inputTokens),
      outputTokens: outputTokens - nonNegative(previous.outputTokens),
      ...(cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: cacheReadInputTokens - nonNegative(previous.cacheReadInputTokens ?? 0) }
        : {}),
      ...(cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: cacheWriteInputTokens - nonNegative(previous.cacheWriteInputTokens ?? 0) }
        : {}),
    },
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function maxOptional(
  previous: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (previous === undefined && incoming === undefined) return undefined;
  return Math.max(nonNegative(previous ?? 0), nonNegative(incoming ?? 0));
}
