import type {
  MemoryNodesRepo,
  MemoryEdgesRepo,
  MemoryLazyUpdatesRepo,
  MemoryItemsRepo,
  SessionNotesRepo,
  MemoryTasksRepo,
  SessionsRepo,
  PendingFragmentsRepo,
  ModelBindingsRepo,
} from '@ema-agent/storage';
import type { SessionStore } from '@ema-agent/session';
import type { LlmRouter } from '@ema-agent/llm';
import type { EbdRouter } from '@ema-agent/ebd-client';
import type { NarrativeClient } from '@ema-agent/narrative-client';
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
  narrative:      NarrativeClient;
  modelBindings:  ModelBindingsRepo;

  // Storage repos owned by the memory subsystem
  nodes:          MemoryNodesRepo;
  edges:          MemoryEdgesRepo;
  lazyUpdates:    MemoryLazyUpdatesRepo;
  items:          MemoryItemsRepo;
  sessionNotes:      SessionNotesRepo;
  memoryTasks:   MemoryTasksRepo;
  sessions:          SessionsRepo;         // meta_json, overrides, turn concurrency
  pendingFragments:  PendingFragmentsRepo; // extraction input queue

  /**
   * Observability hook — pipeline / runner / maintenance push lifecycle
   * events here. The orchestrator wires this to the SystemEventBus so the
   * frontend can render them as bubbles. Optional: tests omit it.
   */
  emit?:          (ev: EmaStreamEvent) => void;
}
