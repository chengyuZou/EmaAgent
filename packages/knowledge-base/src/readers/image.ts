import { readFile } from 'node:fs/promises';
import type { DocumentBlock } from '../types.js';
import type { DocumentReader, ReadResult, ReaderSource } from './base.js';
import { nextBlockId } from './base.js';
import type { KbVisionAdapter } from '../adapters/vision.js';

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

export interface ImageReaderOptions {
  providerId: string;
  model:      string;
  signal?:    AbortSignal;
}

export class ImageReader implements DocumentReader {
  constructor(
    private readonly vision: KbVisionAdapter,
    private readonly opts:   ImageReaderOptions,
  ) {}

  async read(source: ReaderSource): Promise<ReadResult> {
    const name  = source.kind === 'path' ? source.path : source.name;
    const ext   = name.split('.').pop()?.toLowerCase() ?? '';
    const mime  = MIME_MAP[ext] ?? 'image/png';
    const bytes = source.kind === 'path'
      ? new Uint8Array(await readFile(source.path))
      : source.bytes;

    const result = await this.vision.extract({
      providerId: this.opts.providerId,
      model:      this.opts.model,
      task:       'ocr',
      inputs:     [{ bytes, mimeType: mime, name }],
      signal:     this.opts.signal,
    });

    return {
      blocks: result.blocks.map(b => ({
        id:          nextBlockId(),
        kind:        'image' as const,
        text:        b.text,
        markdown:    b.markdown,
        sectionPath: [],
      })),
    };
  }
}
