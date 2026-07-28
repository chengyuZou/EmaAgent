// ── Public Facade ──────────────────────────────────────────────────────────────
export { KnowledgeClient }          from './client.js';
export type { KnowledgeClientDeps } from './client.js';
export { KnowledgeStore }           from './store/index.js';
export { KbManager }                from './manager.js';
export type { KbManagerDeps, KbEntry } from './manager.js';

// ── Types ──────────────────────────────────────────────────────────────────────
export type {
  DocumentBlock, DocumentBlockKind,
  DocumentPage,
  DocumentAsset, DocumentIndexStatus, AssetListPage,
  DocumentChunk,
  DocumentPreview,
  IngestOptions, IngestResult,
  SearchOptions,
  DocumentSourceRef,
  KbSearchHit,
  KbSearchResult,
  KnowledgeSearchPort,
} from './types.js';
export { PdfReader } from './readers/pdf.js';
export type { PdfReadRange } from './readers/pdf.js';

// ── Events ─────────────────────────────────────────────────────────────────────
export { DocumentEventEmitter }                         from './events/index.js';
export type { DocumentProgressEvent, DocumentProgressKind } from './events/index.js';
export type { KnowledgeEvent } from './events.js';

// ── Adapters ───────────────────────────────────────────────────────────────────
export { KbVisionAdapterError, isKbVisionAdapterError } from './adapters/vision.js';
export type { KbVisionAdapter, KbVisionTask } from './adapters/vision.js';

// ── Retrieval (hybrid only; FTS5 + vector live in storage repos) ───────────────
export { weightedRank }         from './retrieval/hybrid.js';
export type { RankedHit }       from './retrieval/hybrid.js';

// ── Ingest queue (concurrency-limited, persistent — package owns its task runner) ─
export { IngestQueue }          from './ingest/queue.js';
export type { IngestQueueDeps, IngestRuntimeOptions } from './ingest/queue.js';

// ── Reembed queue (重建索引后台任务, 与 ingest 队列同型) ──────────────────────────
export { ReembedQueue }         from './reembed/queue.js';
export type { ReembedQueueDeps, ReembedSweepInput, ReembedSweepOutcome } from './reembed/queue.js';

// ── Chunkers ───────────────────────────────────────────────────────────────────
export { RecursiveChunker, recursiveChunk }                            from './chunking/recursive.js';
export { SemanticChunker, SemanticFallbackWarning }                    from './chunking/semantic.js';
export type { ChunkOptions, Chunker }                                   from './chunking/base.js';
export type { SemanticChunkOptions }                                    from './chunking/semantic.js';

// ── Errors (embed 路径统一错误码) ──────────────────────────────────────────────
export { KbError, isKbError, classifyKbError } from './errors.js';
export type { KbErrorCode, KbErrorMeta }       from './errors.js';
export { knowledgeModelsSetting } from './settings.js';
export type {
  KnowledgeModelRef,
  KnowledgeModelSettings,
} from './settings.js';

// ── Vector index (exposed for benchmarking / advanced callers) ─────────────────
export { BruteForceIndex }       from './index/brute-force.js';
export { createVectorIndex }     from './index/factory.js';
export type { VectorIndex, SearchHit } from './index/vector-index.js';

// ── Adapters (types only) ─────────────────────────────────────────────────────
export type { KbHydeAdapter }          from './adapters/hyde.js';
export type { KbAutoQuestionAdapter }  from './adapters/auto-questions.js';
