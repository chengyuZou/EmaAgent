import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import type { Element } from '../types.js';
import type { DocumentReader, ReaderSource } from './base.js';
import { parseHtml } from './html.js';

/**
 * Reads DOCX files by converting them to HTML via mammoth, then
 * delegating to the HTML reader for element extraction.
 */
export class DocxReader implements DocumentReader {
  async read(source: ReaderSource): Promise<Element[]> {
    const buffer = source.kind === 'path'
      ? await readFile(source.path)
      : Buffer.from(source.bytes);

    const { value: html } = await mammoth.convertToHtml({ buffer });
    return parseHtml(html);
  }
}
