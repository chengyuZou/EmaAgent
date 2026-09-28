import type { UsageRecordRow } from '@ema-agent/storage';

export type UsageCapability = UsageRecordRow['capability'];

export type UsageRecordStatus = UsageRecordRow['status'];

export interface UsageRecord {
  id: string;
  sessionId: string | null;
  turnId: string | null;
  providerId: string;
  modelId: string;
  capability: UsageCapability;
  status: UsageRecordStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  quantity: number | null;
  unit: string | null;
  durationMs: number;
  errorCode: string | null;
  /** 物理调用开始时间; 记录在调用结束或抛错后写入, 用此时间排序而非 SQL 写入时间. */
  createdAt: number;
}
