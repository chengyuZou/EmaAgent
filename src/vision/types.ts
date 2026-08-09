import type { VisionProtocol } from '@ema-agent/provider';

export type { VisionProtocol } from '@ema-agent/provider';

/** Provider 已解析好的 Vision 协议连接。 */
export interface VisionConnection {
  readonly protocol: VisionProtocol;
  /** 本地或受信网关可以不需要凭据。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** 单次视觉请求希望模型完成的任务。 */
export type VisionTask = 'auto' | 'caption' | 'ocr' | 'layout' | 'table';

export type VisionImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export type VisionImage =
  | {
      readonly kind: 'bytes';
      readonly bytes: Uint8Array;
      readonly mimeType: VisionImageMime;
    }
  | {
      readonly kind: 'base64';
      readonly data: string;
      readonly mimeType: VisionImageMime;
    }
  | {
      readonly kind: 'url';
      readonly url: string;
      readonly mimeType?: VisionImageMime;
    };

export type VisionBlockKind = 'text' | 'table' | 'image' | 'layout' | 'formula' | 'caption';

export interface VisionBlock {
  readonly id: string;
  readonly kind: VisionBlockKind;
  readonly text: string;
  readonly markdown?: string;
  /** 归一化阅读坐标：[x, y, width, height]。 */
  readonly bbox?: readonly [number, number, number, number];
  readonly confidence?: number;
}

/** 单次协议请求；调用身份、载荷限制、并发、重试和持久化均由上层拥有。 */
export interface VisionRequest {
  readonly model: string;
  readonly images: readonly VisionImage[];
  readonly task?: VisionTask;
  readonly language?: string;
  /** 只描述本次视觉任务，不应携带对话历史。 */
  readonly instruction?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** VisionModel 填好默认任务后交给私有协议实现的形状。 */
export interface VisionProtocolRequest extends Omit<VisionRequest, 'task'> {
  readonly task: VisionTask;
}

export interface VisionTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface VisionResult {
  readonly text: string;
  readonly markdown?: string;
  readonly blocks: readonly VisionBlock[];
  readonly usage?: VisionTokenUsage;
}
