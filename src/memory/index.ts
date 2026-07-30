// 统一导出 Memory Facade、任务、压缩、向量索引和维护能力。
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
  MemoryRecallView,
  MemoryRecallPort,
  EmbeddedText,
  AlreadySurfaced,
} from './types.js';
export { DEFAULT_MEMORY_SETTINGS } from './types.js';
export {
  memoryModelsSetting,
  memoryMaintenanceSetting,
  memoryStorageSetting,
  DEFAULT_MEMORY_MAINTENANCE_SETTINGS,
  DEFAULT_MEMORY_STORAGE_SETTINGS,
} from './settings.js';
export type {
  MemoryModelRef,
  MemoryModelSettings,
  MemoryMaintenanceSettings,
  MemoryStorageSettings,
  MemoryUserSettingsSnapshot,
} from './settings.js';
export type {
  MemoryEvent,
  MemoryBackgroundEvent,
  MemoryRecallEvent,
  MemoryRecallLayer,
  MemoryRecallLayerReport,
  MemoryRecallLayerStatus,
} from './events.js';

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
// Token estimation moved to @ema-agent/token (shared with the frontend).
// Re-exported here for backward compatibility — prefer importing from
// @ema-agent/token directly in new code.
export { estimateTextTokens, estimateMessagesTokens } from '@ema-agent/token';

// ── Vector index ─────────────────────────────────────────────────────────────
export { createVectorIndex }                  from './vector-index/factory.js';
export { BruteForceIndex }                    from './vector-index/brute-force.js';
export { UsearchIndex }                       from './vector-index/usearch.js';
export { rebuildNodesIndex, rebuildItemsIndex } from './vector-index/rebuild.js';
export type { VectorIndex, SearchHit }        from './vector-index/vector-index.js';

// ── Extraction pipeline ──────────────────────────────────────────────────────
export { runExtractionPipeline }              from './extract/pipeline.js';
export type { PipelineResult }                from './extract/pipeline.js';
export type {
  ExtractedNode, ExtractedEdge, ExtractedItem, ExtractionOutput,
  ConsolidationOutput, PendingFragment,
} from './extract/types.js';

// ── Background tasks + recovery ──────────────────────────────────────────────
export { SessionTaskQueue }                   from './tasks/session-queue.js';
export { MemoryCommitCoordinator }            from './tasks/commit-coordinator.js';
export {
  MemoryTaskRunner,
  UnsupportedMemoryTaskKindError,
} from './tasks/extraction-runner.js';
export type { RunnableMemoryTaskKind } from './tasks/extraction-runner.js';
export { runStartupRecovery }                 from './tasks/recovery.js';
export type { RecoveryReport }                from './tasks/recovery.js';

// ── Hooks ────────────────────────────────────────────────────────────────────
export { registerMemoryHooks }                from './hooks.js';
export type { MemoryHooksDeps } from './hooks.js';

// ── Maintenance: overrides ───────────────────────────────────────────────────
export { DEFAULT_OVERRIDES }                  from './maintenance/overrides.js';
export type {
  MemorySessionOverrides,
  ResolvedSessionOverrides,
} from './maintenance/overrides.js';

// ── Maintenance: stats + inspection ──────────────────────────────────────────
export type { MemoryStats }                   from './maintenance/stats.js';
export type {
  BrowseNodesOptions,
  BrowseItemsOptions,
} from './maintenance/browse.js';

// ── Maintenance: decay + delete ──────────────────────────────────────────────           from './maintenance/decay.js';
export type {
  MaintenanceOptions,
  MaintenanceReport,
  MaintenancePreview,
} from './maintenance/decay.js';

// ── Maintenance: embedding 修复 ───────────────────────────────────────────────
export { repairStaleEmbeddings }              from './maintenance/embeddingRepair.js';
export type { EmbeddingRepairReport }         from './maintenance/embeddingRepair.js';
export { enforceMemoryStorageBudget }         from './maintenance/storageBudget.js';
export type { MemoryStorageBudgetReport }     from './maintenance/storageBudget.js';

// ── Errors ────────────────────────────────────────────────────────────────────
export { MemoryLeaseLostError }               from './errors.js';
export type { MemoryErrorCode }               from './errors.js';
