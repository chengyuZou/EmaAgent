import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import type { DocumentReader, ReadResult, ReaderSource } from './base.js';
import { parseHtml } from './html.js';

export class DocxReader implements DocumentReader {
  async read(source: ReaderSource): Promise<ReadResult> {
    const buffer = source.kind === 'path'
      ? await readFile(source.path)
      : Buffer.from(source.bytes);
    const { value: html } = await mammoth.convertToHtml({ buffer });
    return { blocks: parseHtml(html) };
  }
}
