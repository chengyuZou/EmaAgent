import type {
  MemoryNodesRepo,
  MemoryEdgesRepo,
  MemoryLazyUpdatesRepo,
  MemoryItemsRepo,
  SessionNotesRepo,
  MemoryTasksRepo,
  MemorySessionStateRepo,
  PendingFragmentsRepo,
  ModelBindingsRepo,
  MemoryExtractionRunsRepo,
} from '@ema-agent/storage';
import type { SessionStore } from '@ema-agent/session';
import type { LanguageModel } from '@ema-agent/llm';
import type { EmbedRuntime } from '@ema-agent/embed';
import type { RerankRuntime } from '@ema-agent/rerank';
import type { MemoryEvent } from './events.js';

// ── External dependencies ─────────────────────────────────────────────────────

/**
 * Every MemoryPlanner instance receives the full set of repos + clients it
 * needs. The orchestrator builds these once per process and passes them in.
 */
export interface MemoryDeps {
  session:        SessionStore;
  llm:            LanguageModel;
  embedRuntime:   EmbedRuntime;
  rerankRuntime:  RerankRuntime;
  modelBindings:  ModelBindingsRepo;

  // Storage repos owned by the memory subsystem
  nodes:          MemoryNodesRepo;
  edges:          MemoryEdgesRepo;
  lazyUpdates:    MemoryLazyUpdatesRepo;
  items:          MemoryItemsRepo;
  sessionNotes:      SessionNotesRepo;
  memoryTasks:   MemoryTasksRepo;
  memorySessionState: MemorySessionStateRepo;
  pendingFragments:  PendingFragmentsRepo; // extraction input queue
  extractionRuns:    MemoryExtractionRunsRepo;

  /** profile.db 内的同步短事务；回调不得执行网络或其他异步 I/O。 */
  runProfileTransaction: <T>(work: () => T) => T;
  /** data.db 内的同步短事务；用于原子提交 session note 与 pending 清理。 */
  runDataTransaction:    <T>(work: () => T) => T;

  /**
   * Returns the vector dimension for an exact Provider + embed model identity.
   * Looks up provider_embed_models in profileDb — kept as a callback so the
   * memory package does not depend on @ema-agent/storage directly.
   */
  getEmbedDim:    (providerId: string, model: string) => number;

  /**
   * Observability hook — pipeline / runner / maintenance push lifecycle
   * events here. The orchestrator wires this to the SystemEventBus so the
   * frontend can render them as bubbles. Optional: tests omit it.
   */
  emit?:          (ev: MemoryEvent) => void;
}
