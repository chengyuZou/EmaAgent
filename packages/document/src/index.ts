// ── Parse ─────────────────────────────────────────────────────────────────────
export { parseDocument } from './parse.js';
export type { ParseOptions } from './parse.js';

// ── Preview ───────────────────────────────────────────────────────────────────
export { buildPreview } from './preview.js';

// ── Readers ───────────────────────────────────────────────────────────────────
export { TextReader }  from './readers/text.js';
export { HtmlReader }  from './readers/html.js';
export { DocxReader }  from './readers/docx.js';
export { PdfReader }   from './readers/pdf.js';
export { ImageReader } from './readers/image.js';
export type { DocumentReader, ReaderSource } from './readers/base.js';

// ── Chunking ──────────────────────────────────────────────────────────────────
export { HeadingChunker }                                  from './chunking/heading.js';
export { tokenChunk }                                      from './chunking/token.js';
export { slidingChunk, SlidingChunker }                    from './chunking/sliding.js';
export { SentenceChunker }                                 from './chunking/sentence.js';
export {
  SemanticChunker,
  EmbeddingCallError,
  SemanticFallbackWarning,
} from './chunking/semantic.js';
export type { SemanticChunkOptions }                       from './chunking/semantic.js';
export type { Chunker, ChunkOptions }                      from './chunking/base.js';
export { DEFAULT_CHUNK_OPTIONS }                           from './chunking/base.js';

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  Element,
  ElementKind,
  Chunk,
  ChunkSource,
  ParsedDocument,
  DocumentMeta,
  DocumentPreview,
} from './types.js';
