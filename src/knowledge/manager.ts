// 协调命名知识库、文档任务与当前活跃库检索，对外隐藏数据库和队列实现。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EmbeddingModel } from '@ema-agent/embed';
import {
  Database,
  DocumentAssetRepo,
  DocumentChunkRepo,
  DocumentPreviewRepo,
  KbIngestTasksRepo,
  KbReembedTasksRepo,
  type AssetUsage,
  type ChunkPage,
  type KbActivationsRepo,
  type KbIngestTask,
  type KbRecord,
  type KbReembedTask,
  type KbRegistryRepo,
} from '@ema-agent/storage';
import {
  KnowledgeClient,
  type KnowledgeEmbeddingSelection,
  type KnowledgeRerankSelection,
  type KnowledgeVisionSelection,
} from './client.js';
import type { KnowledgeEvent } from './events.js';
import { KnowledgeEvents } from './events/emitter.js';
import { IngestQueue } from './ingest/queue.js';
import { stageIngestFile } from './ingest/staging.js';
import { ReembedQueue } from './reembed/queue.js';
import type { KnowledgeModelRef } from './settings.js';
import {
  DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS,
  type KnowledgeRetrievalSettings,
} from './settings.js';
import { KnowledgeStore } from './store/store.js';
import type {
  AssetListPage,
  DocumentAsset,
  DocumentPreview,
  KbSearchResult,
  KnowledgeSearchRequest,
} from './types.js';
import { KnowledgeInvalidRequestError, KnowledgeNotConfiguredError } from './errors.js';

interface OpenKnowledgeBase {
  readonly db: Database;
  readonly client: KnowledgeClient;
  readonly ingestTasks: KbIngestTasksRepo;
  readonly ingestQueue: IngestQueue;
  readonly reembedTasks: KbReembedTasksRepo;
  readonly reembedQueue: ReembedQueue;
}

export interface KbManagerDeps {
  readonly registry: KbRegistryRepo;
  readonly activations: KbActivationsRepo;
  readonly resolveEmbedding: () => KnowledgeEmbeddingSelection | undefined;
  readonly resolveEmbeddingByRef: (ref: KnowledgeModelRef) => EmbeddingModel | undefined;
  readonly resolveReranker: () => KnowledgeRerankSelection | undefined;
  readonly resolveVision: () => KnowledgeVisionSelection | undefined;
  readonly resolveRetrievalSettings?: () => KnowledgeRetrievalSettings;
  readonly ingestConcurrency?: number;
  readonly reembedConcurrency?: number;
}

export class KbManager {
  readonly events = new KnowledgeEvents();
  private readonly opened = new Map<string, OpenKnowledgeBase>();

  constructor(private readonly deps: KbManagerDeps) {}

  listKbs(): KbRecord[] { return this.deps.registry.list(); }
  getKb(id: string): KbRecord | undefined { return this.deps.registry.get(id); }
  getActiveKb(): KbRecord | undefined { return this.deps.registry.getActive(); }
  renameKb(id: string, name: string): void { this.deps.registry.rename(id, name); }
  setActiveKb(id: string): boolean { return this.deps.registry.setActive(id); }

  async unregisterKb(id: string): Promise<void> {
    const entry = this.opened.get(id);
    if (entry) {
      // 先停队列再关库：在途任务的终态写入不能打到已关闭的连接上。
      await entry.ingestQueue.shutdown();
      await entry.reembedQueue.shutdown();
      entry.db.close();
      this.opened.delete(id);
    }
    this.deps.registry.delete(id);
  }

  async createKb(name: string, kbPath: string): Promise<KbRecord> {
    await fs.mkdir(path.join(kbPath, 'files'), { recursive: true });
    const id = randomUUID();
    this.deps.registry.insert({ id, name, path: kbPath });
    await this.open(id);
    return this.deps.registry.get(id)!;
  }

  async ensureDefault(defaultPath: string): Promise<void> {
    if (this.deps.registry.list().length > 0) return;
    const created = await this.createKb('默认知识库', defaultPath);
    this.deps.registry.setActive(created.id);
  }

  async search(request: KnowledgeSearchRequest): Promise<KbSearchResult> {
    const entry = await this.active();
    if (!entry) return { query: request.query, hits: [] };
    const settings = this.deps.resolveRetrievalSettings?.()
      ?? DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS;
    return entry.client.search(request.query, {
      ...(request.topK === undefined ? { topK: settings.defaultTopK } : { topK: request.topK }),
      ...(request.assetIds === undefined ? {} : { assetIds: request.assetIds }),
      alpha: settings.alpha,
      rerankBlendWeight: settings.rerankBlendWeight,
      maxResultChars: settings.resultMaxChars,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  async enqueueIngest(input: {
    readonly kbId?: string;
    readonly filePath: string;
    readonly fileName: string;
    readonly mimeType?: string;
  }): Promise<KbIngestTask> {
    const entry = await this.required(input.kbId);
    return entry.ingestQueue.enqueue({
      assetId: randomUUID(),
      filePath: input.filePath,
      fileName: input.fileName,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    });
  }

  async listIngestTasks(kbId?: string): Promise<KbIngestTask[]> {
    return (await this.required(kbId)).ingestTasks.list();
  }

  async retryIngest(taskOrAssetId: string, kbId?: string): Promise<KbIngestTask | undefined> {
    return (await this.required(kbId)).ingestQueue.retryByTaskOrAssetId(taskOrAssetId);
  }

  async cancelIngest(taskId: string, kbId?: string): Promise<boolean> {
    return (await this.required(kbId)).ingestQueue.cancel(taskId);
  }

  /** 每行任务绑定一个显式资产：传入几个资产就建几行，返回与输入一一对应的任务行。 */
  async enqueueReembed(input: {
    readonly kbId?: string;
    readonly assetIds: readonly string[];
    readonly embedding: KnowledgeModelRef;
  }): Promise<KbReembedTask[]> {
    const entry = await this.required(input.kbId);
    if (input.assetIds.length === 0) return [];
    for (const assetId of input.assetIds) {
      const asset = entry.client.getAsset(assetId);
      if (!asset) {
        throw new KnowledgeInvalidRequestError(`Knowledge 文档不存在: ${assetId}`);
      }
      // 只有 ready 资产有重建资格：indexing/failed 应走摄入重试，不是重嵌。
      if (asset.status !== 'ready') {
        throw new KnowledgeInvalidRequestError(
          `Knowledge 文档未就绪（${asset.status}），请重新导入: ${assetId}`,
        );
      }
    }
    // 批量建行前预检一次短文本 embed，key/模型/维度不通则一行都不建；
    // 单资产不预检：那一行自己的失败就是报告。
    if (input.assetIds.length > 1) {
      await entry.client.probeEmbeddingSpace(input.embedding);
    }
    return input.assetIds.map((assetId) => entry.reembedQueue.enqueue({
      assetId,
      embedding: input.embedding,
    }));
  }

  /** 整库重建的显式清单来源：调用方先取 stale 清单，再整单传给 enqueueReembed。 */
  async listStaleAssetIds(kbId?: string): Promise<string[]> {
    return (await this.required(kbId)).client.listStaleAssetIds();
  }

  async listReembedTasks(kbId?: string): Promise<KbReembedTask[]> {
    return (await this.required(kbId)).reembedTasks.list();
  }

  async retryReembed(taskId: string, kbId?: string): Promise<KbReembedTask | undefined> {
    return (await this.required(kbId)).reembedQueue.retry(taskId);
  }

  async cancelReembed(taskId: string, kbId?: string): Promise<boolean> {
    return (await this.required(kbId)).reembedQueue.cancel(taskId);
  }

  async listAssets(kbId?: string, options: { cursor?: string; limit?: number; keyword?: string } = {}): Promise<AssetListPage> {
    return (await this.required(kbId)).client.listAssets(options);
  }

  async listInactiveAssets(kbId?: string, days = 30): Promise<DocumentAsset[]> {
    return (await this.required(kbId)).client.listInactiveAssets(days);
  }

  async getAsset(id: string, kbId?: string): Promise<DocumentAsset | undefined> {
    return (await this.required(kbId)).client.getAsset(id);
  }

  async getPreview(id: string, kbId?: string): Promise<DocumentPreview | undefined> {
    return (await this.required(kbId)).client.getPreview(id);
  }

  async getChunks(id: string, kbId?: string, options: { cursor?: number; limit?: number } = {}): Promise<ChunkPage> {
    return (await this.required(kbId)).client.getChunksPaged(id, options);
  }

  async getAssetUsage(id: string, kbId?: string): Promise<AssetUsage> {
    return (await this.required(kbId)).client.getAssetUsage(id);
  }

  async deleteAsset(id: string, kbId?: string): Promise<boolean> {
    const entry = await this.required(kbId);
    if (!entry.client.getAsset(id)) return false;
    // 先停该资产的在途摄入任务并等落定，再删行与文件。
    await entry.ingestQueue.cancelByAssetId(id);
    await entry.client.deleteAsset(id);
    return true;
  }

  async invalidateEmbeddings(spaceId: string, kbId?: string): Promise<number> {
    return (await this.required(kbId)).client.invalidateEmbeddings(spaceId);
  }

  async invalidateAllEmbeddings(spaceId: string): Promise<{ kbCount: number; markedStale: number; failedKbIds: string[] }> {
    const records = this.deps.registry.list();
    let markedStale = 0;
    const failedKbIds: string[] = [];
    for (const record of records) {
      try {
        markedStale += (await this.open(record.id)).client.invalidateEmbeddings(spaceId);
      } catch {
        failedKbIds.push(record.id);
      }
    }
    return { kbCount: records.length, markedStale, failedKbIds };
  }

  private async required(kbId?: string): Promise<OpenKnowledgeBase> {
    const entry = kbId ? await this.open(kbId) : await this.active();
    if (!entry) throw new KnowledgeNotConfiguredError('请先创建并激活一个知识库');
    return entry;
  }

  private async active(): Promise<OpenKnowledgeBase | undefined> {
    const active = this.deps.registry.getActive();
    return active ? this.open(active.id) : undefined;
  }

  private async open(kbId: string): Promise<OpenKnowledgeBase> {
    const cached = this.opened.get(kbId);
    if (cached) return cached;
    const record = this.deps.registry.get(kbId);
    if (!record) throw new KnowledgeNotConfiguredError(`知识库未找到: ${kbId}`);

    const db = new Database({ path: path.join(record.path, 'kb.db'), kind: 'kb' });
    db.migrate();
    const store = new KnowledgeStore(
      new DocumentAssetRepo(db.sqlite),
      new DocumentChunkRepo(db.sqlite),
      new DocumentPreviewRepo(db.sqlite),
      this.deps.activations,
      record.id,
    );
    const client = new KnowledgeClient({
      store,
      resolveEmbedding: this.deps.resolveEmbedding,
      resolveEmbeddingByRef: this.deps.resolveEmbeddingByRef,
      resolveReranker: this.deps.resolveReranker,
      resolveVision: this.deps.resolveVision,
      kbRoot: record.path,
    });
    const emit = (event: KnowledgeEvent): void => this.events.emit(event);
    const ingestTasks = new KbIngestTasksRepo(db.sqlite);
    const ingestQueue = new IngestQueue({
      kbId: record.id,
      tasks: ingestTasks,
      ingest: (filePath, options, onProgress) => client.ingest(filePath, options, onProgress),
      stageFile: (sourcePath, assetId) => stageIngestFile(record.path, assetId, sourcePath),
      emit,
      ...(this.deps.ingestConcurrency === undefined
        ? {}
        : { concurrency: this.deps.ingestConcurrency }),
    });
    const reembedTasks = new KbReembedTasksRepo(db.sqlite);
    const reembedQueue = new ReembedQueue({
      kbId: record.id,
      tasks: reembedTasks,
      reembed: async (input) => {
        await client.reembedAsset(
          input.assetId,
          input.embedding,
          input.signal,
          input.onProgress,
        );
      },
      emit,
      ...(this.deps.reembedConcurrency === undefined
        ? {}
        : { concurrency: this.deps.reembedConcurrency }),
    });
    ingestQueue.markInterruptedTasks();
    reembedQueue.markInterruptedTasks();
    const entry = { db, client, ingestTasks, ingestQueue, reembedTasks, reembedQueue };
    this.opened.set(record.id, entry);
    return entry;
  }
}
