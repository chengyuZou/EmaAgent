import type { STTProtocol } from '@ema-agent/providers';

export type { STTProtocol } from '@ema-agent/providers';

export interface STTConnection {
  readonly protocol: STTProtocol;
  /** 本地服务或网关可以不需要凭据. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface TranscriptionRequest {
  /** 已读入内存的一整段音频, mimeType 描述其文件格式. */
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly language?: string;
  readonly signal?: AbortSignal;
}

/** 模型和协议在 createSTTCall 时选定, signal 控制本次请求的取消和超时. */
export type CallSTT = (request: TranscriptionRequest) => Promise<TranscriptionResult>;

export interface TranscriptionSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly segments?: readonly TranscriptionSegment[];
}
