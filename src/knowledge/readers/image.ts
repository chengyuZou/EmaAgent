// 把一张图片交给 AI 视觉服务, 读出图里的文字或生成图表描述。
// 位于知识库 readers 层: PDF 扫描页和图片附件都经它进入知识库。

import { readFile } from 'node:fs/promises';
import type { VisionModel, VisionImageMime, VisionTask } from '@ema-agent/vision';
import type { DocumentBlock } from '../types.js';
import type { DocumentReader, ReadResult, ReaderSource } from './base.js';
import { nextBlockId } from './base.js';

const MIME_MAP: Record<string, VisionImageMime> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

/** KB 可调用的 Vision 任务: ocr=整页识字, caption=图表/画面内容描述。 */
export type KbVisionTask = Extract<VisionTask, 'ocr' | 'caption'>;

export interface ImageReaderOptions {
  model:      string;
  signal?:    AbortSignal;
}

export class ImageReader implements DocumentReader {
  constructor(
    private readonly vision: VisionModel,
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

    const result = await this.vision.analyze({
      model:      this.opts.model,
      task,
      images:     [{ kind: 'bytes', bytes, mimeType: mime }],
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
