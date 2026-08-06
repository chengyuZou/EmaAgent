// 组装调用级用量记录,并保证观测链路永远不破坏业务主链。
import { randomUUID } from 'node:crypto';
import type {
  UsageCapability,
  UsageContext,
  UsageRecord,
  UsageRecorder,
  UsageRecordStatus,
} from './types.js';
import { UsageRecordValidationError } from './errors.js';
import { validateUsageRecord } from './validate.js';

export interface UsageRecordInput {
  readonly capability: UsageCapability;
  readonly providerId: string;
  readonly modelId: string;
  readonly status: UsageRecordStatus;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly usageContext?: UsageContext;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadInputTokens?: number | null;
  readonly cacheWriteInputTokens?: number | null;
  readonly quantity?: number | null;
  readonly unit?: string | null;
  readonly errorCode?: string | null;
}

/**
 * 各执行面 Runtime 的唯一记录组装入口:身份从 usageContext 归一
 * (callId 缺省随机、session/turn 可空),token 类字段缺省为 null,
 * createdAt 与调用开始时刻对齐。
 */
export function createUsageRecord(input: UsageRecordInput): UsageRecord {
  return {
    id: input.usageContext?.callId ?? randomUUID(),
    sessionId: input.usageContext?.sessionId ?? null,
    turnId: input.usageContext?.turnId ?? null,
    providerId: input.providerId,
    modelId: input.modelId,
    capability: input.capability,
    status: input.status,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    cacheReadInputTokens: input.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: input.cacheWriteInputTokens ?? null,
    quantity: input.quantity ?? null,
    unit: input.unit ?? null,
    durationMs: Math.max(0, input.durationMs),
    errorCode: input.errorCode ?? null,
    createdAt: input.startedAt,
  };
}

/**
 * 写入用量记录;记录失败转交 onError 诊断,诊断再失败也只能静默——
 * 观测链路不得反向破坏已经完成的模型调用。
 */
export function reportUsage(
  recorder: UsageRecorder,
  record: UsageRecord,
  onError?: (error: unknown, record: UsageRecord) => void,
): void {
  const issues = validateUsageRecord(record);
  if (issues.length > 0) {
    const error = new UsageRecordValidationError(issues);
    try {
      onError?.(error, record);
    } catch {
      // 观测链路不拥有业务终态。
    }
    if (!onError) {
      console.error(`[usage] invalid record dropped: ${error.message}`, record);
    }
    return;
  }

  try {
    recorder.record(record);
  } catch (error) {
    try {
      onError?.(error, record);
    } catch {
      // 观测链路不拥有业务终态。
    }
  }
}
