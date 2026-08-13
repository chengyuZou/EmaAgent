// 在单个应用进程内按并发上限执行向量重建任务，并持久化可查询的任务终态。

import { randomUUID } from 'node:crypto';
import type { KbReembedTask, KbReembedTasksRepo } from '@ema-agent/storage';
import { KnowledgeInvalidRequestError } from '../errors.js';
import type { KnowledgeEvent } from '../events.js';
import type { KnowledgeModelRef } from '../settings.js';

// 任务内部已有资产级并发（probe 后 3 路），队列级默认 2 个任务，避免叠加打满 Provider 限流。
const DEFAULT_CONCURRENCY = 2;

export interface ReembedQueueDeps {
  readonly kbId: string;
  readonly tasks: KbReembedTasksRepo;
  readonly reembed: (input: {
    readonly assetId?: string;
    readonly embedding: KnowledgeModelRef;
    readonly signal: AbortSignal;
    readonly onProgress: (completed: number, total: number) => void;
  }) => Promise<{ total: number; completed: number; failedAssetIds: string[] }>;
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
    readonly assetId?: string;
    readonly embedding: KnowledgeModelRef;
  }): KbReembedTask {
    // 整库重建只允许一个在途：两个 sweep 会拉到同一份 stale 清单重复付费。
    if (input.assetId === undefined && this.deps.tasks.findActiveSweep()) {
      throw new KnowledgeInvalidRequestError('已有整库重建任务进行中');
    }
    const task = this.deps.tasks.insert({
      id: randomUUID(),
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
      embeddingProviderConfigId: input.embedding.providerConfigId,
      embeddingModel: input.embedding.model,
    });
    this.drain();
    return task;
  }

  retry(taskId: string): KbReembedTask | undefined {
    const previous = this.deps.tasks.get(taskId);
    if (!previous || previous.status !== 'failed') return undefined;
    return this.enqueue({
      ...(previous.assetId === undefined ? {} : { assetId: previous.assetId }),
      embedding: {
        providerConfigId: previous.embeddingProviderConfigId,
        model: previous.embeddingModel,
      },
    });
  }

  cancel(taskId: string): boolean {
    if (!this.deps.tasks.cancel(taskId)) return false;
    this.controllers.get(taskId)?.abort(new Error('Knowledge 重嵌入已取消'));
    this.deps.emit({
      type: 'kb_reembed_cancelled',
      kbId: this.deps.kbId,
      taskId,
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
      const result = await this.deps.reembed({
        ...(task.assetId === undefined ? {} : { assetId: task.assetId }),
        embedding: {
          providerConfigId: task.embeddingProviderConfigId,
          model: task.embeddingModel,
        },
        signal: controller.signal,
        onProgress: (completed, total) => {
          const progress = total === 0 ? 1 : completed / total;
          this.deps.tasks.updateProgress(task.id, progress);
          this.deps.emit({
            type: 'kb_reembed_progress',
            kbId: this.deps.kbId,
            taskId: task.id,
            ...(task.assetId === undefined ? {} : { assetId: task.assetId }),
            progress,
            completed,
            total,
          });
        },
      });
      // 部分失败 = 任务失败：失败清单写进任务行（可重试、重启后仍可查）；
      // 成功资产已冻结新空间，retry 只会补跑仍 stale 的。
      if (result.failedAssetIds.length > 0) {
        const message = `${result.failedAssetIds.length}/${result.total} 个文档重嵌失败: ${result.failedAssetIds.join(', ')}`;
        if (!this.deps.tasks.fail(task.id, message)) return;
        this.deps.emit({
          type: 'kb_reembed_failed',
          kbId: this.deps.kbId,
          taskId: task.id,
          ...(task.assetId === undefined ? {} : { assetId: task.assetId }),
          error: message,
        });
        return;
      }
      if (!this.deps.tasks.complete(task.id)) return;
      this.deps.emit({
        type: 'kb_reembed_completed',
        kbId: this.deps.kbId,
        taskId: task.id,
        ...(task.assetId === undefined ? {} : { assetId: task.assetId }),
        completed: result.completed,
        total: result.total,
      });
    } catch (error) {
      if (this.deps.tasks.get(task.id)?.status === 'cancelled') return;
      const message = errorMessage(error);
      if (!this.deps.tasks.fail(task.id, message)) return;
      this.deps.emit({
        type: 'kb_reembed_failed',
        kbId: this.deps.kbId,
        taskId: task.id,
        ...(task.assetId === undefined ? {} : { assetId: task.assetId }),
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
