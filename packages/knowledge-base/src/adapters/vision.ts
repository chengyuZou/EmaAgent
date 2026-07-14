// Vision adapter interface — decouples KB from the vision package.
// The concrete implementation (wrapping VisionRouter) is injected at wiring time.

export interface VisionExtractInput {
  bytes:    Uint8Array;
  mimeType: string;
  name:     string;
}

export interface VisionExtractBlock {
  text:      string;
  markdown?: string;
}

export class KbVisionAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    options: { cause?: unknown } = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KbVisionAdapterError';
  }
}

export function isKbVisionAdapterError(error: unknown): error is KbVisionAdapterError {
  return error instanceof KbVisionAdapterError;
}

export interface KbVisionAdapter {
  extract(opts: {
    providerId: string;
    model:      string;
    task:       'ocr';
    inputs:     VisionExtractInput[];
    signal?:    AbortSignal;
  }): Promise<{ blocks: VisionExtractBlock[] }>;
}
