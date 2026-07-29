// 装配 Knowledge Manager、操作级设置读取、模型绑定和应用事件投影。

import type { EmbedRuntime } from '@ema-agent/embed';
import {
  KbManager,
  knowledgeModelsSetting,
  knowledgeRetrievalSetting,
  type DocumentProgressEvent,
  type IngestOptions,
  type KbSearchResult,
  type KnowledgeEvent,
  type KnowledgeModelRef,
} from '@ema-agent/knowledge';
import type { RerankRuntime } from '@ema-agent/rerank';
import type { SettingsStore } from '@ema-agent/settings';
import {
  KbActivationsRepo,
  KbRegistryRepo,
  type Database,
  type ModelBindingsRepo,
  type ProviderEmbedModelsRepo,
} from '@ema-agent/storage';
import type { KbAssetScope } from '@ema-agent/turn';
import type { VisionRuntime } from '@ema-agent/vision';
import { asKbVisionAdapter } from './providers/vision.js';

export type KnowledgeEventSink = (event: KnowledgeEvent) => void;

export function createKnowledgeRuntime(
  profileDb: Database,
  dataDb: Database,
  settings: SettingsStore,
  modelBindings: ModelBindingsRepo,
  embed: EmbedRuntime,
  rerank: RerankRuntime,
  vision: VisionRuntime,
  emitEvent: KnowledgeEventSink,
  providerEmbedModels: ProviderEmbedModelsRepo,
) {
  const resolveIngestModels = (): Partial<IngestOptions> => {
    const models = settings.get(knowledgeModelsSetting);
    const visionBinding = modelBindings.get('vision');
    return {
      ebdProviderId: models.embed?.providerConfigId,
      ebdModel: models.embed?.model,
      visionProviderId: visionBinding?.providerConfigId,
      visionModel: visionBinding?.model,
    };
  };

  const kb = new KbManager({
    registry: new KbRegistryRepo(profileDb.sqlite),
    activations: new KbActivationsRepo(dataDb.sqlite),
    embedRuntime: embed,
    rerankRuntime: rerank,
    visionAdapter: asKbVisionAdapter(vision),
    resolveIngestOptions: resolveIngestModels,
    // 用户设置只在一次真实检索开始时读取，排队或执行中的操作继续使用已取得的值。
    resolveRetrievalSettings: () =>
      settings.get(knowledgeRetrievalSetting),
    concurrency: 3,
  });

  kb.events.on((event) => {
    const projected = projectKnowledgeEvent(event);
    if (projected) emitEvent(projected);
  });

  // embed 模型绑定变更时自动标记全部 KB stale 并引导重嵌，
  // 不再依赖前端记得调 /invalidate 或等下次搜索惰性发现。
  const unwatchEmbedModel = watchKnowledgeEmbedModel({
    settings,
    providerEmbedModels,
    embed,
    kb,
    emitEvent,
  });

  const kbSearch = (
    query: string,
    topK?: number,
    kbIds?: string[],
    assetScopes?: KbAssetScope[],
    sessionId?: string,
    turnId?: string,
  ): Promise<KbSearchResult> => {
    const models = settings.get(knowledgeModelsSetting);
    const retrieval = settings.get(knowledgeRetrievalSetting);
    return kb.search(kbIds ?? [], query, {
      assetScopes,
      topK,
      sessionId,
      turnId,
      // 模型工具路径按用户预算裁剪正文；Knowledge HTTP 面板不经此入口。
      maxResultChars: retrieval.resultMaxChars,
      ebdProviderId: models.embed?.providerConfigId,
      ebdModel: models.embed?.model,
      rerankProviderId: models.rerank?.providerConfigId,
      rerankModel: models.rerank?.model,
    });
  };

  return { kb, kbSearch, unwatchEmbedModel };
}

/**
 * 订阅 `kb.models` 设置变更：embed 模型引用变化后自动 invalidate 全部 KB
 * 并发出 `kb_embeddings_staled` 引导事件。返回取消订阅函数。
 *
 * 变更事件在 SQLite 提交与快照替换之后发布，这里读到的一定是已持久化的新值；
 * 连续多次变更按 tail 链串行执行，前一场 invalidate 不会被后一场插队。
 */
export function watchKnowledgeEmbedModel(deps: {
  settings: SettingsStore;
  providerEmbedModels: ProviderEmbedModelsRepo;
  embed: EmbedRuntime;
  kb: Pick<KbManager, 'invalidateAllEmbeddings'>;
  emitEvent: KnowledgeEventSink;
}): () => void {
  let previousEmbed = deps.settings.get(knowledgeModelsSetting).embed;
  let tail: Promise<void> = Promise.resolve();

  const runInvalidation = (next: KnowledgeModelRef): void => {
    tail = tail.then(async () => {
      const dim = deps.providerEmbedModels.dimFor(next.providerConfigId, next.model);
      if (!dim) {
        console.warn(
          `[knowledge] embed model ${next.providerConfigId}/${next.model} 维度未知，跳过 stale 标记`,
        );
        return;
      }
      const space = deps.embed.embeddingSpace(next.providerConfigId, next.model, dim);
      const result = await deps.kb.invalidateAllEmbeddings(space.id);
      deps.emitEvent({
        type: 'kb_embeddings_staled',
        markedStale: result.markedStale,
        kbCount: result.kbCount,
        failedKbIds: result.failedKbIds,
        providerConfigId: next.providerConfigId,
        model: next.model,
      });
    }).catch((err) => {
      // 失败不阻断设置链路；相关 KB 下次打开或搜索时仍会惰性补标。
      console.warn('[knowledge] embed 模型变更后的 stale 标记失败:', err);
    });
  };

  return deps.settings.subscribe((event) => {
    if (!event.changedKeys.includes(knowledgeModelsSetting.key)) return;
    const next = deps.settings.get(knowledgeModelsSetting).embed;
    if (sameModelRef(previousEmbed, next)) return;
    previousEmbed = next;
    if (!next) return;
    runInvalidation(next);
  });
}

function sameModelRef(
  a: KnowledgeModelRef | undefined,
  b: KnowledgeModelRef | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.providerConfigId === b.providerConfigId && a.model === b.model;
}

function projectKnowledgeEvent(
  event: DocumentProgressEvent,
): KnowledgeEvent | null {
  if (!event.kbId) return null;
  const kbId = event.kbId;

  if (event.operation === 'reembed') {
    switch (event.kind) {
      case 'complete':
        return {
          type: 'kb_reembed_completed',
          kbId,
          taskId: event.taskId,
          assetId: event.assetId,
          totalItems: event.totalItems ?? 0,
          completedItems: event.completedItems ?? 0,
          failedItems: event.failedItems ?? 0,
        };
      case 'partial_failed':
        return {
          type: 'kb_reembed_partial_failed',
          kbId,
          taskId: event.taskId,
          assetId: event.assetId,
          error: event.error ?? '部分文档重建失败',
          totalItems: event.totalItems ?? 0,
          completedItems: event.completedItems ?? 0,
          failedItems: event.failedItems ?? 0,
        };
      case 'cancelled':
        return {
          type: 'kb_reembed_cancelled',
          kbId,
          taskId: event.taskId,
          assetId: event.assetId,
        };
      case 'error':
        return {
          type: 'kb_reembed_failed',
          kbId,
          taskId: event.taskId,
          assetId: event.assetId,
          error: event.error ?? 'unknown',
        };
      default:
        return {
          type: 'kb_reembed_progress',
          kbId,
          taskId: event.taskId,
          assetId: event.assetId,
          progress: event.progress ?? 0,
          totalItems: event.totalItems,
          completedItems: event.completedItems,
          failedItems: event.failedItems,
        };
    }
  }

  switch (event.kind) {
    case 'complete':
      return {
        type: 'kb_ingest_completed',
        kbId,
        taskId: event.taskId,
        assetId: event.assetId,
      };
    case 'partial_failed':
      return {
        type: 'kb_ingest_partial_failed',
        kbId,
        taskId: event.taskId,
        assetId: event.assetId,
        error: event.error ?? '部分处理项失败',
        totalItems: event.totalItems ?? 0,
        completedItems: event.completedItems ?? 0,
        failedItems: event.failedItems ?? 0,
      };
    case 'error':
      return {
        type: 'kb_ingest_failed',
        kbId,
        taskId: event.taskId,
        assetId: event.assetId,
        error: event.error ?? 'unknown',
      };
    case 'cancelled':
      // cancelled 只属于 reembed；畸形事件不能进入 ingest 前端状态机。
      return null;
    case 'validate':
    case 'parse':
    case 'chunk':
    case 'embed':
      return {
        type: 'kb_ingest_progress',
        kbId,
        taskId: event.taskId,
        assetId: event.assetId,
        stage: event.kind,
        progress: ingestProgress(event),
        totalItems: event.totalItems,
        completedItems: event.completedItems,
        failedItems: event.failedItems,
      };
  }
}

function ingestProgress(event: DocumentProgressEvent): number {
  switch (event.kind) {
    case 'validate': return 0.05;
    case 'parse': return 0.25;
    case 'chunk': return 0.45;
    case 'embed': return 0.5 + 0.5 * (event.progress ?? 0);
    default: return 0;
  }
}
