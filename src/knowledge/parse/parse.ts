import type { DocumentBlock } from '../types.js';
import { KnowledgeMissingImageReaderError } from '../errors.js';
import type { ReaderSource } from '../readers/base.js';
import { TextReader }  from '../readers/text.js';
import { HtmlReader }  from '../readers/html.js';
import { DocxReader }  from '../readers/docx.js';
import { PdfReader }   from '../readers/pdf.js';
import type { ImageReader } from '../readers/image.js';
import type { ReadFailure } from '../readers/base.js';
import { countWords }  from '../words.js';

const MIME_TO_READER: Record<string, 'text' | 'html' | 'docx' | 'pdf'> = {
  'text/plain':    'text', 'text/markdown': 'text',
  'text/html':     'html',
  'application/msword': 'docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/pdf': 'pdf',
};

export const EXT_TO_MIME: Record<string, string> = {
  txt: 'text/plain',  md: 'text/markdown', mdx: 'text/markdown',
  ts:  'text/plain',  tsx: 'text/plain',   js:  'text/plain',   jsx: 'text/plain',
  py:  'text/plain',  go:  'text/plain',   rs:  'text/plain',   java: 'text/plain',
  json: 'text/plain', yaml: 'text/plain',  yml: 'text/plain',   toml: 'text/plain',
  html: 'text/html',  htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc:  'application/msword',
  pdf:  'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

export interface ParseOptions {
  mimeType?:    string;
  /** Vision OCR reader for image/* sources. */
  imageReader?: ImageReader;
  /** Vision OCR reader for scanned PDF pages (image-only pages get rasterized + OCR'd). */
  pdfOcrReader?: ImageReader;
}

export interface ParseResult {
  blocks:    DocumentBlock[];
  mimeType:  string;
  title?:    string;
  wordCount: number;
  pageCount?: number;
  failures:  ReadFailure[];
}

/** 根据文件类型调用专属的Reader解析文档 */
export async function parseDocument(source: ReaderSource, opts: ParseOptions = {}): Promise<ParseResult> {
  const name     = source.kind === 'path' ? source.path : source.name;
  const ext      = name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = opts.mimeType ?? EXT_TO_MIME[ext] ?? 'text/plain';

  let blocks: DocumentBlock[];
  let pageCount: number | undefined;
  let failures: ReadFailure[] = [];

  if (mimeType.startsWith('image/')) {
    if (!opts.imageReader) throw new KnowledgeMissingImageReaderError(`读取${name}时,知识库缺少图片读取工具,无法处理图像文件。`);
    const result = await opts.imageReader.read(source);
    blocks = result.blocks;
  } else {
    const result = await selectReader(MIME_TO_READER[mimeType] ?? 'text', opts).read(source);
    blocks    = result.blocks;
    pageCount = result.pageCount;
    failures  = result.failures ?? [];
  }

  return {
    blocks,
    mimeType,
    title:     blocks.find(b => b.kind === 'title')?.text,
    wordCount: countWords(blocks),
    pageCount,
    failures,
  };
}

function selectReader(kind: 'text' | 'html' | 'docx' | 'pdf', opts: ParseOptions) {
  switch (kind) {
    case 'text': return new TextReader();
    case 'html': return new HtmlReader();
    case 'docx': return new DocxReader();
    case 'pdf':  return new PdfReader(opts.pdfOcrReader);
  }
}
