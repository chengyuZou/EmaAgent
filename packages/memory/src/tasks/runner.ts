import crypto from 'node:crypto';
import type { SessionId, TurnMode } from '@ema-agent/contracts';
import type {
  BackgroundTaskKind, BackgroundTaskRow,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { MemorySettings } from '../types.js';
import { EmbedService }     from '../embed/service.js';
import { SessionTaskQueue } from './session-queue.js';
import { runExtractionPipeline } from '../extract/pipeline.js';
import type { VectorIndex } from '../index/vector-index.js';
import type { ResolvedSessionOverrides } from '../maintenance/overrides.js';

// ── Background task runner ───────────────────────────────────────────────────

export interface BackgroundTaskRunnerDeps {
  memory:     MemoryDeps;
  embed:      EmbedService;
  settings:   MemorySettings;
  queue:      SessionTaskQueue;
  /**
   * Getters because indexes are built lazily in MemoryPlanner.initialize(),
   * but the runner is constructed earlier. Returning the latest reference
   * at dispatch time avoids stale captures.
   */
  getNodesIndex: () => VectorIndex | null;
  getItemsIndex: () => VectorIndex | null;
  /** Resolves per-session overrides — used to skip consolidation when off. */
  getSessionOverrides: (sessionId: SessionId) => ResolvedSessionOverrides;
}

/**
 * Drains the background_tasks table using a polling loop. The orchestrator
 * is expected to invoke `tick()` periodically (e.g. every 5 s) AND ad-hoc
 * after enqueueing a task via the planner.
 *
 * Cross-session concurrency is allowed — only same-session work is serialised
 * via SessionTaskQueue.
 */
export class BackgroundTaskRunner {
  private running = false;

  constructor(private readonly deps: BackgroundTaskRunnerDeps) {}

  /** Enqueue a fresh task. Returns the task id so callers can correlate. */
  enqueue(kind: BackgroundTaskKind, sessionId: SessionId | null, payload: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    this.deps.memory.backgroundTasks.enqueue({
      id,
      kind,
      sessionId: sessionId ?? undefined,
      payload,
      createdAt: Date.now(),
    });
    // Best-effort immediate kick — caller can also drive via tick()
    void this.tick();
    return id;
  }

  /**
   * Process all available pending tasks until none remain. Re-entrant safe:
   * a second tick() while one is running is a no-op.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const row = this.deps.memory.backgroundTasks.claimNext(Date.now());
        if (!row) break;
        await this.dispatch(row);
      }
    } finally {
      this.running = false;
    }
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  private async dispatch(row: BackgroundTaskRow): Promise<void> {
    try {
      switch (row.kind) {
        case 'extraction':
          await this.handleExtraction(row);
          break;
        case 'consolidation':
          await this.handleConsolidation(row);
          break;
        case 'compaction':
          // Reserved for Round 4 — short-circuit for now
          break;
        case 'embedding_refresh':
          // Reserved — runs when ebd provider changes; Round 4.5
          break;
      }
      this.deps.memory.backgroundTasks.markCompleted(row.id, Date.now());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.memory.backgroundTasks.markFailed(row.id, msg, Date.now(), 3);
    }
  }

  // ── Extraction handler ─────────────────────────────────────────────────────

  private async handleExtraction(row: BackgroundTaskRow): Promise<void> {
    const payload = JSON.parse(row.payload_json) as {
      sessionId?: string;
      mode?:      TurnMode;
    };
    if (!payload.sessionId || !payload.mode) return;
    const sid = payload.sessionId as SessionId;

    // Honour per-session override: consolidation can be skipped without
    // breaking extraction — lazy_updates simply stay buffered.
    const overrides = this.deps.getSessionOverrides(sid);
    const skipConsolidation = !overrides.consolidation;

    await this.deps.queue.enqueue(sid, async () => {
      await runExtractionPipeline(
        {
          memory:     this.deps.memory,
          embed:      this.deps.embed,
          settings:   this.deps.settings,
          nodesIndex: this.deps.getNodesIndex(),
          itemsIndex: this.deps.getItemsIndex(),
        },
        { sessionId: sid, mode: payload.mode!, skipConsolidation },
      );
    });
  }

  // ── Consolidation handler (rare standalone case) ──────────────────────────

  private async handleConsolidation(_row: BackgroundTaskRow): Promise<void> {
    // Consolidation usually runs inline at the end of extraction. A standalone
    // consolidation task can be useful for periodic maintenance — kept as a
    // no-op for V1 until we wire a maintenance scheduler.
  }
}
