import type { ParsedDocument, Element, DocumentMeta } from './types.js';
import type { ReaderSource } from './readers/base.js';
import { TextReader }  from './readers/text.js';
import { HtmlReader }  from './readers/html.js';
import { DocxReader }  from './readers/docx.js';
import { PdfReader }   from './readers/pdf.js';
import type { ImageReader } from './readers/image.js';

const MIME_TO_READER: Record<string, 'text' | 'html' | 'docx' | 'pdf'> = {
  'text/plain':                   'text',
  'text/markdown':                'text',
  'text/html':                    'html',
  'application/msword':           'docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/pdf':              'pdf',
};

const EXT_TO_MIME: Record<string, string> = {
  txt:  'text/plain',
  md:   'text/markdown',
  mdx:  'text/markdown',
  ts:   'text/plain',
  tsx:  'text/plain',
  js:   'text/plain',
  jsx:  'text/plain',
  py:   'text/plain',
  go:   'text/plain',
  rs:   'text/plain',
  java: 'text/plain',
  json: 'text/plain',
  yaml: 'text/plain',
  yml:  'text/plain',
  toml: 'text/plain',
  html: 'text/html',
  htm:  'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc:  'application/msword',
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
};

export interface ParseOptions {
  /** Explicit MIME type — overrides extension-based detection. */
  mimeType?:   string;
  /** ImageReader instance — required for image/* sources. */
  imageReader?: ImageReader;
}

/**
 * Parse a document source into a structured element list.
 * Selects the right reader based on MIME type or file extension.
 */
export async function parseDocument(
  source:  ReaderSource,
  options: ParseOptions = {},
): Promise<ParsedDocument> {
  const name     = source.kind === 'path' ? source.path : source.name;
  const ext      = name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = options.mimeType ?? EXT_TO_MIME[ext] ?? 'text/plain';

  let elements: Element[];

  if (mimeType.startsWith('image/')) {
    if (!options.imageReader) {
      throw new Error('[document] imageReader is required for image/* sources');
    }
    elements = await options.imageReader.read(source);
  } else {
    const readerKind = MIME_TO_READER[mimeType] ?? 'text';
    elements = await selectReader(readerKind).read(source);
  }

  const meta: DocumentMeta = {
    fileName:  name.split('/').pop() ?? name,
    mimeType,
    title:     elements.find(e => e.kind === 'title')?.text,
    wordCount: elements.reduce((n, e) => n + e.text.split(/\s+/).filter(Boolean).length, 0),
  };

  return { elements, meta };
}

function selectReader(kind: 'text' | 'html' | 'docx' | 'pdf') {
  switch (kind) {
    case 'text': return new TextReader();
    case 'html': return new HtmlReader();
    case 'docx': return new DocxReader();
    case 'pdf':  return new PdfReader();
  }
}
