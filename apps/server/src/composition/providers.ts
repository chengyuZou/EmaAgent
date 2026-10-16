// Provider 一族：控制面三类（Providers/ProviderModels/ModelBindings）+ models.dev 目录。
import type { Database } from '@ema-agent/storage';
import {
  ModelBindings,
  ProviderModels,
  Providers,
  loadModelsDevCatalog,
  refreshModelsDevCatalog,
  type ModelsDevCatalog,
  type ProviderModel,
} from '@ema-agent/providers';
import { modelsDevCatalogPath } from '../platform/paths.js';

export interface ProvidersComposition {
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly modelBindings: ModelBindings;
  /** models.dev 本地快照目录（缺失/损坏时为空目录，不阻塞主链路）。 */
  readonly modelCatalog: ModelsDevCatalog;
  /** 并发请求共用完整目录下载, 分别同步各自供应商和能力的 SQL, 提交后通知. */
  refreshModels(providerId: string, capability: 'llm' | 'vision'): Promise<ProviderModel[]>;
}

export function openProviders(profileDb: Database, notifyModelsChanged: (providerId: string) => void): ProvidersComposition {
  const providers = new Providers(profileDb);
  const filePath = modelsDevCatalogPath();
  const modelCatalog = loadModelsDevCatalog(filePath);
  const providerModels = new ProviderModels(profileDb, providers, modelCatalog);
  let downloading: Promise<void> | undefined;

  const refreshModels = async (providerId: string, capability: 'llm' | 'vision'): Promise<ProviderModel[]> => {
    if (!downloading) {
      downloading = refreshModelsDevCatalog(modelCatalog, filePath).finally(() => {
        downloading = undefined;
      });
    }
    await downloading;
    const models = providerModels.syncDevModels(providerId, capability);
    notifyModelsChanged(providerId);
    return models;
  };

  return {
    providers,
    providerModels,
    modelBindings: new ModelBindings(profileDb, providerModels),
    modelCatalog,
    refreshModels,
  };
}
