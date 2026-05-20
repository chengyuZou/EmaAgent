// ── Façade ───────────────────────────────────────────────────────────────────
export { MemoryPlanner } from './planner.js';

// ── Public types ─────────────────────────────────────────────────────────────
export type { MemoryDeps } from './deps.js';
export type {
  PlanContext,
  RecallBundle,
  GraphRecallResult,
  EpisodicRecallResult,
  NarrativeRecallResult,
  RecalledNode,
  RecalledEdge,
  RecalledItem,
  MemorySettings,
  EmbeddedText,
  AlreadySurfaced,
} from './types.js';
export { DEFAULT_MEMORY_SETTINGS } from './types.js';

// ── Sub-utilities (exported for testing / advanced wiring) ───────────────────
export { EmbedService } from './embed/service.js';
export {
  normalize,
  dotProduct,
  cosineSim,
  packEmbedding,
  unpackEmbedding,
  normalizeQueryVector,
} from './embed/similarity.js';
export { estimateTextTokens, estimateMessagesTokens } from './tokens/estimate.js';

// ── Vector index ─────────────────────────────────────────────────────────────
export { createVectorIndex }                  from './index/factory.js';
export { BruteForceIndex }                    from './index/brute-force.js';
export { UsearchIndex }                       from './index/usearch.js';
export { rebuildNodesIndex, rebuildItemsIndex } from './index/builder.js';
export type { VectorIndex, SearchHit }        from './index/vector-index.js';

// ── Extraction pipeline ──────────────────────────────────────────────────────
export { runExtractionPipeline }              from './extract/pipeline.js';
export type { PipelineResult }                from './extract/pipeline.js';
export type {
  ExtractedNode, ExtractedEdge, ExtractedItem, ExtractionOutput,
  ConsolidationOutput, PendingFragment,
} from './extract/types.js';

// ── Background tasks + recovery ──────────────────────────────────────────────
export { SessionTaskQueue }                   from './tasks/session-queue.js';
export { BackgroundTaskRunner }               from './tasks/runner.js';
export { runStartupRecovery }                 from './tasks/recovery.js';
export type { RecoveryReport }                from './tasks/recovery.js';

// ── Compaction ───────────────────────────────────────────────────────────────
export { microCompact }                       from './compact/micro.js';
export { runMacroCompaction }                 from './compact/macro.js';
export type { MacroCompactArgs, MacroCompactResult } from './compact/macro.js';
export { buildPostCompactRestore }            from './compact/restore.js';
export type { RestoreContext }                from './compact/restore.js';

// ── Hooks ────────────────────────────────────────────────────────────────────
export { registerMemoryHooks }                from './hooks.js';
export type { MemoryHooksDeps, RecentFilesProvider } from './hooks.js';
