// 在单个应用进程内顺序重建文档向量，并持久化可查询的任务终态。

import { randomUUID } from 'node:crypto';
import type { KbReembedTask, KbReembedTasksRepo } from '@ema-agent/storage';
import type { KnowledgeEvent } from '../events.js';
import type { KnowledgeModelRef } from '../settings.js';

export interface ReembedQueueDeps {
  readonly kbId: string;
  readonly tasks: KbReembedTasksRepo;
  readonly reembed: (input: {
    readonly assetId?: string;
    readonly embedding: KnowledgeModelRef;
    readonly signal: AbortSignal;
    readonly onProgress: (completed: number, total: number) => void;
  }) => Promise<{ total: number; completed: number }>;
  readonly emit: (event: KnowledgeEvent) => void;
}

export class ReembedQueue {
  private running = false;
  private runningTaskId: string | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly deps: ReembedQueueDeps) {}

  enqueue(input: {
    readonly assetId?: string;
    readonly embedding: KnowledgeModelRef;
  }): KbReembedTask {
    const task = this.deps.tasks.insert({
      id: randomUUID(),
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
      ebdProviderId: input.embedding.providerConfigId,
      ebdModel: input.embedding.model,
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
        providerConfigId: previous.ebdProviderId,
        model: previous.ebdModel,
      },
    });
  }

  cancel(taskId: string): boolean {
    if (!this.deps.tasks.cancel(taskId)) return false;
    if (this.runningTaskId === taskId) {
      this.controller?.abort(new Error('Knowledge 重嵌入已取消'));
    }
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
    if (this.running) return;
    const task = this.deps.tasks.startNext();
    if (!task) return;
    this.running = true;
    this.runningTaskId = task.id;
    void this.run(task).finally(() => {
      this.running = false;
      this.runningTaskId = undefined;
      this.controller = undefined;
      this.drain();
    });
  }

  private async run(task: KbReembedTask): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await this.deps.reembed({
        ...(task.assetId === undefined ? {} : { assetId: task.assetId }),
        embedding: {
          providerConfigId: task.ebdProviderId,
          model: task.ebdModel,
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
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
