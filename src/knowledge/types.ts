import type { EmbeddingModel } from '@ema-agent/embed';
import type { Reranker } from '@ema-agent/rerank';
import type { VisionModel } from '@ema-agent/vision';

// ── 模型选择（装配层解析 model_bindings 后注入）────────────────────────────────
export interface KnowledgeEmbeddingSelection {
  readonly providerId: string;
  readonly model: string;
  readonly embedding: EmbeddingModel;
}

export interface KnowledgeRerankSelection {
  readonly model: string;
  readonly reranker: Reranker;
}

export interface KnowledgeVisionSelection {
  readonly model: string;
  readonly vision: VisionModel;
}

// ── 文档块（reader 输出）──────────────────────────────────────────────────────
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
  /** 标题层级 1–6；仅当 kind = 'title' 时存在。 */
  level?:      number;
  /** 从 1 起的页码；无分页的格式为 undefined。 */
  page?:       number;
  /** 祖先标题面包屑，例如 ['Intro', 'Motivation']。 */
  sectionPath: string[];
  /**
   * 内容来源: text-layer=PDF 文本层, vision-ocr=Vision 整页识字,
   * vision-figure=Vision 图表描述。reader 不负责填写时缺省,
   * 供 provenance 追踪与后续按来源选择性重处理。
   */
  source?:     'text-layer' | 'vision-ocr' | 'vision-figure';
}

/** reader 按页分组的输出（供预览/缩略图生成）。 */
export interface DocumentPage {
  pageNum: number;
  blocks:  DocumentBlock[];
}

// ── 文档资产 ──────────────────────────────────────────────────────────────────

export type DocumentIndexStatus = 'indexing' | 'ready' | 'failed';
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
  /** 该 KB 被选入某个 Turn 的次数。 */
  useCount:    number;
  /** 最近一次被选入 Turn 的时间（毫秒）；undefined = 从未，UI 回退用 createdAt。 */
  lastActivatedAt?: number;
  embeddingProviderId?: string;
  embeddingModel?:   string;
  embeddingDim?:     number;
  embeddingSpaceId?: string;
  embeddingStale?:   boolean;
}

/** 游标分页资产列表的一页。 */
export interface AssetListPage {
  items:      DocumentAsset[];
  /** V1 不透明复合游标，用于取下一页；null = 没有更多。 */
  nextCursor: string | null;
}

// ── 文档分块（chunker 输出，存入 DB）──────────────────────────────────────────

export interface DocumentChunk {
  id:          string;
  /** 由 ingest 层在资产行落库后写入；可选是为了让 chunker 可以在写库前先产出分块。 */
  assetId?:    string;
  text:        string;
  markdown?:   string;
  blockKinds:  DocumentBlockKind[];
  tokenCount:  number;
  page?:       number;
  sectionPath: string[];
  // ── 父子（小到大）检索（RAGFlow 风格）─────────────────────────────────────
  /** 该子块所属的父窗口 id；同一父块的子块共享此值；未启用父子模式时为 undefined。 */
  parentId?:   string;
  /** 父窗口的完整文本；随每个子块携带，检索时无需独立父行即可返回更大的父上下文。 */
  parentText?: string;
}

// ── 预览 ─────────────────────────────────────────────────────────────────────

export interface DocumentPreview {
  assetId:        string;
  text:           string;
  thumbnail?:     Uint8Array;
  thumbnailMime?: 'image/png';
  pageCount?:     number;
  wordCount:      number;
}

// ── 摄取（Ingest）─────────────────────────────────────────────────────────────

export interface IngestOptions {
  /** 预生成的资产 id（让调用方能在 ingest 完成前先返回它，并关联后台进度事件）；缺省生成新 uuid。 */
  assetId?: string;
  /** staging 后 asset.filePath 写入的 KB 相对路径；缺省时回退为读取路径。 */
  stagedRelativePath?: string;
  /** 覆盖自动探测的 MIME 类型。 */
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

// ── 检索 ──────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** 活跃库内的文档范围过滤;undefined = 全库。显式空范围由调用方语义处理。 */
  assetIds?:  readonly string[];
  topK?:      number;
  /** BM25 / 向量混合权重（0 = 纯 BM25，1 = 纯向量）。默认 0.5。 */
  alpha?:     number;
  /** rerank 分在混合排序中的权重（0-1）；缺省由实现默认值决定。 */
  rerankBlendWeight?: number;
  /** 命中正文的总字符预算；超出后低分命中降级为 citation-only 引用卡。 */
  maxResultChars?: number;
  signal?:           AbortSignal;
}
