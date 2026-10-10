import { createEmbedCall } from '@ema-agent/embed';
import { createLlmCall } from '@ema-agent/llm';
import { NarrativeSearch } from '@ema-agent/narrative';
import { ProviderError, type ModelBindings, type ProviderModels, type Providers } from '@ema-agent/providers';
import type { SettingsStore } from '@ema-agent/settings';
import {
  NarrativeChunksRepo,
  NarrativeGraphRepo,
  NarrativeKeywordCacheRepo,
  type Database,
} from '@ema-agent/storage';
import type { ToolUseContext } from '@ema-agent/tools';
import { narrativeQueryModeSetting } from '../settings/narrativeSetting.js';

// 路由和提词只生成结构化结果. 未配置模型输出上限时仍给 Anthropic 等协议提供必填值.
const DEFAULT_NARRATIVE_MAX_OUTPUT_TOKENS = 4_096;

export interface NarrativeComposition {
  /** 当前绑定和算法设置在 Turn 准备时冻结, 不随查询途中修改的设置变化. */
  resolveSearch(): ToolUseContext['narrativeSearch'];
}

export function openNarrative(
  db: Database,
  providers: Providers,
  providerModels: ProviderModels,
  modelBindings: ModelBindings,
  settings: SettingsStore,
): NarrativeComposition {
  const search = new NarrativeSearch(
    new NarrativeChunksRepo(db.sqlite),
    new NarrativeGraphRepo(db.sqlite),
    new NarrativeKeywordCacheRepo(db.sqlite),
  );
  return {
    resolveSearch() {
      const llm = modelBindings.get('narrative-llm');
      const embed = modelBindings.get('narrative-embed');
      if (!llm || !embed) return undefined;
      try {
        const model = providerModels.get(llm.providerId, 'llm', llm.modelId);
        if (model.capability !== 'llm' || !model.enabled) return undefined;
        const embedModel = providerModels.get(embed.providerId, 'embed', embed.modelId);
        if (!embedModel.enabled) return undefined;
        const llmCall = createLlmCall(providers.resolveConnection(llm.providerId, 'llm'), llm.modelId);
        const embedCall = createEmbedCall(providers.resolveConnection(embed.providerId, 'embed'), embed.modelId);
        const maxOutputTokens = model.maxOutput ?? DEFAULT_NARRATIVE_MAX_OUTPUT_TOKENS;
        const queryMode = settings.get(narrativeQueryModeSetting);
        return (query, mode, signal) => search.search(
          query,
          queryMode === 'auto' ? mode ?? 'hybrid' : queryMode,
          request => llmCall({ ...request, maxOutputTokens }),
          embedCall,
          signal,
        );
      } catch (error) {
        if (error instanceof ProviderError) return undefined;
        throw error;
      }
    },
  };
}
