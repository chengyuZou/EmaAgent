import type { LLMConnection, LLMTokenUsage } from '@ema-agent/llm';

export type VisionConnection = LLMConnection;

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
  /** 模型报告的 [x, y, width, height]. Prompt 要求归一化坐标, 解析时只检查四个数值有限. */
  readonly bbox?: readonly [number, number, number, number];
  /** 模型自报的置信度, 解析时只检查数值有限. */
  readonly confidence?: number;
}

export interface VisionRequest {
  readonly images: readonly VisionImage[];
  readonly task?: VisionTask;
  readonly language?: string;
  /** 本次识别任务的补充指令, 会放进发给模型的 Prompt. */
  readonly instruction?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** 协议和模型在 createVisionCall 时选定, 每次调用提交一组图片任务. */
export type CallVision = (request: VisionRequest) => Promise<VisionResult>;

export interface VisionResult {
  readonly text: string;
  readonly markdown?: string;
  readonly blocks: readonly VisionBlock[];
  readonly usage?: LLMTokenUsage;
}
