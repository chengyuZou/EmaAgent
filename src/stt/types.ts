import type { SttProtocol } from '@ema-agent/providers';

export type { SttProtocol } from '@ema-agent/providers';

/** Provider 已解析好的 STT 协议连接。 */
export interface SttConnection {
  readonly protocol: SttProtocol;
  /** 本地或受信网关可以不需要凭据。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** 单次整段音频转录请求；上传体积策略由接收文件的上层入口拥有；模型身份在创建点冻结。 */
export interface TranscriptionRequest {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly language?: string;
  readonly signal?: AbortSignal;
}

/** 创建点冻结连接与模型身份的单次转录调用；超时和重试由调用方通过 signal 控制。 */
export type CallStt = (request: TranscriptionRequest) => Promise<TranscriptionResult>;

export interface TranscriptionSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly segments?: readonly TranscriptionSegment[];
}
