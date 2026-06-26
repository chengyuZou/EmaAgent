// ── Public Façade ──────────────────────────────────────────────────────────────
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
} from './types.js';

// ── Events ─────────────────────────────────────────────────────────────────────
export { DocumentEventEmitter }                         from './events/index.js';
export type { DocumentProgressEvent, DocumentProgressKind } from './events/index.js';

// ── Adapters ───────────────────────────────────────────────────────────────────
export type { KbVisionAdapter } from './adapters/vision.js';
export { NodeFsAdapter }        from './adapters/fs.js';
export type { FsAdapter }       from './adapters/fs.js';

// ── Retrieval (hybrid only; FTS5 + vector live in storage repos) ───────────────
export { weightedRank }         from './retrieval/hybrid.js';
export type { RankedHit }       from './retrieval/hybrid.js';

// ── Ingest queue (concurrency-limited, persistent — package owns its task runner) ─
export { IngestQueue }          from './ingest/queue.js';
export type { IngestQueueDeps } from './ingest/queue.js';

// ── Chunkers ───────────────────────────────────────────────────────────────────
export { RecursiveChunker, recursiveChunk }                            from './chunking/recursive.js';
export { SemanticChunker, EmbeddingCallError, SemanticFallbackWarning } from './chunking/semantic.js';
export type { ChunkOptions, Chunker }                                   from './chunking/base.js';
export type { SemanticChunkOptions }                                    from './chunking/semantic.js';

// ── Vector index (exposed for benchmarking / advanced callers) ─────────────────
export { BruteForceIndex }       from './index/brute-force.js';
export { createVectorIndex }     from './index/factory.js';
export type { VectorIndex, SearchHit } from './index/vector-index.js';

// ── Adapters (types only) ─────────────────────────────────────────────────────
export type { KbHydeAdapter }          from './adapters/hyde.js';
export type { KbAutoQuestionAdapter }  from './adapters/auto-questions.js';
export type { ReembedOptions }         from './client.js';
