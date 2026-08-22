// 知识库一族：KbManager（注册表/激活/摄入/检索）与其绑定模型调用的惰性解析。
// 模型身份在闭包创建时冻结；usage 在闭包内"调接口得结果 → 从结果记录"，
// knowledge 业务包不感知 providerId/modelId，也不感知用量。
import { createEmbeddingModel, createEmbeddingSpace } from '@ema-agent/embed';
import {
  KbManager,
  readKnowledgeRetrievalSettings,
  type CallEmbed,
  type CallRerank,
  type CallVision,
  type KnowledgeSearch,
} from '@ema-agent/knowledge';
import {
  ProviderError,
  type ModelBinding,
  type ModelBindings,
  type Providers,
} from '@ema-agent/providers';
import { createReranker } from '@ema-agent/rerank';
import type { SettingsStore } from '@ema-agent/settings';
import { KbActivationsRepo, KbRegistryRepo, type Database } from '@ema-agent/storage';
import { createUsageRecord, reportUsage, type UsageRecorder } from '@ema-agent/usage';
import { createVisionCall } from '@ema-agent/vision';

export interface KnowledgeComposition {
  readonly kb: KbManager;
  /** 模型工具路径的检索入口（KnowledgeSearch）；HTTP 面板直接用 KbManager。 */
  readonly knowledgeSearch: KnowledgeSearch;
}

/**
 * 绑定变更（kb-embed/kb-rerank/vision）在模型绑定路由生效；每次真实操作才解析闭包，
 * 未绑定或能力被禁用即 undefined（KB 检索降级，不阻塞主链路）。
 */
export function openKnowledge(
  profileDb: Database,
  dataDb: Database,
  providers: Providers,
  modelBindings: ModelBindings,
  settings: SettingsStore,
  usageRecorder: UsageRecorder,
): KnowledgeComposition {
  const resolveEmbed = (): CallEmbed | undefined => {
    const binding = modelBindings.get('kb-embed');
    if (!binding) return undefined;
    try {
      const model = createEmbeddingModel(providers.resolveConnection(binding.providerId, 'embed'));
      return async (request) => {
        const startedAt = Date.now();
        const result = await model.embed({ ...request, model: binding.modelId });
        reportModelUsage(usageRecorder, 'embed', binding, startedAt, {
          inputTokens: result.usage?.inputTokens ?? null,
        });
        return {
          ...result,
          space: createEmbeddingSpace({
            providerId: binding.providerId,
            model: binding.modelId,
            dim: result.dim,
          }),
        };
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };
  const resolveRerank = (): CallRerank | undefined => {
    const binding = modelBindings.get('kb-rerank');
    if (!binding) return undefined;
    try {
      const reranker = createReranker(providers.resolveConnection(binding.providerId, 'rerank'));
      return async (request) => {
        const startedAt = Date.now();
        const result = await reranker.rerank({ ...request, model: binding.modelId });
        reportModelUsage(usageRecorder, 'rerank', binding, startedAt, {
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
    registry: new KbRegistryRepo(profileDb.sqlite),
    activations: new KbActivationsRepo(dataDb.sqlite),
    resolveEmbed,
    resolveRerank,
    resolveVision,
    // 用户设置只在一次真实检索开始时读取；排队或执行中的操作继续使用已取得的值。
    resolveRetrievalSettings: () => readKnowledgeRetrievalSettings(settings),
  });

  return { kb, knowledgeSearch: request => kb.search(request) };
}

/** 一次完成的模型调用记一条 usage；失败调用在闭包内抛错，走不到这里（只记 completed）。 */
function reportModelUsage(
  recorder: UsageRecorder,
  capability: 'embed' | 'rerank' | 'vision',
  binding: ModelBinding,
  startedAt: number,
  tokens: { inputTokens: number | null; outputTokens?: number | null },
): void {
  reportUsage(recorder, createUsageRecord({
    capability,
    providerId: binding.providerId,
    modelId: binding.modelId,
    status: 'completed',
    startedAt,
    durationMs: Date.now() - startedAt,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens ?? null,
  }), error => console.warn(`[usage] KB ${capability} 记账失败:`, error));
}
