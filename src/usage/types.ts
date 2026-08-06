export type UsageCapability = 'llm' | 'vision' | 'embed' | 'rerank' | 'stt' | 'tts';

export type UsageRecordStatus = 'completed' | 'failed' | 'cancelled';

/** 把一次模型调用关联到业务身份；后台调用可以只提供 callId。 */
export interface UsageContext<TCallId extends string = string> {
  callId: TCallId;
  sessionId?: string;
  turnId?: string;
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
  durationMs: number;
  errorCode: string | null;
  createdAt: number;
}

/** AI 业务模块只依赖写入端口，数据库实现由 Core 装配。 */
export interface UsageRecorder {
  record(record: UsageRecord): void;
}
