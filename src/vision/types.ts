import type { LlmConnection, LlmTokenUsage } from '@ema-agent/llm';

/** Provider 已解析好的 Vision 协议连接。 */
export type VisionConnection = LlmConnection;

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

/** 单次协议请求；模型身份在创建点冻结，载荷限制、并发、重试和持久化均由上层拥有。 */
export interface VisionRequest {
  readonly images: readonly VisionImage[];
  readonly task?: VisionTask;
  readonly language?: string;
  /** 只描述本次视觉任务，不应携带对话历史。 */
  readonly instruction?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** 创建点冻结连接与模型身份的单次视觉调用。 */
export type CallVision = (request: VisionRequest) => Promise<VisionResult>;

export interface VisionResult {
  readonly text: string;
  readonly markdown?: string;
  readonly blocks: readonly VisionBlock[];
  readonly usage?: LlmTokenUsage;
}
