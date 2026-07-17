// 把一张图片交给 AI 视觉服务, 读出图里的文字或生成图表描述。
// 位于知识库 readers 层: PDF 扫描页和图片附件都经它进入知识库。

import { readFile } from 'node:fs/promises';
import type { DocumentBlock } from '../types.js';
import type { DocumentReader, ReadResult, ReaderSource } from './base.js';
import { nextBlockId } from './base.js';
import type { KbVisionAdapter, KbVisionTask } from '../adapters/vision.js';

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
    return this.readWithTask(source, 'ocr');
  }

  /**
   * 以指定任务读图: ocr 用于扫描页/图片附件识字,
   * caption 用于给含图 PDF 页生成图表内容描述(见 B-074 三路路由)。
   */
  async readWithTask(source: ReaderSource, task: KbVisionTask): Promise<ReadResult> {
    const name  = source.kind === 'path' ? source.path : source.name;
    const ext   = name.split('.').pop()?.toLowerCase() ?? '';
    const mime  = MIME_MAP[ext] ?? 'image/png';
    const bytes = source.kind === 'path'
      ? new Uint8Array(await readFile(source.path))
      : source.bytes;

    const result = await this.vision.extract({
      providerId: this.opts.providerId,
      model:      this.opts.model,
      task,
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
