export type VisionTask =
  | 'auto'
  | 'caption'
  | 'ocr'
  | 'layout'
  | 'table'
  | 'document_image';

export type VisionParseMode = 'strict' | 'best_effort';

export type VisionCaller =
  | 'turn_attachment'
  | 'document_ingest'
  | 'knowledge_ingest'
  | 'ema_live_vision'
  | 'system';

export interface VisionInvocationContext {
  caller: VisionCaller;
  sessionId?: string;
  turnId?: string;
  attachmentId?: string;
  documentId?: string;
  jobId?: string;
  traceId?: string;
}

export type VisionImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

export interface VisionSourceRef {
  attachmentId?: string;
  localPath?: string;
  url?: string;
  page?: number;
  frameMs?: number;
  label?: string;
}

export type VisionImageInput =
  | {
      kind: 'bytes';
      bytes: Uint8Array;
      mimeType: VisionImageMime;
      name?: string;
      source?: VisionSourceRef;
    }
  | {
      kind: 'base64';
      data: string;
      mimeType: VisionImageMime;
      name?: string;
      source?: VisionSourceRef;
    }
  | {
      kind: 'url';
      url: string;
      mimeType?: VisionImageMime;
      name?: string;
      source?: VisionSourceRef;
    };

export type VisionBlockKind =
  | 'text'
  | 'table'
  | 'image'
  | 'layout'
  | 'formula'
  | 'caption';

export interface VisionBlock {
  id: string;
  kind: VisionBlockKind;
  text: string;
  markdown?: string;
  /**
   * Normalized bounding box in reading coordinates: [x, y, width, height].
   * Values should be between 0 and 1 when a provider can estimate layout.
   */
  bbox?: [number, number, number, number];
  confidence?: number;
  source?: VisionSourceRef;
}

export interface VisionRequest {
  context?: VisionInvocationContext;
  /** provider_configs.id for the underlying model provider. */
  providerId: string;
  /** Raw model name expected by the selected provider. */
  model: string;
  task: VisionTask;
  inputs: VisionImageInput[];
  language?: string;
  /**
   * Extra task instruction from the caller. This is appended to the system
   * extraction prompt; do not put raw user chat history here.
   */
  prompt?: string;
  parseMode?: VisionParseMode;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  limits?: Partial<VisionLimits>;
}

export interface VisionLimits {
  maxImages: number;
  maxBytesPerImage: number;
  maxTotalBytes: number;
  maxConcurrentGlobal: number;
  maxConcurrentPerProvider: number;
  timeoutMs: number;
}

export interface VisionExtractionResult {
  context?: VisionInvocationContext;
  providerId: string;
  model: string;
  task: VisionTask;
  text: string;
  markdown?: string;
  blocks: VisionBlock[];
  sources: VisionSourceRef[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  warnings?: string[];
  rawText?: string;
}

export interface VisionProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}
