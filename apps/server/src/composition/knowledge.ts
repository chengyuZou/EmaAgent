// 知识库一族：KbManager（注册表/激活/摄入/检索）与其绑定模型执行器的惰性解析。
import { createEmbeddingModel } from '@ema-agent/embed';
import {
  KbManager,
  readKnowledgeRetrievalSettings,
  type KnowledgeEmbeddingSelection,
  type KnowledgeRerankSelection,
  type KnowledgeSearch,
  type KnowledgeVisionSelection,
} from '@ema-agent/knowledge';
import {
  ProviderError,
  type ModelBindings,
  type Providers,
} from '@ema-agent/providers';
import { createReranker } from '@ema-agent/rerank';
import type { SettingsStore } from '@ema-agent/settings';
import { KbActivationsRepo, KbRegistryRepo, type Database } from '@ema-agent/storage';
import { createVisionModel } from '@ema-agent/vision';

export interface KnowledgeComposition {
  readonly kb: KbManager;
  /** 模型工具路径的检索入口（KnowledgeSearch）；HTTP 面板直接用 KbManager。 */
  readonly knowledgeSearch: KnowledgeSearch;
}

/**
 * 绑定变更（kb-embed/kb-rerank/vision）在模型绑定路由生效；每次真实操作才解析执行器，
 * 未绑定或能力被禁用即 undefined（KB 检索降级，不阻塞主链路）。
 */
export function openKnowledge(
  profileDb: Database,
  dataDb: Database,
  providers: Providers,
  modelBindings: ModelBindings,
  settings: SettingsStore,
): KnowledgeComposition {
  const resolveEmbedding = (): KnowledgeEmbeddingSelection | undefined => {
    const binding = modelBindings.get('kb-embed');
    if (!binding) return undefined;
    try {
      return {
        providerId: binding.providerId,
        model: binding.modelId,
        embedding: createEmbeddingModel(providers.resolveConnection(binding.providerId, 'embed')),
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };
  const resolveReranker = (): KnowledgeRerankSelection | undefined => {
    const binding = modelBindings.get('kb-rerank');
    if (!binding) return undefined;
    try {
      return {
        model: binding.modelId,
        reranker: createReranker(providers.resolveConnection(binding.providerId, 'rerank')),
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };
  const resolveVision = (): KnowledgeVisionSelection | undefined => {
    const binding = modelBindings.get('vision');
    if (!binding) return undefined;
    try {
      return {
        model: binding.modelId,
        vision: createVisionModel(providers.resolveConnection(binding.providerId, 'vision')),
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };

  const kb = new KbManager({
    registry: new KbRegistryRepo(profileDb.sqlite),
    activations: new KbActivationsRepo(dataDb.sqlite),
    resolveEmbedding,
    resolveReranker,
    resolveVision,
    // 用户设置只在一次真实检索开始时读取；排队或执行中的操作继续使用已取得的值。
    resolveRetrievalSettings: () => readKnowledgeRetrievalSettings(settings),
  });

  return { kb, knowledgeSearch: request => kb.search(request) };
}
