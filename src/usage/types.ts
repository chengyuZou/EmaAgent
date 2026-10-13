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
  /** 请求结束时的结果; 失败或取消也可能已产生用量. */
  status: UsageRecordStatus;
  /** 供应商报告的输入 Token 总数, 已包含缓存部分. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** 输入中从缓存读取的 Token 数, 不应再加到 inputTokens. */
  cacheReadInputTokens: number | null;
  /** 输入中写入缓存的 Token 数, 不应再加到 inputTokens. */
  cacheWriteInputTokens: number | null;
  /**
   * 非 Token 用量, 必须结合 unit 读取, 不是费用或调用耗时.
   * TTS 为实际提交文本的 UTF-16 长度; STT 为转写结果时间段中已知的音频秒数.
   * null 表示没有取得这种用量或不适用, 不表示免费或用量为 0.
   */
  quantity: number | null;
  /** quantity 的单位: TTS 使用 character, STT 已知时使用 second; null 表示未取得或不适用. Token 使用专门字段. */
  unit: string | null;
  /** 从请求开始到返回, 流读取结束或抛错的毫秒耗时, 不是生成音频的播放时长. */
  durationMs: number;
  errorCode: string | null;
  /** 请求开始时的 Unix 毫秒时间; 结束后才写入记录, 排序仍使用开始时间. */
  createdAt: number;
}
