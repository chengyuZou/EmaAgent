// 知识库一族：KbManager（注册表/激活/摄入/检索）与其库级模型调用的惰性解析。
// Embed/Rerank 模型是各库注册行上的属性;resolveEmbedFor/RerankFor 按引用解析,
// 未配置或能力被禁用即 undefined（该库检索降级，不阻塞主链路）。
// 模型身份在闭包创建时冻结；usage 在闭包内"调接口得结果 → 从结果记录"，
// knowledge 业务包不感知 providerId/modelId，也不感知用量。
import { createEmbedCall, createEmbeddingSpace } from '@ema-agent/embed';
import {
  KbManager,
  readKnowledgeRetrievalSettings,
  type CallEmbed,
  type KnowledgeSearch,
} from '@ema-agent/knowledge';
import {
  ProviderError,
  type ModelBindings,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';
import { createRerankCall, type CallRerank } from '@ema-agent/rerank';
import type { SettingsStore } from '@ema-agent/settings';
import { KbRegistryRepo, type Database, type KbModelRef } from '@ema-agent/storage';
import { createUsageRecord, reportUsage, type UsageRecorder } from '@ema-agent/usage';
import { createVisionCall, type CallVision } from '@ema-agent/vision';

export interface KnowledgeComposition {
  readonly kb: KbManager;
  /** 模型工具路径的检索入口（KnowledgeSearch）；HTTP 面板直接用 KbManager。 */
  readonly knowledgeSearch: KnowledgeSearch;
}

export function openKnowledge(
  profileDb: Database,
  providers: Providers,
  providerModels: ProviderModels,
  modelBindings: ModelBindings,
  settings: SettingsStore,
  usageRecorder: UsageRecorder,
): KnowledgeComposition {
  const registry = new KbRegistryRepo(profileDb.sqlite);

  const resolveEmbedFor = (ref: KbModelRef): CallEmbed | undefined => {
    try {
      const callEmbed = createEmbedCall(providers.resolveConnection(ref.providerId, 'embed'), ref.modelId);
      return async (request) => {
        const startedAt = Date.now();
        const result = await callEmbed(request);
        reportModelUsage(usageRecorder, 'embed', ref, startedAt, {
          inputTokens: result.usage?.inputTokens ?? null,
        });
        return {
          ...result,
          space: createEmbeddingSpace({
            providerId: ref.providerId,
            model: ref.modelId,
            dim: result.dim,
          }),
        };
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };
  const resolveRerankFor = (ref: KbModelRef): CallRerank | undefined => {
    try {
      const callRerank = createRerankCall(providers.resolveConnection(ref.providerId, 'rerank'), ref.modelId);
      return async (request) => {
        const startedAt = Date.now();
        const result = await callRerank(request);
        reportModelUsage(usageRecorder, 'rerank', ref, startedAt, {
          inputTokens: result.usage?.totalTokens ?? null,
        });
        return result;
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };
  const resolveVision = (): CallVision | undefined => {
    const binding = modelBindings.get('vision');
    if (!binding) return undefined;
    try {
      const vision = createVisionCall(providers.resolveConnection(binding.providerId, 'vision'), binding.modelId);
      return async (request) => {
        const startedAt = Date.now();
        const result = await vision(request);
        reportModelUsage(usageRecorder, 'vision', binding, startedAt, {
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
        });
        return result;
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };

  const kb = new KbManager({
    registry,
    resolveEmbedFor,
    resolveRerankFor,
    resolveVision,
    // 库级 stale 探空:用模型行上的 dim 算空间 id,不发网络请求;行缺失时由 PATCH 校验拦下,这里兜底跳过。
    resolveEmbeddingSpaceId: (ref) => {
      const model = providerModels.get(ref.providerId, 'embed', ref.modelId);
      if (!model || model.capability !== 'embed') return undefined;
      return createEmbeddingSpace({ providerId: ref.providerId, model: ref.modelId, dim: model.dim }).id;
    },
    // 用户设置只在一次真实检索开始时读取；排队或执行中的操作继续使用已取得的值。
    resolveRetrievalSettings: () => readKnowledgeRetrievalSettings(settings),
  });

  return {
    kb,
    knowledgeSearch: request => kb.searchActive(request),
  };
}

/** 一次完成的模型调用记一条 usage；失败调用在闭包内抛错，走不到这里（只记 completed）。 */
function reportModelUsage(
  recorder: UsageRecorder,
  capability: 'embed' | 'rerank' | 'vision',
  ref: KbModelRef,
  startedAt: number,
  tokens: { inputTokens: number | null; outputTokens?: number | null },
): void {
  reportUsage(recorder, createUsageRecord({
    capability,
    providerId: ref.providerId,
    modelId: ref.modelId,
    status: 'completed',
    startedAt,
    durationMs: Date.now() - startedAt,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens ?? null,
  }), error => console.warn(`[usage] KB ${capability} 记账失败:`, error));
}
