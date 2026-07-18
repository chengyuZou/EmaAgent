// 定义各类模型调用统一上报的用量记录契约和写入端口。

export type UsageCapability = 'llm' | 'vision' | 'embed' | 'rerank' | 'stt' | 'tts';

export type UsageRecordStatus = 'completed' | 'failed';

/** 把一次模型调用关联到稳定的业务身份；未归属 Turn 的后台任务可以只传 callId。 */
export interface UsageContext<TCallId extends string = string> {
  callId: TCallId;
  sessionId?: string;
  turnId?: string;
}

/**
 * 单次逻辑 LLM 调用由 Provider 返回的 Token 指标。
 * cache 字段只在 Provider 明确返回对应计数时出现，禁止通过总输入量猜测。
 */
export interface LlmTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** Provider 语义下的缓存读取占可缓存输入比例，范围 0..1。 */
  cacheHitRate?: number;
}

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
  costUsd: number | null;
  durationMs: number;
  errorCode: string | null;
  createdAt: number;
}

/** AI 业务包只依赖写入端口，具体数据库实现由 Core 装配。 */
export interface UsageRecorder {
  record(record: UsageRecord): void;
}
