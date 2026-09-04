// 协调命名知识库、文档任务与按库检索，对外隐藏数据库和队列实现。
// 业务操作全部携带显式 kbId;"激活"的唯一含义是 Agent 检索目标库。
// 多库并行:任意库都能跑任务;激活切换是纯注册表动作,不停任务不关库。

import type { CallRerank } from '@ema-agent/rerank';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Database,
  DocumentAssetRepo,
  DocumentChunkRepo,
  DocumentPreviewRepo,
  KbIngestTasksRepo,
  KbReembedTasksRepo,
  type ChunkPage,
  type KbIngestTask,
  type KbModelRef,
  type KbRecord,
  type KbReembedTask,
  type KbRegistryRepo,
} from '@ema-agent/storage';
import { KnowledgeClient } from './client.js';
import type { KnowledgeEvent } from './events.js';
import { KnowledgeEvents } from './events/emitter.js';
import { IngestQueue } from './ingest/queue.js';
import { stageIngestFile } from './ingest/staging.js';
import { ReembedQueue } from './reembed/queue.js';
import {
  DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS,
  type KnowledgeRetrievalSettings,
} from './settings.js';
import type { CallVision } from '@ema-agent/vision';
import type {
  CallEmbed,
} from './types.js';
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

/** 注册行 + 文档计数 + 在途任务数; L1 库卡的完整展示单元。 */
export interface KbSummary extends KbRecord {
  readonly documentCount: number;
  readonly readyCount: number;
  readonly staleCount: number;
  readonly activeTaskCount: number;
}

export interface KbManagerDeps {
  readonly registry: KbRegistryRepo;
  /** 按模型引用解析调用闭包;每个打开的库各持一份绑定本库配置的闭包。 */
  readonly resolveEmbedFor: (ref: KbModelRef) => CallEmbed | undefined;
  readonly resolveRerankFor: (ref: KbModelRef) => CallRerank | undefined;
  readonly resolveVision: () => CallVision | undefined;
  /** 由模型引用算出向量空间 id(模型行缺失时 undefined); stale 标记的探空入口,不发网络请求。 */
  readonly resolveEmbeddingSpaceId: (ref: KbModelRef) => string | undefined;
  readonly resolveRetrievalSettings?: () => KnowledgeRetrievalSettings;
  readonly ingestConcurrency?: number;
  readonly reembedConcurrency?: number;
}

export class KbManager {
  readonly events = new KnowledgeEvents();
  private readonly opened = new Map<string, OpenKnowledgeBase>();

  constructor(private readonly deps: KbManagerDeps) {}

  listKbs(): KbRecord[] { return this.deps.registry.list(); }

  /** L1 库卡的展示投影:注册行 + 文档计数 + 在途任务数(直读各库 kb.db,不开队列)。 */
  listKbSummaries(): KbSummary[] {
    return this.deps.registry.list().map((record) => ({
      ...record,
      ...readKbSummaryCounts(record.path),
    }));
  }

  getKb(id: string): KbRecord | undefined { return this.deps.registry.get(id); }
  getActiveKb(): KbRecord | undefined { return this.deps.registry.getActive(); }
  renameKb(id: string, name: string): void { this.deps.registry.rename(id, name); }

  /** 激活是纯注册表切换:不停任务、不关库——任何库的在途任务跨切换继续跑。 */
  setActiveKb(id: string): boolean { return this.deps.registry.setActive(id); }

  /** Embedding 是库的属性;变更后用新空间标本库 stale(切回原模型清回)。 */
  async setEmbed(kbId: string, ref: KbModelRef | null): Promise<KbRecord> {
    const record = this.deps.registry.get(kbId);
    if (!record) throw new KnowledgeNotConfiguredError(`知识库未找到: ${kbId}`);
    const before = record.embed;
    this.deps.registry.setEmbed(kbId, ref);
    const changed = before?.providerId !== ref?.providerId || before?.modelId !== ref?.modelId;
    if (changed && ref) {
      const spaceId = this.deps.resolveEmbeddingSpaceId(ref);
      if (spaceId) (await this.required(kbId)).client.invalidateEmbeddings(spaceId);
    }
    return this.deps.registry.get(kbId)!;
  }

  /** Rerank 只影响检索时重排,不触碰索引。 */
  async setRerank(kbId: string, ref: KbModelRef | null): Promise<KbRecord> {
    const record = this.deps.registry.get(kbId);
    if (!record) throw new KnowledgeNotConfiguredError(`知识库未找到: ${kbId}`);
    this.deps.registry.setRerank(kbId, ref);
    return this.deps.registry.get(kbId)!;
  }

  async unregisterKb(id: string): Promise<void> {
    const entry = this.opened.get(id);
    if (entry) {
      // 先停队列再关库：在途任务的终态写入不能打到已关闭的连接上。
      await entry.ingestQueue.shutdown();
      await entry.reembedQueue.shutdown();
      entry.db.close();
      this.opened.delete(id);
    }
    const record = this.deps.registry.get(id);
    this.deps.registry.delete(id);
    // 库目录是创建时自建的 <父目录>/<id>,整个是我们的:永久删除零误伤。
    if (record) await fs.rm(record.path, { recursive: true, force: true });
  }

  /** name 是显示名;库目录 = <parentPath>/<id>(纯随机 ID,零校验零碰撞)。 */
  async createKb(name: string, parentPath: string): Promise<KbRecord> {
    const id = randomUUID();
    const kbPath = path.join(parentPath, id);
    await fs.mkdir(path.join(kbPath, 'files'), { recursive: true });
    this.deps.registry.insert({ id, name, path: kbPath });
    await this.open(id);
    return this.deps.registry.get(id)!;
  }

  /** 默认库的父目录:<数据目录>/kb。 */
  async ensureDefault(defaultParentPath: string): Promise<void> {
    if (this.deps.registry.list().length > 0) return;
    const created = await this.createKb('默认知识库', defaultParentPath);
    this.deps.registry.setActive(created.id);
  }

  /** Agent 检索入口:永远指向当前激活库。 */
  async searchActive(request: KnowledgeSearchRequest): Promise<KbSearchResult> {
    const active = this.deps.registry.getActive();
    if (!active) throw new KnowledgeNotConfiguredError('请先创建并激活一个知识库');
    return this.search(active.id, request);
  }

  async search(kbId: string, request: KnowledgeSearchRequest): Promise<KbSearchResult> {
    const record = this.deps.registry.get(kbId);
    if (!record) throw new KnowledgeNotConfiguredError(`知识库未找到: ${kbId}`);
    // Embedding 硬门槛:未配置的库禁止检索,不降级为纯 BM25。
    this.requireEmbed(record);
    const entry = await this.required(kbId);
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

  async enqueueIngest(kbId: string, input: {
    readonly filePath: string;
    readonly fileName: string;
    readonly mimeType?: string;
  }): Promise<KbIngestTask> {
    const record = this.deps.registry.get(kbId);
    if (!record) throw new KnowledgeNotConfiguredError(`知识库未找到: ${kbId}`);
    this.requireEmbed(record);
    const entry = await this.required(kbId);
    // 文档身份 = 原始路径:同路径再导入沿用既有 assetId,覆盖受管副本并重建索引。
    const assetId = entry.client.getAssetBySourcePath(input.filePath)?.id ?? randomUUID();
    // 同一资产的在途摄入只允一份(连点会产生两个任务抢同一 staged 目录与资产行)。
    const latest = entry.ingestTasks.findLatestByAssetId(assetId);
    if (latest && (latest.status === 'pending' || latest.status === 'running')) {
      throw new KnowledgeInvalidRequestError(`该文档已有导入任务进行中: ${input.fileName}`);
    }
    return entry.ingestQueue.enqueue({
      assetId,
      filePath: input.filePath,
      fileName: input.fileName,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    });
  }

  async listIngestTasks(kbId: string): Promise<KbIngestTask[]> {
    return (await this.required(kbId)).ingestTasks.list();
  }

  async retryIngest(kbId: string, taskOrAssetId: string): Promise<KbIngestTask | undefined> {
    const record = this.deps.registry.get(kbId);
    if (!record) throw new KnowledgeNotConfiguredError(`知识库未找到: ${kbId}`);
    this.requireEmbed(record);
    return (await this.required(kbId)).ingestQueue.retryByTaskOrAssetId(taskOrAssetId);
  }

  async cancelIngest(kbId: string, taskId: string): Promise<boolean> {
    return (await this.required(kbId)).ingestQueue.cancel(taskId);
  }

  /** 删除终态任务行;在途任务先取消再删。 */
  async deleteIngestTask(kbId: string, taskId: string): Promise<boolean> {
    const entry = await this.required(kbId);
    const task = entry.ingestTasks.get(taskId);
    if (!task) return false;
    if (task.status === 'pending' || task.status === 'running') {
      throw new KnowledgeInvalidRequestError('任务仍在进行,请先取消');
    }
    return entry.ingestTasks.delete(taskId);
  }

  /** 每行任务绑定一个显式资产：传入几个资产就建几行，返回与输入一一对应的任务行。
   *  重嵌目标模型统一为该库当前配置，执行时由闭包解析，任务行不记模型快照。 */
  async enqueueReembed(kbId: string, input: {
    readonly assetIds: readonly string[];
  }): Promise<KbReembedTask[]> {
    const record = this.deps.registry.get(kbId);
    if (!record) throw new KnowledgeNotConfiguredError(`知识库未找到: ${kbId}`);
    this.requireEmbed(record);
    const entry = await this.required(kbId);
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
      await entry.client.probeEmbeddingSpace();
    }
    return input.assetIds.map((assetId) => entry.reembedQueue.enqueue({ assetId }));
  }

  /** 整库重建的显式清单来源：调用方先取 stale 清单，再整单传给 enqueueReembed。 */
  async listStaleAssetIds(kbId: string): Promise<string[]> {
    return (await this.required(kbId)).client.listStaleAssetIds();
  }

  async listReembedTasks(kbId: string): Promise<KbReembedTask[]> {
    return (await this.required(kbId)).reembedTasks.list();
  }

  /** retry 也用该库当前配置模型，不沿袭任务行里的旧模型（配置可能已更换）。 */
  async retryReembed(kbId: string, taskId: string): Promise<KbReembedTask | undefined> {
    const record = this.deps.registry.get(kbId);
    if (!record) throw new KnowledgeNotConfiguredError(`知识库未找到: ${kbId}`);
    this.requireEmbed(record);
    return (await this.required(kbId)).reembedQueue.retry(taskId);
  }

  async cancelReembed(kbId: string, taskId: string): Promise<boolean> {
    return (await this.required(kbId)).reembedQueue.cancel(taskId);
  }

  /** 删除终态任务行;在途任务先取消再删。 */
  async deleteReembedTask(kbId: string, taskId: string): Promise<boolean> {
    const entry = await this.required(kbId);
    const task = entry.reembedTasks.get(taskId);
    if (!task) return false;
    if (task.status === 'pending' || task.status === 'running') {
      throw new KnowledgeInvalidRequestError('任务仍在进行,请先取消');
    }
    return entry.reembedTasks.delete(taskId);
  }

  /** 该库未配置或配置不可用时抛未配置错误;入队/检索/重试前的门槛。 */
  private requireEmbed(record: KbRecord): CallEmbed {
    if (!record.embed) {
      throw new KnowledgeNotConfiguredError('该知识库未配置 Embedding 模型');
    }
    const embed = this.deps.resolveEmbedFor(record.embed);
    if (!embed) {
      throw new KnowledgeNotConfiguredError('该知识库的 Embedding 模型不可用(模型被禁用或删除)');
    }
    return embed;
  }

  async listAssets(kbId: string, options: { cursor?: string; limit?: number; keyword?: string } = {}): Promise<AssetListPage> {
    return (await this.required(kbId)).client.listAssets(options);
  }

  async getAsset(kbId: string, id: string): Promise<DocumentAsset | undefined> {
    return (await this.required(kbId)).client.getAsset(id);
  }

  async getPreview(kbId: string, id: string): Promise<DocumentPreview | undefined> {
    return (await this.required(kbId)).client.getPreview(id);
  }

  async getChunks(kbId: string, id: string, options: { cursor?: number; limit?: number } = {}): Promise<ChunkPage> {
    return (await this.required(kbId)).client.getChunksPaged(id, options);
  }

  async deleteAsset(kbId: string, id: string): Promise<boolean> {
    const entry = await this.required(kbId);
    if (!entry.client.getAsset(id)) return false;
    // 先停该资产的在途摄入任务并等落定，再删行与文件,最后级联清掉它的任务行。
    await entry.ingestQueue.cancelByAssetId(id);
    await entry.client.deleteAsset(id);
    entry.ingestTasks.deleteByAssetId(id);
    entry.reembedTasks.deleteByAssetId(id);
    return true;
  }

  async invalidateEmbeddings(kbId: string, spaceId: string): Promise<number> {
    return (await this.required(kbId)).client.invalidateEmbeddings(spaceId);
  }

  private async required(kbId: string): Promise<OpenKnowledgeBase> {
    return this.open(kbId);
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
    );
    // 本库的模型闭包:读该库注册行的当前配置(执行时现取),与别的库互不相干。
    const ownRecord = () => this.deps.registry.get(record.id);
    const client = new KnowledgeClient({
      store,
      resolveEmbed: () => {
        const ref = ownRecord()?.embed;
        return ref ? this.deps.resolveEmbedFor(ref) : undefined;
      },
      resolveRerank: () => {
        const ref = ownRecord()?.rerank;
        return ref ? this.deps.resolveRerankFor(ref) : undefined;
      },
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
        await client.reembedAsset(input.assetId, input.signal, input.onProgress);
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

/** 直读某库 kb.db 的文档计数与在途任务数;库文件缺失或损坏时按零展示,不拖垮列表。 */
function readKbSummaryCounts(kbPath: string): {
  documentCount: number;
  readyCount: number;
  staleCount: number;
  activeTaskCount: number;
} {
  try {
    const db = new Database({ path: path.join(kbPath, 'kb.db'), kind: 'kb' });
    const counts = new DocumentAssetRepo(db.sqlite).countByIndexState();
    const activeTaskCount = new KbIngestTasksRepo(db.sqlite).countActive()
      + new KbReembedTasksRepo(db.sqlite).countActive();
    db.close();
    return {
      documentCount: counts.total,
      readyCount: counts.ready,
      staleCount: counts.stale,
      activeTaskCount,
    };
  } catch {
    return { documentCount: 0, readyCount: 0, staleCount: 0, activeTaskCount: 0 };
  }
}
