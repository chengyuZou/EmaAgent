// ── Document block (reader output) ───────────────────────────────────────────
import type { KbAssetScope } from '@ema-agent/turn';

export interface DocumentSourceRef {
  assetId: string;
  fileName: string;
  page?: number;
  sectionPath: string[];
  /** 匹配分块的短预览，供引用界面展示。 */
  chunkPreview: string;
}

export interface KbSearchHit {
  chunkId: string;
  text: string;
  markdown?: string;
  score: number;
  source: DocumentSourceRef;
}

export interface KbSearchResult {
  query: string;
  hits: KbSearchHit[];
}

/** Tool 等外部消费者调用 Knowledge 检索时使用的稳定执行入口。 */
export type KnowledgeSearchPort = (
  query: string,
  topK?: number,
  kbIds?: string[],
) => Promise<KbSearchResult>;

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
  /**
   * 内容来源: text-layer=PDF 文本层, vision-ocr=Vision 整页识字,
   * vision-figure=Vision 图表描述。reader 不负责填写时缺省,
   * 供 provenance 追踪与后续按来源选择性重处理。
   */
  source?:     'text-layer' | 'vision-ocr' | 'vision-figure';
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
  ebdProviderId?:   string;
  ebdModel?:        string;
  ebdDim?:          number;
  ebdNormalization?: string;
  ebdRevision?:     string;
  ebdSpaceId?:      string;
  ebdStale?:        boolean;
}

/** One page of a cursor-paginated asset list. */
export interface AssetListPage {
  items:      DocumentAsset[];
  /** V1 opaque composite cursor to pass for the next page; null = no more. */
  nextCursor: string | null;
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
  /** 持久队列任务 ID；与 assetId 分离，只由 IngestQueue 注入。 */
  taskId?: string;
  /** 当前任务尝试次数，用于拒绝上一轮迟到的进度事件。 */
  attempt?: number;
  /** partial_failed 重试时只处理这些失败 chunk。 */
  retryChunkIds?: string[];
  /** 页级解析失败重试时替换上一轮的文档、chunk 与 preview。 */
  replaceExistingAsset?: boolean;
  /** staging 后 asset.filePath 写入的 KB 相对路径；缺省时回退为读取路径。 */
  stagedRelativePath?: string;
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

export interface IngestFailureShard {
  stage:      'parse' | 'embed';
  shardKey:   string;
  itemIds:    string[];
  retryable:  boolean;
  errorCode?: string;
  error:      string;
}

export interface IngestItemCounts {
  total:     number;
  completed: number;
  failed:    number;
}

export interface IngestResult {
  asset:        DocumentAsset;
  chunks:       number;
  preview:      DocumentPreview;
  outcome:      'completed' | 'partial_failed';
  counts:       IngestItemCounts;
  failureShards: IngestFailureShard[];
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
