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

export interface KbVisionAdapter {
  extract(opts: {
    providerId: string;
    model:      string;
    task:       'ocr';
    inputs:     VisionExtractInput[];
  }): Promise<{ blocks: VisionExtractBlock[] }>;
}
