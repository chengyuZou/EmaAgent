import { readFile } from 'node:fs/promises';
import type { Element } from '../types.js';
import type { DocumentReader, ReaderSource } from './base.js';
import { nextElementId } from './base.js';
import type { VisionRouter } from '@ema-agent/vision';
import type { VisionImageMime } from '@ema-agent/vision';

const MIME_MAP: Record<string, VisionImageMime> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
};

export interface ImageReaderOptions {
  /** Vision provider id to use for OCR. */
  providerId: string;
  /** Model name for the vision provider. */
  model: string;
}

/**
 * Reads image files via the vision package (OCR + caption).
 * Requires a VisionRouter with at least one configured provider.
 */
export class ImageReader implements DocumentReader {
  constructor(
    private readonly vision: VisionRouter,
    private readonly opts: ImageReaderOptions,
  ) {}

  async read(source: ReaderSource): Promise<Element[]> {
    const name = source.kind === 'path' ? source.path : source.name;
    const ext  = name.split('.').pop()?.toLowerCase() ?? '';
    const mime = MIME_MAP[ext] ?? 'image/png';

    const bytes = source.kind === 'path'
      ? new Uint8Array(await readFile(source.path))
      : source.bytes;

    const result = await this.vision.extract({
      providerId: this.opts.providerId,
      model:      this.opts.model,
      task:       'ocr',
      inputs: [{ kind: 'bytes', bytes, mimeType: mime, name }],
    });

    return result.blocks.map(block => ({
      id:          nextElementId(),
      kind:        'image' as const,
      text:        block.text,
      markdown:    block.markdown,
      sectionPath: [],
    }));
  }
}
