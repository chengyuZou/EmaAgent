// ── Document block (reader output) ───────────────────────────────────────────

export type DocumentBlockKind =
  | 'title'
  | 'paragraph'
  | 'list_item'
  | 'caption'
  | 'table'
  | 'code'
  | 'image';

export interface DocumentBlock {
  id:          string;
  kind:        DocumentBlockKind;
  text:        string;
  markdown?:   string;
  /** Heading depth 1–6. Only present when kind = 'title'. */
  level?:      number;
  /** 1-based page number. Undefined for formats without pages. */
  page?:       number;
  /** Ancestor heading breadcrumb, e.g. ['Intro', 'Motivation']. */
  sectionPath: string[];
}

/** Reader output grouped by page (for preview/thumbnail generation). */
export interface DocumentPage {
  pageNum: number;
  blocks:  DocumentBlock[];
}

// ── Document asset ────────────────────────────────────────────────────────────

export type DocumentIndexStatus = 'pending' | 'indexing' | 'indexed' | 'error';
export type DocumentScope       = 'global' | 'session';

export interface DocumentAsset {
  id:          string;
  scope:       DocumentScope;
  /** Only present when scope = 'session'. */
  sessionId?:  string;
  filePath:    string;
  fileName:    string;
  mimeType:    string;
  title?:      string;
  wordCount:   number;
  pageCount?:  number;
  status:      DocumentIndexStatus;
  contentHash?: string;
  createdAt:   number;
  updatedAt:   number;
}

// ── Document chunk (chunker output, stored in DB) ─────────────────────────────

export interface DocumentChunk {
  id:          string;
  /** Set by the ingest layer after the asset row exists. Optional so chunkers
   *  can produce chunks before the DB write. */
  assetId?:    string;
  text:        string;
  markdown?:   string;
  blockKinds:  DocumentBlockKind[];
  tokenCount:  number;
  page?:       number;
  sectionPath: string[];
  prev?:       string;
  next?:       string;
}

// ── Preview ───────────────────────────────────────────────────────────────────

export interface DocumentPreview {
  assetId:        string;
  text:           string;
  thumbnail?:     Uint8Array;
  thumbnailMime?: 'image/png';
  pageCount?:     number;
  wordCount:      number;
}

// ── Ingest ────────────────────────────────────────────────────────────────────

export interface IngestOptions {
  scope:      DocumentScope;
  sessionId?: string;
  /** Vision provider id for image/scanned-PDF OCR. */
  visionProviderId?: string;
  visionModel?:      string;
  /** Embedding provider for semantic chunking (optional; falls back to sentence chunker). */
  ebdProviderId?: string;
  ebdModel?:      string;
  /** Override auto-detected MIME type. */
  mimeType?: string;
  signal?:   AbortSignal;
}

export interface IngestResult {
  asset:   DocumentAsset;
  chunks:  number;
  preview: DocumentPreview;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  scope:      DocumentScope;
  sessionId?: string;
  topK?:      number;
  /** BM25 / vector blend weight (0 = pure BM25, 1 = pure vector). Default 0.5. */
  alpha?:     number;
  /** Embedding provider for dense retrieval (optional). */
  ebdProviderId?:    string;
  ebdModel?:         string;
  /** Reranker provider (optional; applied after hybrid fusion). */
  rerankProviderId?: string;
  rerankModel?:      string;
  signal?:           AbortSignal;
}
