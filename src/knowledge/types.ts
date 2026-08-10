// ── Document block (reader output) ───────────────────────────────────────────
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
  /** 预算耗尽后降级为引用卡：text 只有命中块预览，正文未展开。 */
  citationOnly?: boolean;
}

export interface KbSearchResult {
  query: string;
  hits: KbSearchHit[];
}

/** Knowledge 检索的一次完整请求；宿主在转交给 Tool 前冻结文档范围。 */
export interface KnowledgeSearchRequest {
  readonly query: string;
  readonly topK?: number;
  /** 活跃库内的文档范围;由宿主按用户选择冻结注入。 */
  readonly assetIds?: readonly string[];
  readonly signal?: AbortSignal;
}

/** Tool、Turn 与进程宿主共同复用的唯一 Knowledge 检索入口。 */
export type KnowledgeSearch = (
  request: KnowledgeSearchRequest,
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
  /** staging 后 asset.filePath 写入的 KB 相对路径；缺省时回退为读取路径。 */
  stagedRelativePath?: string;
  /** Override auto-detected MIME type. */
  mimeType?: string;
  signal?:   AbortSignal;
}

export interface IngestResult {
  asset:        DocumentAsset;
  chunks:       number;
  preview:      DocumentPreview;
  /** PDF 等 Reader 忽略的局部问题；不改变任务完成状态。 */
  warnings?: readonly string[];
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** 活跃库内的文档范围过滤;undefined = 全库。显式空范围由调用方语义处理。 */
  assetIds?:  readonly string[];
  topK?:      number;
  /** BM25 / vector blend weight (0 = pure BM25, 1 = pure vector). Default 0.5. */
  alpha?:     number;
  /** rerank 分在混合排序中的权重（0-1）；缺省由实现默认值决定。 */
  rerankBlendWeight?: number;
  /** 命中正文的总字符预算；超出后低分命中降级为 citation-only 引用卡。 */
  maxResultChars?: number;
  signal?:           AbortSignal;
}
