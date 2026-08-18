// 在单个应用进程内按并发上限执行向量重建任务，并持久化可查询的任务终态。
// 一行任务 = 一个资产；整库重建由 KbManager fan-out 成多行，本队列只认单行。

import { randomUUID } from 'node:crypto';
import type { KbReembedTask, KbReembedTasksRepo } from '@ema-agent/storage';
import { KnowledgeInvalidRequestError } from '../errors.js';
import type { KnowledgeEvent } from '../events.js';
import type { KnowledgeEmbeddingSelection } from '../types.js';

// 每行是一个资产的按批 embed 流；3 路并发对齐旧 sweep 内资产池的吞吐。
const DEFAULT_CONCURRENCY = 3;

export interface ReembedQueueDeps {
  readonly kbId: string;
  readonly tasks: KbReembedTasksRepo;
  readonly reembed: (input: {
    readonly assetId: string;
    readonly signal: AbortSignal;
    readonly onProgress: (completed: number, total: number) => void;
  }) => Promise<void>;
  readonly emit: (event: KnowledgeEvent) => void;
  readonly concurrency?: number;
}

export class ReembedQueue {
  private running = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly concurrency: number;

  constructor(private readonly deps: ReembedQueueDeps) {
    this.concurrency = Math.max(1, Math.trunc(deps.concurrency ?? DEFAULT_CONCURRENCY));
  }

  enqueue(input: {
    readonly assetId: string;
    readonly embedding: KnowledgeEmbeddingSelection;
  }): KbReembedTask {
    // 同一资产只允许一个在途任务（连点或 fan-out 重入都只会产生重复付费）。
    if (this.deps.tasks.findActiveByAssetId(input.assetId)) {
      throw new KnowledgeInvalidRequestError(`该文档已有重嵌任务进行中: ${input.assetId}`);
    }
    const task = this.deps.tasks.insert({
      id: randomUUID(),
      assetId: input.assetId,
      embeddingProviderId: input.embedding.providerId,
      embeddingModel: input.embedding.model,
    });
    this.drain();
    return task;
  }

  // retry 的模型由业务包传入当前绑定，不从任务行读旧模型（绑定可能已切换）。
  retry(taskId: string, embedding: KnowledgeEmbeddingSelection): KbReembedTask | undefined {
    const previous = this.deps.tasks.get(taskId);
    if (!previous || previous.status !== 'failed') return undefined;
    return this.enqueue({ assetId: previous.assetId, embedding });
  }

  cancel(taskId: string): boolean {
    const task = this.deps.tasks.get(taskId);
    if (!task || !this.deps.tasks.cancel(taskId)) return false;
    this.controllers.get(taskId)?.abort(new Error('Knowledge 重嵌入已取消'));
    this.deps.emit({
      type: 'kb_reembed_cancelled',
      kbId: this.deps.kbId,
      taskId,
      assetId: task.assetId,
    });
    return true;
  }

  markInterruptedTasks(): number {
    return this.deps.tasks.markRunningInterrupted();
  }

  private drain(): void {
    while (this.running < this.concurrency) {
      const task = this.deps.tasks.startNext();
      if (!task) return;
      this.running++;
      const active = this.run(task);
      this.activeRuns.add(active);
      void active
        .finally(() => {
          this.activeRuns.delete(active);
          this.running--;
          this.drain();
        })
        .catch(() => undefined);
    }
  }

  /** 关闭 KB：中止在途任务并等待落定，调用方随后才能安全关闭数据库连接。 */
  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) {
      controller.abort(new Error('Knowledge 知识库已关闭'));
    }
    await Promise.allSettled(this.activeRuns);
  }

  private async run(task: KbReembedTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    try {
      await this.deps.reembed({
        assetId: task.assetId,
        signal: controller.signal,
        onProgress: (completed, total) => {
          const progress = total === 0 ? 1 : completed / total;
          this.deps.tasks.updateProgress(task.id, progress);
          this.deps.emit({
            type: 'kb_reembed_progress',
            kbId: this.deps.kbId,
            taskId: task.id,
            assetId: task.assetId,
            progress,
            completed,
            total,
          });
        },
      });
      if (!this.deps.tasks.complete(task.id)) return;
      this.deps.emit({
        type: 'kb_reembed_completed',
        kbId: this.deps.kbId,
        taskId: task.id,
        assetId: task.assetId,
      });
    } catch (error) {
      if (this.deps.tasks.get(task.id)?.status === 'cancelled') return;
      const message = errorMessage(error);
      if (!this.deps.tasks.fail(task.id, message)) return;
      this.deps.emit({
        type: 'kb_reembed_failed',
        kbId: this.deps.kbId,
        taskId: task.id,
        assetId: task.assetId,
        error: message,
      });
    } finally {
      this.controllers.delete(task.id);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
