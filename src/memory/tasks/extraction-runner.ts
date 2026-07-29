import type { ExecutionProfile } from '@ema-agent/turn';
// 运行已持久化的 Memory 提取任务，并拒绝尚未实现的任务类型进入成功终态。
import crypto from 'node:crypto';
import type { SessionId } from '@ema-agent/ids';
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
  MEMORY_TASK_WORKER_CONCURRENCY,
} from './task-lease-policy.js';
import { MemoryCommitCoordinator } from './commit-coordinator.js';
import { MemoryLeaseLostError } from '../errors.js';

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
  commitCoordinator: MemoryCommitCoordinator;
  /** 测试可替换模型流水线；生产默认使用 runExtractionPipeline。 */
  runPipeline?: typeof runExtractionPipeline;
}

export type RunnableMemoryTaskKind = Extract<MemoryTaskKind, 'extraction'>;

export class UnsupportedMemoryTaskKindError extends Error {
  readonly code = 'memory/task_kind_unsupported';

  constructor(readonly kind: Exclude<MemoryTaskKind, RunnableMemoryTaskKind>) {
    super(`Memory task kind is not implemented: ${kind}`);
    this.name = 'UnsupportedMemoryTaskKindError';
  }
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
  private currentTick: Promise<void> | null = null;
  private stopping = false;
  private lastCleanupAt = 0;

  constructor(private readonly deps: MemoryTaskRunnerDeps) {}

  /** Enqueue a fresh task. Returns the task id so callers can correlate. */
  enqueue(kind: RunnableMemoryTaskKind, sessionId: SessionId, payload: Record<string, unknown>): string {
    if (kind !== 'extraction') {
      throw new UnsupportedMemoryTaskKindError(
        kind as Exclude<MemoryTaskKind, RunnableMemoryTaskKind>,
      );
    }
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
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.currentTick) return this.currentTick;
    const run = this.runTick();
    this.currentTick = run;
    void run.then(
      () => { if (this.currentTick === run) this.currentTick = null; },
      () => { if (this.currentTick === run) this.currentTick = null; },
    );
    return run;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.currentTick;
    await this.deps.queue.drainAll();
    await this.deps.commitCoordinator.drain();
  }

  private async runTick(): Promise<void> {
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
    const workers = Array.from(
      { length: MEMORY_TASK_WORKER_CONCURRENCY },
      () => this.runWorker(),
    );
    const results = await Promise.allSettled(workers);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }

  private async runWorker(): Promise<void> {
    while (!this.stopping) {
      const row = this.deps.memory.memoryTasks.claimNext(Date.now());
      if (!row) return;
      await this.dispatch(row);
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
          await this.handleExtraction(row, () => !leaseLost);
          break;
        case 'maintenance':
        case 'embedding_refresh':
        case 'consolidation':
          // 旧库可能残留早期任务。明确失败且不重试，不能让空处理器落到 completed。
          throw new UnsupportedMemoryTaskKindError(row.kind);
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
      // 租约丢失属于正常移交：任务归新 Worker 所有，不标成功也不标失败。
      if (leaseLost || err instanceof MemoryLeaseLostError) return;
      const msg = err instanceof Error ? err.message : String(err);
      const maxAttempts = err instanceof UnsupportedMemoryTaskKindError ? 1 : 3;
      const failed = this.deps.memory.memoryTasks.markFailed(
        row.id,
        row.attempts,
        msg,
        Date.now(),
        maxAttempts,
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

  private async handleExtraction(
    row: MemoryTaskRow,
    isLeaseValid: () => boolean,
  ): Promise<void> {
    const payload = JSON.parse(row.payload_json) as {
      sessionId?: string;
      executionProfile?: ExecutionProfile;
    };
    if (!payload.sessionId || !payload.executionProfile) {
      throw new Error('Invalid task payload: missing sessionId or executionProfile');
    }
    const sid = payload.sessionId as SessionId;
    const executionProfile = payload.executionProfile;

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
        const result = await (this.deps.runPipeline ?? runExtractionPipeline)(
          {
            memory:     this.deps.memory,
            embed:      this.deps.embed,
            settings:   this.deps.settings,
            nodesIndex: this.deps.getNodesIndex(),
            itemsIndex: this.deps.getItemsIndex(),
            indexSpaceId: this.deps.getIndexSpaceId(),
            commitCoordinator: this.deps.commitCoordinator,
          },
          {
            sessionId: sid,
            executionProfile,
            runId: row.id,
            skipConsolidation,
            isLeaseValid,
          },
        );
        if (!isLeaseValid()) throw new MemoryLeaseLostError();
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
        // 租约丢失是正常移交而非提取失败，不发 failure 事件误导前端。
        if (!(err instanceof MemoryLeaseLostError)) {
          this.deps.memory.emit?.({
            type:      'memory_extraction_failed',
            sessionId: sid,
            error:     err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
    });
  }

  // ── Consolidation handler (rare standalone case) ──────────────────────────

}
