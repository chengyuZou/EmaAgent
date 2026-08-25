// 一次 LLM 调用的用量记账：零消耗不记，观测失败不阻断主链。
// 与两家工业参照同规（Claude/Codex 都只在流正常完结时入账）：调用方在拿到
// 完成的 usage 后调用本函数；abort/失败路径没有最终 usage，自然不记。
import type { LlmTokenUsage } from '@ema-agent/llm';
import { createUsageRecord, reportUsage } from './record.js';
import type { UsageContext, UsageRecorder } from './types.js';

export interface LlmCallUsageInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly usage: LlmTokenUsage;
  /** 归调用方决定身份：turn 主调用 `${turnId}:${iteration}`，compact 调用用 compactId。 */
  readonly usageContext?: UsageContext;
}

export function recordLlmCallUsage(
  recorder: UsageRecorder | undefined,
  input: LlmCallUsageInput,
): void {
  if (!recorder) return;
  const { usage } = input;
  if (
    usage.inputTokens <= 0
    && usage.outputTokens <= 0
    && (usage.cacheReadInputTokens ?? 0) <= 0
    && (usage.cacheWriteInputTokens ?? 0) <= 0
  ) return;
  reportUsage(
    recorder,
    createUsageRecord({
      capability: 'llm',
      providerId: input.providerId,
      modelId: input.modelId,
      status: 'completed',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      ...(input.usageContext ? { usageContext: input.usageContext } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
      cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null,
    }),
    error => console.warn('[usage] LLM 调用记账失败:', error),
  );
}
