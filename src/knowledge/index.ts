// 导出 Knowledge 对外稳定入口，内部队列、数据库与检索算法不穿透模块边界。

export { KbManager } from './manager.js';
export type { KbManagerDeps } from './manager.js';
export { KnowledgeClient } from './client.js';
export type {
  KnowledgeClientDeps,
} from './client.js';
export type {
  CallEmbed,
  CallEmbedResult,
} from './types.js';
export type { KnowledgeEvent } from './events.js';
export type {
  AssetListPage,
  DocumentAsset,
  DocumentBlock,
  DocumentBlockKind,
  DocumentChunk,
  DocumentIndexStatus,
  DocumentPage,
  DocumentPreview,
  DocumentSourceRef,
  IngestOptions,
  IngestResult,
  KbSearchHit,
  KbSearchResult,
  KnowledgeSearch,
  KnowledgeSearchRequest,
  SearchOptions,
} from './types.js';
export { PdfReader } from './readers/pdf.js';
export type { PdfReadRange } from './readers/pdf.js';
export { ImageReader } from './readers/image.js';
export type { ImageReaderOptions } from './readers/image.js';
export {
  DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS,
  kbAlphaSetting,
  kbDefaultTopKSetting,
  kbRerankBlendWeightSetting,
  kbResultMaxCharsSetting,
  readKnowledgeRetrievalSettings,
} from './settings.js';
export type {
  KnowledgeRetrievalSettings,
} from './settings.js';
export {
  KnowledgeDocumentProcessingError,
  KnowledgeEmbeddingSpaceMismatchError,
  KnowledgeInvalidRequestError,
  KnowledgeNotConfiguredError,
} from './errors.js';
