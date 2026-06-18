// ── Element ───────────────────────────────────────────────────────────────────

export type ElementKind =
  | 'title'
  | 'paragraph'
  | 'list_item'
  | 'caption'
  | 'table'
  | 'code'
  | 'image';

export interface Element {
  id:           string;
  kind:         ElementKind;
  /** Plain text content. For images this is the alt text or OCR result. */
  text:         string;
  /** Markdown representation — preserved for table/code; undefined otherwise. */
  markdown?:    string;
  /** Heading depth: 1 = h1/title, 2 = h2, … Only present on kind='title'. */
  level?:       number;
  /** 1-based page number from the source document. */
  page?:        number;
  /**
   * Breadcrumb of ancestor title texts at the point this element was parsed,
   * e.g. ['Introduction', 'Motivation']. Populated by readers that track
   * heading hierarchy; empty array when unknown.
   */
  sectionPath:  string[];
}

// ── Chunk ─────────────────────────────────────────────────────────────────────

export interface ChunkSource {
  fileName:    string;
  mimeType:    string;
  page?:       number;
  sectionPath: string[];
}

export interface Chunk {
  id:           string;
  text:         string;
  markdown?:    string;
  elementKinds: ElementKind[];
  tokenCount:   number;
  source:       ChunkSource;
  /** Id of the preceding chunk — enables context-window expansion at retrieval. */
  prev?:        string;
  /** Id of the following chunk. */
  next?:        string;
}

// ── ParsedDocument ────────────────────────────────────────────────────────────

export interface DocumentMeta {
  fileName:   string;
  mimeType:   string;
  title?:     string;
  pageCount?: number;
  wordCount:  number;
}

export interface ParsedDocument {
  elements: Element[];
  meta:     DocumentMeta;
}

// ── Preview ───────────────────────────────────────────────────────────────────

export interface DocumentPreview {
  /** First ~400 chars of meaningful body text (skips titles). */
  text:           string;
  /** PNG thumbnail, present for images and PDFs when canvas is available. */
  thumbnail?:     Uint8Array;
  thumbnailMime?: 'image/png';
  pageCount?:     number;
  wordCount:      number;
}
