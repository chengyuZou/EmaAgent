import crypto from 'node:crypto';
import type { SessionId, TurnMode } from '@ema-agent/contracts';
import type {
  MemoryTaskKind, MemoryTaskRow,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import { bestEffort } from '../best-effort.js';
import type { MemorySettings } from '../types.js';
import { EmbedService }     from '../embed/service.js';
import { SessionTaskQueue } from './session-queue.js';
import { runExtractionPipeline } from '../extract/pipeline.js';
import type { VectorIndex } from '../vector-index/vector-index.js';
import type { ResolvedSessionOverrides } from '../maintenance/overrides.js';
import {
  MEMORY_TASK_CLEANUP_BATCH_SIZE,
  MEMORY_TASK_CLEANUP_INTERVAL_MS,
  MEMORY_TASK_HEARTBEAT_INTERVAL_MS,
  MEMORY_TASK_STALE_AFTER_MS,
  MEMORY_TASK_TERMINAL_RETENTION_MS,
} from './task-lease-policy.js';

// ── Background task runner ───────────────────────────────────────────────────

export interface MemoryTaskRunnerDeps {
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
  getIndexSpaceId: () => string | null;
  /** Resolves per-session overrides — used to skip consolidation when off. */
  getSessionOverrides: (sessionId: SessionId) => ResolvedSessionOverrides;
}

/**
 * Drains the memory_tasks table using a polling loop. The orchestrator
 * is expected to invoke `tick()` periodically (e.g. every 5 s) AND ad-hoc
 * after enqueueing a task via the planner.
 *
 * Cross-session concurrency is allowed — only same-session work is serialised
 * via SessionTaskQueue.
 */
export class MemoryTaskRunner {
  private running = false;
  private lastCleanupAt = 0;

  constructor(private readonly deps: MemoryTaskRunnerDeps) {}

  /** Enqueue a fresh task. Returns the task id so callers can correlate. */
  enqueue(kind: MemoryTaskKind, sessionId: SessionId, payload: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    this.deps.memory.memoryTasks.enqueue({
      id,
      kind,
      sessionId: sessionId,
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
      const recoveryAt = Date.now();
      this.deps.memory.memoryTasks.requeueExpiredRunning(
        recoveryAt - MEMORY_TASK_STALE_AFTER_MS,
        recoveryAt,
      );
      if (recoveryAt - this.lastCleanupAt >= MEMORY_TASK_CLEANUP_INTERVAL_MS) {
        this.deps.memory.memoryTasks.deleteTerminal(
          recoveryAt - MEMORY_TASK_TERMINAL_RETENTION_MS,
          MEMORY_TASK_CLEANUP_BATCH_SIZE,
        );
        this.lastCleanupAt = recoveryAt;
      }
      while (true) {
        const row = this.deps.memory.memoryTasks.claimNext(Date.now());
        if (!row) break;
        await this.dispatch(row);
      }
    } finally {
      this.running = false;
    }
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  private async dispatch(row: MemoryTaskRow): Promise<void> {
    const t0 = Date.now();
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.deps.memory.memoryTasks.heartbeat(row.id, row.attempts, Date.now())) {
          leaseLost = true;
          clearInterval(heartbeat);
        }
      } catch (error) {
        // 短暂的数据库错误不等同于失去所有权；最终 CAS 仍会阻止旧 Worker 收尾。
        console.warn(`[memory] task heartbeat failed: ${row.id}`, error);
      }
    }, MEMORY_TASK_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    const payload = bestEffort(`task ${row.id} payload_json parse`,
      () => JSON.parse(row.payload_json) as { sessionId?: string },
      {} as { sessionId?: string });
    this.deps.memory.emit?.({
      type:      'memory_task_started',
      taskId:    row.id,
      kind:      row.kind,
      sessionId: payload.sessionId as SessionId | undefined,
    });

    try {
      switch (row.kind) {
        case 'extraction':
          await this.handleExtraction(row);
          break;
        case 'maintenance':
        case 'embedding_refresh':
        case 'consolidation':
          // B-050:这三个 kind 暂未实现,空 break 后会落到下面的 markCompleted
          // 谎报完成(状态机不该允许空 handler 返回 completed)。
          // 当前不动代码,等 Sol 决定:实现它们,或改成标 unsupported 不重试。
          // 注:目前无入队点(dispatcher 只入队 extraction),不会实际触发,
          // 但 recovery requeue 历史遗留行仍会命中此分支。
          break;
      }
      if (leaseLost) return;
      const completed = this.deps.memory.memoryTasks.markCompleted(
        row.id,
        row.attempts,
        Date.now(),
      );
      if (!completed) return;
      this.deps.memory.emit?.({
        type:       'memory_task_completed',
        taskId:     row.id,
        kind:       row.kind,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      if (leaseLost) return;
      const msg = err instanceof Error ? err.message : String(err);
      const failed = this.deps.memory.memoryTasks.markFailed(
        row.id,
        row.attempts,
        msg,
        Date.now(),
        3,
      );
      if (!failed) return;
      this.deps.memory.emit?.({
        type:   'memory_task_failed',
        taskId: row.id,
        kind:   row.kind,
        error:  msg,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ── Extraction handler ─────────────────────────────────────────────────────

  private async handleExtraction(row: MemoryTaskRow): Promise<void> {
    const payload = JSON.parse(row.payload_json) as {
      sessionId?: string;
      mode?:      TurnMode;
    };
    if (!payload.sessionId || !payload.mode) throw new Error('Invalid task payload: missing sessionId or mode');
    const sid = payload.sessionId as SessionId;

    // Honour per-session override: consolidation can be skipped without
    // breaking extraction — lazy_updates simply stay buffered.
    const overrides = this.deps.getSessionOverrides(sid);
    const skipConsolidation = !overrides.consolidation;

    await this.deps.queue.enqueue(sid, async () => {
      const queueDepth = this.deps.memory.memoryTasks
        .countByStatus('pending');
      this.deps.memory.emit?.({
        type:       'memory_extraction_started',
        sessionId:  sid,
        queueDepth,
      });

      const t0 = Date.now();
      try {
        const result = await runExtractionPipeline(
          {
            memory:     this.deps.memory,
            embed:      this.deps.embed,
            settings:   this.deps.settings,
            nodesIndex: this.deps.getNodesIndex(),
            itemsIndex: this.deps.getItemsIndex(),
            indexSpaceId: this.deps.getIndexSpaceId(),
          },
          {
            sessionId: sid,
            mode: payload.mode!,
            runId: row.id,
            skipConsolidation,
          },
        );
        this.deps.memory.emit?.({
          type:       'memory_extraction_completed',
          sessionId:  sid,
          nodes:      result.extractedNodes,
          edges:      result.extractedEdges,
          items:      result.extractedItems,
          lazyQueued: result.lazyUpdatesQueued,
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        this.deps.memory.emit?.({
          type:      'memory_extraction_failed',
          sessionId: sid,
          error:     err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
  }

  // ── Consolidation handler (rare standalone case) ──────────────────────────

}
