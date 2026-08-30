// Provider 一族：控制面三类（Providers/ProviderModels/ModelBindings）+ models.dev 目录。
import {
  ModelBindingsRepo,
  ProviderModelsRepo,
  ProvidersRepo,
  type Database,
} from '@ema-agent/storage';
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
  /** 后台刷新 models.dev 快照；网络失败由 public-http 防线收口，调用方 fire-and-forget。 */
  refreshCatalog(signal?: AbortSignal): Promise<boolean>;
}

/** 控制面三个类共享同一批 profile 表 repo；Provider 折叠后不存在按能力分 Map 的执行面装配。 */
export function openProviders(profileDb: Database): ProvidersComposition {
  const providersRepo = new ProvidersRepo(profileDb.sqlite);
  const modelsRepo = new ProviderModelsRepo(profileDb.sqlite);
  const bindingsRepo = new ModelBindingsRepo(profileDb.sqlite);

  return {
    providers: new Providers(providersRepo, bindingsRepo),
    providerModels: new ProviderModels(providersRepo, modelsRepo),
    modelBindings: new ModelBindings(modelsRepo, bindingsRepo),
    modelCatalog: getModelsDevCatalog(),
    refreshCatalog: signal => refreshModelsDevCatalog(signal),
  };
}
