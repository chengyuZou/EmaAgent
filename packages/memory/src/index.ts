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
export { EmbedService }                      from './embed/service.js';
export { cosineSim, packEmbedding, unpackEmbedding } from './embed/similarity.js';
export { estimateTextTokens, estimateMessagesTokens } from './tokens/estimate.js';
