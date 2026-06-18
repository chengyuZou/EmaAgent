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
} from '@ema-agent/storage';
import type { SessionStore } from '@ema-agent/session';
import type { LlmRouter } from '@ema-agent/llm';
import type { EbdRouter } from '@ema-agent/ebd-client';
import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── External dependencies ─────────────────────────────────────────────────────

/**
 * Every MemoryPlanner instance receives the full set of repos + clients it
 * needs. The orchestrator builds these once per process and passes them in.
 */
export interface MemoryDeps {
  session:        SessionStore;
  llm:            LlmRouter;
  ebd:            EbdRouter;
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

  /**
   * Returns the vector dimension for a given embed model name.
   * Looks up embed_model_catalog in profileDb — kept as a callback so the
   * memory package does not depend on @ema-agent/storage directly.
   */
  getEmbedDim:    (model: string) => number;

  /**
   * Observability hook — pipeline / runner / maintenance push lifecycle
   * events here. The orchestrator wires this to the SystemEventBus so the
   * frontend can render them as bubbles. Optional: tests omit it.
   */
  emit?:          (ev: EmaStreamEvent) => void;
}
