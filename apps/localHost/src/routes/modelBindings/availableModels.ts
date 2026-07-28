// 投影各执行面已启用的模型池，供业务模块绑定选择器读取。
import { Hono } from 'hono';
import type { EmbedRuntime } from '@ema-agent/embed';
import type {
  ProviderEmbedModelsRepo,
  ProviderLlmModelsRepo,
  ProviderRerankModelsRepo,
  ProvidersRepo,
  ProviderSttModelsRepo,
  ProviderTtsModelsRepo,
  ProviderVisionModelsRepo,
} from '@ema-agent/storage';

export interface AvailableBindingModelsDependencies {
  providers: Pick<ProvidersRepo, 'get'>;
  llmModels: Pick<ProviderLlmModelsRepo, 'listAll'>;
  embedModels: Pick<ProviderEmbedModelsRepo, 'listAll'>;
  rerankModels: Pick<ProviderRerankModelsRepo, 'listAll'>;
  ttsModels: Pick<ProviderTtsModelsRepo, 'listAll'>;
  sttModels: Pick<ProviderSttModelsRepo, 'listAll'>;
  visionModels: Pick<ProviderVisionModelsRepo, 'listAll'>;
  embed: Pick<EmbedRuntime, 'embeddingSpace'>;
}

export function availableBindingModelsRoute(
  dependencies: AvailableBindingModelsDependencies,
): Hono {
  const app = new Hono();

  app.get('/available/:capability', (c) => {
    const nameCache = new Map<string, string>();
    const resolveName = (providerId: string): string => {
      const cached = nameCache.get(providerId);
      if (cached !== undefined) return cached;
      const name = dependencies.providers.get(providerId)?.display_name ?? providerId;
      nameCache.set(providerId, name);
      return name;
    };

    switch (c.req.param('capability')) {
      case 'llm':
        return c.json({
          models: dependencies.llmModels.listAll().map((row) => ({
            providerConfigId: row.provider_config_id,
            providerName: resolveName(row.provider_config_id),
            model: row.model,
            contextWindow: row.context_window,
          })),
        });
      case 'embed':
        return c.json({
          models: dependencies.embedModels.listAll().map((row) => {
            let embeddingSpace = null;
            try {
              embeddingSpace = dependencies.embed.embeddingSpace(
                row.provider_config_id,
                row.model,
                row.dim,
              );
            } catch {
              // Provider 尚未装载时仍展示已启用模型，但不伪造空间身份。
            }
            return {
              providerConfigId: row.provider_config_id,
              providerName: resolveName(row.provider_config_id),
              model: row.model,
              contextWindow: 0,
              dim: row.dim,
              embeddingSpace,
            };
          }),
        });
      case 'rerank':
        return c.json({
          models: dependencies.rerankModels.listAll().map((row) => ({
            providerConfigId: row.provider_config_id,
            providerName: resolveName(row.provider_config_id),
            model: row.model,
            contextWindow: 0,
            maxChunks: row.max_chunks ?? 0,
          })),
        });
      case 'tts':
        return c.json({
          models: dependencies.ttsModels.listAll().map((row) => ({
            providerConfigId: row.provider_config_id,
            providerName: resolveName(row.provider_config_id),
            model: row.model,
            contextWindow: 0,
          })),
        });
      case 'stt':
        return c.json({
          models: dependencies.sttModels.listAll().map((row) => ({
            providerConfigId: row.provider_config_id,
            providerName: resolveName(row.provider_config_id),
            model: row.model,
            contextWindow: 0,
          })),
        });
      case 'vision':
        return c.json({
          models: dependencies.visionModels.listAll().map((row) => ({
            providerConfigId: row.provider_config_id,
            providerName: resolveName(row.provider_config_id),
            model: row.model,
            contextWindow: 0,
          })),
        });
      default:
        return c.json({ models: [] });
    }
  });

  return app;
}
