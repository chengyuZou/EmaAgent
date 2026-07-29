import { randomUUID } from 'node:crypto';
import type {
  KbIngestFailureShard,
  KbIngestTask,
  KbIngestTasksRepo,
} from '@ema-agent/storage';
import type { IngestOptions, IngestResult } from '../types.js';
import { stagedRelativePathFor, type StagedFile } from './staging.js';
import * as path from 'node:path';

const DEFAULT_CONCURRENCY = 3;
const LEASE_DURATION_MS = 60_000;
const LEASE_HEARTBEAT_MS = 20_000;

export interface IngestQueueDeps {
  tasks: KbIngestTasksRepo;
  ingest: (filePath: string, opts: IngestOptions) => Promise<IngestResult>;
  /** 每次领取时读取最新模型设置，排队期间切换 Provider 不会使用旧密钥。 */
  resolveOptions: () => IngestRuntimeOptions;
  /** 上传即落盘：enqueue 时把原文复制进 KB 目录，之后任务只读副本。 */
  stageFile?: (sourcePath: string, assetId: string) => Promise<StagedFile>;
  concurrency?: number;
}

export type IngestRuntimeOptions = Pick<
  IngestOptions,
  'visionProviderId' | 'visionModel' | 'ebdProviderId' | 'ebdModel'
>;

/**
 * KB 持久任务 Facade。Queue 独占任务状态转换；ingest 只返回业务结果与失败分片。
 * claim/terminal 使用 lease + version CAS，迟到 Promise 无法覆盖用户重试后的新状态。
 */
export class IngestQueue {
  private running = 0;
  private readonly concurrency: number;

  constructor(private readonly deps: IngestQueueDeps) {
    this.concurrency = Math.max(1, Math.trunc(deps.concurrency ?? DEFAULT_CONCURRENCY));
  }

  async enqueue(input: {
    assetId: string;
    filePath: string;
    fileName: string;
    mimeType?: string;
  }): Promise<KbIngestTask> {
    // 上传即落盘：staging 失败（源不可读、磁盘错误）直接抛出，不产生必失败的任务。
    const staged = this.deps.stageFile
      ? await this.deps.stageFile(input.filePath, input.assetId)
      : undefined;
    const taskId = randomUUID();
    this.deps.tasks.insert({
      id: taskId,
      ...input,
      filePath: staged?.absolutePath ?? input.filePath,
    });
    const task = this.deps.tasks.get(taskId);
    if (!task) throw new Error(`[kb/queue] task ${taskId} was not persisted`);
    this.tick();
    return task;
  }

  /** failed/partial_failed 使用同一任务身份增加 attempt，不创建重复主键。 */
  retry(taskId: string): boolean {
    const current = this.deps.tasks.get(taskId);
    if (!current || (current.status !== 'failed' && current.status !== 'partial_failed')) {
      return false;
    }
    const updated = this.deps.tasks.retry(taskId, current.version);
    if (!updated) return false;
    this.tick();
    return true;
  }

  /** 兼容旧路由：旧客户端仍可能把 assetId 当成任务 ID。 */
  retryByTaskOrAssetId(id: string): boolean {
    const task = this.deps.tasks.get(id) ?? this.deps.tasks.findByAssetId(id);
    return task ? this.retry(task.id) : false;
  }

  /** 应用重启后旧 Worker 已不存在，重新排队并恢复 drain。 */
  resume(): void {
    this.deps.tasks.recoverInterrupted(Date.now());
    this.tick();
  }

  private tick(): void {
    while (this.running < this.concurrency) {
      const now = Date.now();
      const task = this.deps.tasks.claimNextPending({
        leaseToken: randomUUID(),
        leaseExpiresAt: now + LEASE_DURATION_MS,
        now,
      });
      if (!task) break;
      this.running++;
      void this.run(task).finally(() => {
        this.running--;
        this.tick();
      });
    }
  }

  private async run(task: KbIngestTask): Promise<void> {
    const leaseToken = task.leaseToken;
    if (!leaseToken) throw new Error(`[kb/queue] claimed task ${task.id} has no lease token`);

    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      const ok = this.deps.tasks.extendLease(
        task.id,
        leaseToken,
        task.attempt,
        Date.now() + LEASE_DURATION_MS,
        Date.now(),
      );
      if (!ok) controller.abort(new Error('KB ingest lease lost'));
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const previousFailures = this.deps.tasks.listFailures(task.id);
      const retryChunkIds = retryableEmbeddingIds(previousFailures);
      const replaceExistingAsset = previousFailures.some(failure => failure.stage === 'parse');
      const result = await this.deps.ingest(task.filePath, {
        ...this.deps.resolveOptions(),
        assetId: task.assetId,
        taskId: task.id,
        attempt: task.attempt,
        mimeType: task.mimeType,
        // staging 开启时 task.filePath 是 KB 内副本，按同一约定重建相对引用。
        ...(this.deps.stageFile
          ? { stagedRelativePath: stagedRelativePathFor(task.assetId, path.basename(task.filePath)) }
          : {}),
        ...(retryChunkIds.length > 0 ? { retryChunkIds } : {}),
        ...(replaceExistingAsset ? { replaceExistingAsset: true } : {}),
        signal: controller.signal,
      });

      if (result.outcome === 'partial_failed') {
        const updated = this.deps.tasks.partialFail({
          id: task.id,
          leaseToken,
          version: task.version,
          stage: result.failureShards[0]?.stage ?? 'embed',
          errorCode: 'kb/partial_failed',
          error: `${result.counts.failed}/${result.counts.total} 个处理项失败`,
          totalItems: result.counts.total,
          completedItems: result.counts.completed,
          failedItems: result.counts.failed,
          failures: result.failureShards,
        });
        if (!updated) throw new Error(`[kb/queue] partial transition conflict for ${task.id}`);
        return;
      }

      if (!this.deps.tasks.complete(task.id, leaseToken, task.version)) {
        throw new Error(`[kb/queue] complete transition conflict for ${task.id}`);
      }
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        this.failIfOwned(task, leaseToken, 'kb/lease_lost', controller.signal.reason.message);
      } else {
        this.failIfOwned(task, leaseToken, 'kb/ingest_failed', errorMessage(error));
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private failIfOwned(
    task: KbIngestTask,
    leaseToken: string,
    errorCode: string,
    error: string,
  ): void {
    // 如果 partial/complete 已成功，状态不再是 running，CAS 返回 undefined；
    // 这表示 catch 捕获的是终态后的观察性错误，不能覆盖合法终态。
    this.deps.tasks.fail({
      id: task.id,
      leaseToken,
      version: task.version,
      errorCode,
      error,
    });
  }
}

function retryableEmbeddingIds(failures: KbIngestFailureShard[]): string[] {
  return [...new Set(
    failures
      .filter(failure => failure.stage === 'embed' && failure.retryable)
      .flatMap(failure => failure.itemIds),
  )];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
