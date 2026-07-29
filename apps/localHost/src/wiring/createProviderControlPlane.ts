// 创建 Provider 配置仓库、模型目录和能力解析器，作为模型执行面的控制面输入。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CredentialFacade } from '@ema-agent/credential';
import {
  createModelCapabilityResolver,
  modelsDevIdFor,
  ModelsDevCatalog,
  providerCatalog,
  type ModelCapabilityResolver,
} from '@ema-agent/provider';
import {
  ModelBindingsRepo,
  ProviderEmbedModelsRepo,
  ProviderLlmModelsRepo,
  ProviderRerankModelsRepo,
  ProvidersRepo,
  ProviderSttModelsRepo,
  ProviderTtsModelsRepo,
  ProviderVisionModelsRepo,
  type Database,
} from '@ema-agent/storage';

const MODEL_CATALOG_SNAPSHOT = 'models-dev-snapshot.json';

function snapshotCandidates(moduleDirectory: string): string[] {
  return [
    path.resolve(moduleDirectory, '..', MODEL_CATALOG_SNAPSHOT),
    path.resolve(moduleDirectory, '..', '..', MODEL_CATALOG_SNAPSHOT),
  ];
}

/**
 * 源码运行时快照位于应用根目录，构建后位于 dist 根目录。
 * 每次都先解析到新目录实例，避免空文件或坏文件清掉已经可用的索引。
 */
export function loadBundledModelCatalog(
  moduleDirectory: string = import.meta.dirname,
): ModelsDevCatalog {
  for (const snapshotPath of snapshotCandidates(moduleDirectory)) {
    if (!existsSync(snapshotPath)) continue;

    try {
      const catalog = new ModelsDevCatalog();
      const payload: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      catalog.loadFromJson(payload);
      if (catalog.size === 0) {
        console.warn(`[catalog] bundled snapshot is empty: ${snapshotPath}`);
        continue;
      }

      console.info(`[catalog] loaded bundled snapshot (${catalog.size} models)`);
      return catalog;
    } catch (error) {
      console.warn(`[catalog] bundled snapshot is invalid: ${snapshotPath}`, error);
    }
  }

  console.warn(
    '[catalog] no usable bundled snapshot found; capability lookups rely on network refresh',
  );
  return new ModelsDevCatalog();
}

export function createProviderControlPlane(
  profileDb: Database,
  credentials: CredentialFacade,
) {
  const providers = new ProvidersRepo(profileDb.sqlite, credentials);

  // 明文旧凭据迁移是安全前置条件，失败必须中止后续 Provider 配置读取。
  const migratedCredentials = providers.protectLegacyCredentials();
  if (migratedCredentials > 0) {
    console.info(`[credential] 已加密迁移 ${migratedCredentials} 个旧 Provider 凭据`);
  }

  const providerLlmModels = new ProviderLlmModelsRepo(profileDb.sqlite);
  const providerEmbedModels = new ProviderEmbedModelsRepo(profileDb.sqlite);
  const providerRerankModels = new ProviderRerankModelsRepo(profileDb.sqlite);
  const providerTtsModels = new ProviderTtsModelsRepo(profileDb.sqlite);
  const providerSttModels = new ProviderSttModelsRepo(profileDb.sqlite);
  const providerVisionModels = new ProviderVisionModelsRepo(profileDb.sqlite);
  const modelBindings = new ModelBindingsRepo(profileDb.sqlite);
  const modelCatalog = loadBundledModelCatalog();

  const catalogCapabilities = createModelCapabilityResolver(modelCatalog, {
    supportsManualImageInput: (providerId, model) =>
      providerVisionModels.hasProviderModel(providerId, model),
  });
  const modelCapabilities: ModelCapabilityResolver = {
    resolve(query) {
      const providerRow = providers.get(query.providerId);
      const definition = providerRow
        ? providerCatalog.get(providerRow.definition_id)
        : undefined;
      const modelsDevId = query.modelsDevId
        ?? (definition ? modelsDevIdFor(definition, 'llm') : undefined);
      return catalogCapabilities.resolve({
        ...query,
        ...(modelsDevId ? { modelsDevId } : {}),
      });
    },
  };

  return {
    providers,
    providerLlmModels,
    providerEmbedModels,
    providerRerankModels,
    providerTtsModels,
    providerSttModels,
    providerVisionModels,
    modelBindings,
    modelCatalog,
    modelCapabilities,
  };
}
