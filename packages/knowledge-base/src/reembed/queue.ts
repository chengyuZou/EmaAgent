// 知识库重建索引(re-embed)的后台任务队列: 一个 KB 同时只跑一场, 状态推进全部经持久表 CAS。
// 与 IngestQueue 同型, 位于 KB 包 reembed 层, 由 KbManager 按 KB 装配。

import { randomUUID } from 'node:crypto';
import type { KbReembedTask, KbReembedTasksRepo } from '@ema-agent/storage';
import type { DocumentEventEmitter } from '../events/emitter.js';

const LEASE_DURATION_MS = 60_000;
const LEASE_HEARTBEAT_MS = 20_000;

export interface ReembedSweepInput {
  /** 缺省 = 全库 stale 扫描; 有值 = 单文档重建。 */
  assetId?: string;
  ebdProviderId: string;
  ebdModel: string;
  taskId: string;
  attempt: number;
  signal: AbortSignal;
  onProgress?: (done: number, total: number, failed: number) => void;
}

export interface ReembedSweepFailure {
  assetId: string;
  errorCode?: string;
  error: string;
}

export interface ReembedSweepOutcome {
  total: number;
  done: number;
  failed: ReembedSweepFailure[];
}

export interface ReembedQueueDeps {
  tasks: KbReembedTasksRepo;
  sweep: (input: ReembedSweepInput) => Promise<ReembedSweepOutcome>;
  /** 队列自身要发的事件(用户取消); 进度/终态业务事件由 sweep 发。 */
  events?: DocumentEventEmitter;
}

/**
 * KB 重建任务 Facade。Queue 独占任务状态转换；sweep 只返回业务结果。
 * claim/terminal 使用 lease + version CAS，迟到 Promise 无法覆盖取消或重试后的新状态。
 */
export class ReembedQueue {
  private running = false;
  private runningTaskId: string | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly deps: ReembedQueueDeps) {}

  /**
   * 幂等入队: 已有 pending/running 任务时直接复用, 不重复烧 embedding 配额。
   * 想换范围(全库/单文档)或换模型, 请先 cancel 再入队。
   */
  enqueue(input: {
    assetId?: string;
    ebdProviderId: string;
    ebdModel: string;
  }): KbReembedTask {
    const active = this.deps.tasks.findActive();
    if (active) return active;

    const taskId = randomUUID();
    this.deps.tasks.insert({ id: taskId, ...input });
    const task = this.deps.tasks.get(taskId);
    if (!task) throw new Error(`[kb/reembed-queue] task ${taskId} was not persisted`);
    this.tick();
    return task;
  }

  /** failed/partial_failed/cancelled 使用同一任务身份重新排队, 不创建重复主键。 */
  retry(taskId: string): boolean {
    const current = this.deps.tasks.get(taskId);
    if (!current) return false;
    const updated = this.deps.tasks.retry(taskId, current.version);
    if (!updated) return false;
    this.tick();
    return true;
  }

  /**
   * 用户主动取消: 持久态先置 cancelled(并 version+1), 再 abort 运行中的 Worker。
   * Worker 心跳续租随即失败, 其迟到终态 CAS 也无法覆盖 cancelled。
   */
  cancel(taskId: string): boolean {
    const current = this.deps.tasks.get(taskId);
    if (!current) return false;
    if (!this.deps.tasks.cancel(taskId)) return false;
    if (this.runningTaskId === taskId) {
      this.controller?.abort(new Error('kb/reembed_cancelled'));
    }
    this.deps.events?.emit({
      assetId: current.assetId ?? '',
      taskId,
      attempt: current.attempt,
      kind: 'cancelled',
      operation: 'reembed',
    });
    return true;
  }

  /** 应用重启后旧 Worker 已不存在，重新排队并恢复 drain。 */
  resume(): void {
    this.deps.tasks.recoverInterrupted(Date.now());
    this.tick();
  }

  private tick(): void {
    // 一个 KB 同时只跑一场重建: embedding API 配额和本地 CPU 都不适合并行扫全库。
    if (this.running) return;
    const now = Date.now();
    const task = this.deps.tasks.claimNextPending({
      leaseToken: randomUUID(),
      leaseExpiresAt: now + LEASE_DURATION_MS,
      now,
    });
    if (!task) return;
    this.running = true;
    this.runningTaskId = task.id;
    void this.run(task).finally(() => {
      this.running = false;
      this.runningTaskId = undefined;
      this.controller = undefined;
      this.tick();
    });
  }

  private async run(task: KbReembedTask): Promise<void> {
    const leaseToken = task.leaseToken;
    if (!leaseToken) throw new Error(`[kb/reembed-queue] claimed task ${task.id} has no lease token`);

    const controller = new AbortController();
    this.controller = controller;
    const heartbeat = setInterval(() => {
      const ok = this.deps.tasks.extendLease(
        task.id,
        leaseToken,
        task.attempt,
        Date.now() + LEASE_DURATION_MS,
        Date.now(),
      );
      if (!ok) controller.abort(new Error('KB reembed lease lost'));
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const outcome = await this.deps.sweep({
        ...(task.assetId !== undefined ? { assetId: task.assetId } : {}),
        ebdProviderId: task.ebdProviderId,
        ebdModel: task.ebdModel,
        taskId: task.id,
        attempt: task.attempt,
        signal: controller.signal,
        onProgress: (done, total) => {
          this.deps.tasks.updateProgress(
            task.id,
            task.attempt,
            'embed',
            total === 0 ? 1 : done / total,
          );
        },
      });

      // 用户取消或租约丢失时，持久状态已经由取消方/下一次 claim 接管。
      // 当前 Worker 不再发布任何终态，避免迟到结果覆盖新所有者。
      if (controller.signal.aborted) return;

      if (outcome.failed.length > 0) {
        const updated = this.deps.tasks.partialFail({
          id: task.id,
          leaseToken,
          version: task.version,
          stage: 'embed',
          errorCode: 'kb/partial_failed',
          error: `${outcome.failed.length}/${outcome.total} 个文档重建失败`,
          totalItems: outcome.total,
          completedItems: outcome.done,
          failedItems: outcome.failed.length,
          failures: outcome.failed.map(failure => ({
            stage: 'embed',
            shardKey: `reembed:asset:${failure.assetId}`,
            itemIds: [failure.assetId],
            retryable: true,
            ...(failure.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
            error: failure.error,
          })),
        });
        // CAS 失败说明任务已被取消/重试，迟到终态不得覆盖。
        if (!updated) return;
        this.deps.events?.emit({
          assetId: task.assetId ?? '',
          taskId: task.id,
          attempt: task.attempt,
          kind: 'partial_failed',
          progress: 1,
          error: `${outcome.failed.length}/${outcome.total} 个文档重建失败`,
          totalItems: outcome.total,
          completedItems: outcome.done,
          failedItems: outcome.failed.length,
          operation: 'reembed',
        });
        return;
      }

      const completed = this.deps.tasks.complete(task.id, leaseToken, task.version);
      if (!completed) return;
      this.deps.events?.emit({
        assetId: task.assetId ?? '',
        taskId: task.id,
        attempt: task.attempt,
        kind: 'complete',
        progress: 1,
        totalItems: outcome.total,
        completedItems: outcome.done,
        failedItems: 0,
        operation: 'reembed',
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = errorMessage(error);
      if (!this.failIfOwned(task, leaseToken, 'kb/reembed_failed', message)) return;
      this.deps.events?.emit({
        assetId: task.assetId ?? '',
        taskId: task.id,
        attempt: task.attempt,
        kind: 'error',
        error: message,
        operation: 'reembed',
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private failIfOwned(
    task: KbReembedTask,
    leaseToken: string,
    errorCode: string,
    error: string,
  ): boolean {
    // 如果 partial/complete/cancel 已成功，状态不再是 running，CAS 返回 undefined；
    // 这表示 catch 捕获的是终态后的观察性错误，不能覆盖合法终态。
    return this.deps.tasks.fail({
      id: task.id,
      leaseToken,
      version: task.version,
      errorCode,
      error,
    }) !== undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
