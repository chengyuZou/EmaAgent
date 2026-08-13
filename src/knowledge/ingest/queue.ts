// 在单个应用进程内按并发上限执行文档导入，并把每次任务状态持久化。

import { randomUUID } from 'node:crypto';
import type { KbIngestTask, KbIngestTasksRepo } from '@ema-agent/storage';
import type { KnowledgeEvent } from '../events.js';
import type { IngestOptions, IngestResult } from '../types.js';
import type { IngestStage } from './pipeline.js';
import { stagedRelativePathFor, type StagedFile } from './staging.js';
import * as path from 'node:path';

const DEFAULT_CONCURRENCY = 3;

export interface IngestQueueDeps {
  readonly kbId: string;
  readonly tasks: KbIngestTasksRepo;
  readonly ingest: (
    filePath: string,
    options: IngestOptions,
    onProgress: (assetId: string, stage: IngestStage, progress: number) => void,
  ) => Promise<IngestResult>;
  readonly stageFile: (sourcePath: string, assetId: string) => Promise<StagedFile>;
  readonly emit: (event: KnowledgeEvent) => void;
  readonly concurrency?: number;
}

export class IngestQueue {
  private running = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly concurrency: number;

  constructor(private readonly deps: IngestQueueDeps) {
    this.concurrency = Math.max(1, Math.trunc(deps.concurrency ?? DEFAULT_CONCURRENCY));
  }

  async enqueue(input: {
    readonly assetId: string;
    readonly filePath: string;
    readonly fileName: string;
    readonly mimeType?: string;
  }): Promise<KbIngestTask> {
    const staged = await this.deps.stageFile(input.filePath, input.assetId);
    const task = this.deps.tasks.insert({
      id: randomUUID(),
      assetId: input.assetId,
      filePath: staged.absolutePath,
      fileName: input.fileName,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    });
    this.drain();
    return task;
  }

  retry(taskId: string): KbIngestTask | undefined {
    const previous = this.deps.tasks.get(taskId);
    if (!previous || previous.status !== 'failed') return undefined;
    // 同一资产已有在途任务时不重复入队（连点重试只会产生噪音失败）。
    const latest = this.deps.tasks.findLatestByAssetId(previous.assetId);
    if (latest && (latest.status === 'pending' || latest.status === 'running')) return undefined;
    const task = this.deps.tasks.insert({
      id: randomUUID(),
      assetId: previous.assetId,
      filePath: previous.filePath,
      fileName: previous.fileName,
      ...(previous.mimeType === undefined ? {} : { mimeType: previous.mimeType }),
    });
    this.drain();
    return task;
  }

  retryByTaskOrAssetId(id: string): KbIngestTask | undefined {
    const task = this.deps.tasks.get(id) ?? this.deps.tasks.findLatestByAssetId(id);
    return task ? this.retry(task.id) : undefined;
  }

  cancel(taskId: string): boolean {
    if (!this.deps.tasks.cancel(taskId)) return false;
    this.controllers.get(taskId)?.abort(new Error('Knowledge 导入已取消'));
    return true;
  }

  /** 删除资产前先停：取消该资产全部在途任务并等它们落定，避免删除后任务继续写库。 */
  async cancelByAssetId(assetId: string): Promise<void> {
    const inFlight = this.deps.tasks.list()
      .filter((task) => task.assetId === assetId
        && (task.status === 'pending' || task.status === 'running'));
    for (const task of inFlight) this.cancel(task.id);
    await Promise.allSettled(
      inFlight.map((task) => this.activeRuns.get(task.id)).filter(Boolean),
    );
  }

  /** 重启后旧进程不可能继续工作，只把幽灵 running 任务如实标记失败。 */
  markInterruptedTasks(): number {
    return this.deps.tasks.markRunningInterrupted();
  }

  private drain(): void {
    while (this.running < this.concurrency) {
      const task = this.deps.tasks.startNext();
      if (!task) return;
      this.running++;
      const active = this.run(task);
      this.activeRuns.set(task.id, active);
      void active
        .finally(() => {
          this.activeRuns.delete(task.id);
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
    await Promise.allSettled(this.activeRuns.values());
  }

  private async run(task: KbIngestTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    try {
      const result = await this.deps.ingest(
        task.filePath,
        {
          assetId: task.assetId,
          stagedRelativePath: stagedRelativePathFor(task.assetId, path.basename(task.filePath)),
          ...(task.mimeType === undefined ? {} : { mimeType: task.mimeType }),
          signal: controller.signal,
        },
        (assetId, stage, progress) => {
          this.deps.tasks.updateProgress(task.id, stage, progress);
          this.deps.emit({
            type: 'kb_ingest_progress',
            kbId: this.deps.kbId,
            taskId: task.id,
            assetId,
            stage,
            progress,
          });
        },
      );
      if (!this.deps.tasks.complete(task.id)) return;
      this.deps.emit({
        type: 'kb_ingest_completed',
        kbId: this.deps.kbId,
        taskId: task.id,
        // 重复内容会返回既有资产：事件必须报告真实落库的 assetId，不是任务自带的。
        assetId: result.asset.id,
      });
    } catch (error) {
      if (this.deps.tasks.get(task.id)?.status === 'cancelled') return;
      const message = errorMessage(error);
      if (!this.deps.tasks.fail(task.id, message)) return;
      this.deps.emit({
        type: 'kb_ingest_failed',
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
