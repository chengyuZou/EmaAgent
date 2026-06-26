// ── Document block (reader output) ───────────────────────────────────────────
import type { KbAssetScope } from '@ema-agent/contracts';

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
export interface DocumentAsset {
  id:          string;
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
  /** Times this KB has been selected for a turn. */
  useCount:    number;
  /** Last time selected for a turn (ms). Undefined → never; UI falls back to createdAt. */
  lastActivatedAt?: number;
}

/** One page of a cursor-paginated asset list. */
export interface AssetListPage {
  items:      DocumentAsset[];
  /** createdAt cursor to pass for the next page; null = no more. */
  nextCursor: number | null;
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
  // ── Parent-child (small-to-big) retrieval (RAGFlow-style) ─────────────────
  /** Parent ("mom") window id this child belongs to. Children of the same
   *  parent share it; undefined when parent-child is disabled. */
  momId?:      string;
  /** Full text of the parent window. Carried on each child so retrieval can
   *  return the larger parent context without a separate parent row (mirrors
   *  RAGFlow's mom_with_weight). */
  momText?:    string;
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
  /** Pre-generated asset id (so the caller can return it before ingest finishes
   *  and correlate background progress events). Defaults to a fresh uuid. */
  assetId?: string;
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
  /** Per-KB document scope from the chat picker. KbManager uses this to pass the
   *  right assetIds to each KB's client. Ignored by KnowledgeClient.search() directly. */
  assetScopes?: KbAssetScope[];
  /** Single-KB asset filter (used by KnowledgeClient.search() internally). */
  assetIds?:  string[];
  topK?:      number;
  /** BM25 / vector blend weight (0 = pure BM25, 1 = pure vector). Default 0.5. */
  alpha?:     number;
  /** Embedding provider for dense retrieval (optional). */
  ebdProviderId?:    string;
  ebdModel?:         string;
  /** Reranker provider (optional; applied after hybrid fusion). */
  rerankProviderId?: string;
  rerankModel?:      string;
  /** Turn context for activation logging (kb_activations). Omit → no per-session log. */
  sessionId?:        string;
  turnId?:           string;
  signal?:           AbortSignal;
}
