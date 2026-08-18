import type { SttProtocol } from '@ema-agent/providers';

export type { SttProtocol } from '@ema-agent/providers';

/** Provider 已解析好的 STT 协议连接。 */
export interface SttConnection {
  readonly protocol: SttProtocol;
  /** 本地或受信网关可以不需要凭据。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** 单次整段音频转录请求；上传体积策略由接收文件的上层入口拥有。 */
export interface TranscriptionRequest {
  readonly model: string;
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly language?: string;
  readonly signal?: AbortSignal;
}

export interface TranscriptionSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly segments?: readonly TranscriptionSegment[];
}
