// Provider 一族：控制面三类（Providers/ProviderModels/ModelBindings）+ models.dev 目录。
import type { Database } from '@ema-agent/storage';
import {
  ModelBindings,
  ProviderModels,
  Providers,
  getModelsDevCatalog,
  refreshModelsDevCatalog,
  type ModelsDevCatalog,
} from '@ema-agent/providers';

export interface ProvidersComposition {
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly modelBindings: ModelBindings;
  /** models.dev 本地快照目录（缺失/损坏时为空目录，不阻塞主链路）。 */
  readonly modelCatalog: ModelsDevCatalog;
  /** 后台刷新 models.dev 快照；网络失败只告警，调用方 fire-and-forget。 */
  refreshCatalog(signal?: AbortSignal): Promise<boolean>;
}

export function openProviders(profileDb: Database): ProvidersComposition {
  const providers = new Providers(profileDb);
  const providerModels = new ProviderModels(profileDb, providers, getModelsDevCatalog());

  return {
    providers,
    providerModels,
    modelBindings: new ModelBindings(profileDb, providerModels),
    modelCatalog: getModelsDevCatalog(),
    refreshCatalog: signal => refreshModelsDevCatalog(signal),
  };
}
