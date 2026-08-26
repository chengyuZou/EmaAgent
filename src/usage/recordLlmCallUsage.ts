// 持久化一次物理 LLM 调用的已知终态；Token 未报告时保持 null。
import type { LlmTokenUsage } from '@ema-agent/llm';
import { createUsageRecord, reportUsage } from './record.js';
import type { UsageContext, UsageRecorder, UsageRecordStatus } from './types.js';

export interface LlmCallUsageInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly status: UsageRecordStatus;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly usage?: LlmTokenUsage;
  readonly errorCode?: string;
  readonly usageContext: UsageContext;
}

export function recordLlmCallUsage(
  recorder: UsageRecorder | undefined,
  input: LlmCallUsageInput,
): void {
  if (!recorder) return;
  reportUsage(
    recorder,
    createUsageRecord({
      capability: 'llm',
      providerId: input.providerId,
      modelId: input.modelId,
      status: input.status,
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      usageContext: input.usageContext,
      inputTokens: input.usage?.inputTokens ?? null,
      outputTokens: input.usage?.outputTokens ?? null,
      cacheReadInputTokens: input.usage?.cacheReadInputTokens ?? null,
      cacheWriteInputTokens: input.usage?.cacheWriteInputTokens ?? null,
      ...(input.status !== 'completed' && input.errorCode
        ? { errorCode: input.errorCode }
        : {}),
    }),
    error => console.warn('[usage] LLM 调用记账失败:', error),
  );
}
